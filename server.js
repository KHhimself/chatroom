require('dotenv').config();

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const session = require('express-session');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { randomUUID, createHash } = require('crypto');
const path = require('path');
const { pool } = require('./src/db');
const { S3Client, PutObjectCommand, GetBucketLocationCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const {
  normalizeEmail,
  findUserByEmail,
  findUserById,
  createLocalUser,
  verifyPassword,
  createEmailVerificationToken,
  consumeEmailVerificationToken,
  findOrCreateGoogleUser
} = require('./src/auth');
const { sendVerificationEmail } = require('./src/mail');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const isProduction = process.env.NODE_ENV === 'production';
const forceCookieSecure =
  process.env.SESSION_COOKIE_SECURE === 'true'
    ? true
    : process.env.SESSION_COOKIE_SECURE === 'false'
      ? false
      : null;

const s3Credentials = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
};
const fallbackS3Region = process.env.AWS_REGION || 'us-east-1';
let cachedS3Client = null;
let resolvedS3Region = fallbackS3Region;

function normalizeBucketRegion(locationConstraint) {
  if (!locationConstraint) {
    return 'us-east-1';
  }
  if (locationConstraint === 'EU') {
    return 'eu-west-1';
  }
  return locationConstraint;
}

async function getS3Client() {
  if (cachedS3Client) {
    return { client: cachedS3Client, region: resolvedS3Region };
  }

  const baseClient = new S3Client({
    region: fallbackS3Region,
    credentials: s3Credentials
  });
  const bucketName = process.env.S3_BUCKET_NAME;
  resolvedS3Region = fallbackS3Region;

  if (bucketName) {
    try {
      const location = await baseClient.send(
        new GetBucketLocationCommand({ Bucket: bucketName })
      );
      const bucketRegion = normalizeBucketRegion(location.LocationConstraint);
      if (bucketRegion && bucketRegion !== fallbackS3Region) {
        console.warn(
          `S3 bucket located in ${bucketRegion}, overriding configured region ${fallbackS3Region}.`
        );
        resolvedS3Region = bucketRegion;
        cachedS3Client = new S3Client({
          region: bucketRegion,
          credentials: s3Credentials
        });
        return { client: cachedS3Client, region: resolvedS3Region };
      }
    } catch (error) {
      console.warn('Unable to determine S3 bucket region, using configured region.', error);
    }
  }

  cachedS3Client = baseClient;
  return { client: cachedS3Client, region: resolvedS3Region };
}

class InMemorySessionStore extends session.Store {
  constructor({ ttl = ONE_DAY_MS } = {}) {
    super();
    this.sessions = new Map();
    this.ttl = ttl;
    this.cleanupInterval = setInterval(() => this.cleanup(), ttl).unref();
  }

  get(sid, callback) {
    try {
      const entry = this.sessions.get(sid);
      if (!entry) {
        return callback(null, null);
      }

      if (Date.now() > entry.expiresAt) {
        this.sessions.delete(sid);
        return callback(null, null);
      }

      return callback(null, entry.session);
    } catch (error) {
      return callback(error);
    }
  }

  set(sid, sessionData, callback = () => {}) {
    const ttl = this.resolveTtl(sessionData);
    this.sessions.set(sid, {
      session: sessionData,
      expiresAt: Date.now() + ttl
    });
    callback();
  }

  touch(sid, sessionData, callback = () => {}) {
    const entry = this.sessions.get(sid);
    if (entry) {
      entry.session = sessionData;
      entry.expiresAt = Date.now() + this.resolveTtl(sessionData);
    }
    callback();
  }

  destroy(sid, callback = () => {}) {
    this.sessions.delete(sid);
    callback();
  }

  cleanup() {
    const now = Date.now();
    for (const [sid, entry] of this.sessions.entries()) {
      if (entry.expiresAt <= now) {
        this.sessions.delete(sid);
      }
    }
  }

  resolveTtl(sessionData) {
    const cookieTtl = sessionData?.cookie?.maxAge;
    return typeof cookieTtl === 'number' ? cookieTtl : this.ttl;
  }
}

const app = express();
if (isProduction) {
  app.set('trust proxy', 1);
}
const server = http.createServer(app);
const io = socketIO(server);

// Session 設定
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret && isProduction) {
  throw new Error('SESSION_SECRET must be provided in production');
}

const sessionMiddleware = session({
  store: new InMemorySessionStore({ ttl: ONE_DAY_MS }),
  secret: sessionSecret || 'dev-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    // 預設 production 走 secure，但可用 SESSION_COOKIE_SECURE 覆寫
    secure: forceCookieSecure !== null ? forceCookieSecure : isProduction,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: ONE_DAY_MS
  }
});

// 使用 session middleware
app.use(sessionMiddleware);
app.use(passport.initialize());

// 提供靜態檔案
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 將 session middleware 綁定到 Socket.io
io.use((socket, next) => {
  sessionMiddleware(socket.request, socket.request.res || {}, next);
});

// 儲存使用者資訊
const users = new Map(); // socketId -> userInfo
const sessionConnections = new Map(); // sessionId -> active connection count
const DEFAULT_GROUP_NAME = 'group';
let defaultGroupContext = null;

function generatePrivateRoomName(userId1, userId2) {
  const sortedIds = [userId1, userId2].sort();
  return `private_${sortedIds[0]}_${sortedIds[1]}`;
}

function parsePrivateRoomName(room) {
  if (typeof room !== 'string') {
    return null;
  }
  const match = room.match(/^private_(.+)_(.+)$/);
  if (!match) {
    return null;
  }
  return [match[1], match[2]];
}

function createDeterministicUuid(value) {
  const hash = createHash('sha1').update(value).digest('hex');
  const base = hash.slice(0, 32);
  const timeHigh = ((parseInt(base.slice(12, 16), 16) & 0x0fff) | 0x4000)
    .toString(16)
    .padStart(4, '0');
  const clockSeq = ((parseInt(base.slice(16, 20), 16) & 0x3fff) | 0x8000)
    .toString(16)
    .padStart(4, '0');
  return `${base.slice(0, 8)}-${base.slice(8, 12)}-${timeHigh}-${clockSeq}-${base.slice(20, 32)}`;
}

async function ensureDefaultGroup() {
  if (defaultGroupContext) {
    return defaultGroupContext;
  }

  try {
    await pool.query('BEGIN');

    const groupResult = await pool.query('SELECT id FROM groups WHERE name = ? LIMIT 1', [
      DEFAULT_GROUP_NAME
    ]);

    let groupId;
    if (groupResult.rows.length > 0) {
      groupId = groupResult.rows[0].id;
    } else {
      groupId = randomUUID();
      await pool.query(
        'INSERT INTO groups (id, name, description) VALUES ($1, $2, $3)',
        [groupId, DEFAULT_GROUP_NAME, 'Default group chat']
      );
    }

    const conversationId = createDeterministicUuid(`group:${groupId}`);
    await pool.query(
      `INSERT INTO conversations (id, type, group_id)
       VALUES ($1, 'group', $2)
       ON CONFLICT (id) DO NOTHING`,
      [conversationId, groupId]
    );

    await pool.query('COMMIT');

    defaultGroupContext = { groupId, conversationId };
    return defaultGroupContext;
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }
}

async function ensureUser(nickname) {
  const userId = randomUUID();
  await pool.query(
    `INSERT INTO users (id, username)
     VALUES ($1, $2)
     ON CONFLICT (username)
     DO NOTHING`,
    [userId, nickname]
  );
  const result = await pool.query(
    `SELECT id FROM users WHERE username = $1 LIMIT 1`,
    [nickname]
  );
  return result.rows[0].id;
}

async function ensureDmConversation(userId1, userId2) {
  const sorted = [userId1, userId2].sort();
  const conversationId = createDeterministicUuid(`dm:${sorted[0]}:${sorted[1]}`);

  await pool.query(
    `INSERT INTO conversations (id, type)
     VALUES ($1, 'dm')
     ON CONFLICT (id) DO NOTHING`,
    [conversationId]
  );

  return conversationId;
}

async function fetchConversationMessages(conversationId, roomName, limit = 100) {
  const result = await pool.query(
    `SELECT m.id,
            m.content,
            m.type,
            m.created_at,
            m.sender_id,
            u.username AS nickname
     FROM messages m
     LEFT JOIN users u ON u.id = m.sender_id
     WHERE m.conversation_id = $1
     ORDER BY m.created_at ASC
     LIMIT $2`,
    [conversationId, limit]
  );

  return result.rows.map((row) => ({
    id: String(row.id),
    nickname: row.nickname || 'Unknown',
    senderSessionId: row.sender_id,
    content: row.content,
    type: row.type,
    timestamp: new Date(row.created_at).toISOString(),
    room: roomName
  }));
}

async function fetchGroupMembers(groupId) {
  const result = await pool.query(
    `SELECT DISTINCT u.id,
            u.username AS nickname,
            u.email
     FROM group_members gm
     JOIN users u ON u.id = gm.user_id
     WHERE gm.group_id = $1`,
    [groupId]
  );

  return result.rows.map((row) => ({
    userId: row.id,
    nickname: row.nickname || row.email || 'Unknown',
    email: row.email || null
  }));
}

// Passport Google OAuth（不使用 passport session，只拿 profile）
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const googleCallbackURL =
  process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/auth/google/callback';

if (googleClientId && googleClientSecret) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: googleClientId,
        clientSecret: googleClientSecret,
        callbackURL: googleCallbackURL
      },
      async (accessToken, refreshToken, profile, done) => {
        try {
          const user = await findOrCreateGoogleUser(profile);
          done(null, {
            id: user.id,
            email: user.email,
            username: user.username
          });
        } catch (error) {
          done(error);
        }
      }
    )
  );
}

// 路由
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/chat', (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

// Legacy nickname login endpoint（保留以避免破壞舊邏輯，新 UI 不再使用）
app.post('/login', async (req, res) => {
  const { nickname } = req.body;
  const sanitizedNickname = nickname?.trim();
  if (!sanitizedNickname) {
    return res.status(400).json({ error: '請輸入暱稱' });
  }

  try {
    const userId = await ensureUser(sanitizedNickname);
    req.session.nickname = sanitizedNickname;
    req.session.userId = userId;

    req.session.save((error) => {
      if (error) {
        console.error('Failed to persist session.', error);
        return res.status(500).json({ error: '伺服器錯誤' });
      }
      res.json({ success: true });
    });
  } catch (error) {
    console.error('Login failed.', error);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// ----- Email + password auth endpoints -----

// 註冊本地帳號並寄出驗證信
const REGISTER_ENDPOINTS = ['/auth/register', '/api/auth/register'];

function buildEmailConflictResponse(res) {
  return res.status(409).json({
    error: 'EMAIL_ALREADY_EXISTS',
    message: '這個 Email 已被註冊，請改用其他 Email'
  });
}

function isDuplicateUserError(error) {
  if (!error) return false;

  // PostgreSQL
  if (error.code === '23505') {
    if (error.constraint) {
      return error.constraint === 'users_email_key' || error.constraint === 'users_username_key';
    }
    const detailText =
      typeof error.detail === 'string'
        ? error.detail.toLowerCase()
        : error.data && typeof error.data.details === 'string'
          ? error.data.details.toLowerCase()
          : null;
    if (detailText) {
      return detailText.includes('(email)') || detailText.includes('(username)');
    }
    return false;
  }

  // SQLite
  if (error.code && error.code.toUpperCase().startsWith('SQLITE_CONSTRAINT')) {
    const message = (error.message || '').toLowerCase();
    return (
      message.includes('users.email') ||
      message.includes('users.username') ||
      message.includes('unique constraint failed')
    );
  }

  return false;
}

async function handleEmailRegister(req, res) {
  const { email, password } = req.body || {};
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail || !password || password.length < 6) {
    return res.status(400).json({
      error: 'INVALID_INPUT',
      message: '請輸入有效的 Email 與至少 6 碼的密碼'
    });
  }

  try {
    const existing = await findUserByEmail(normalizedEmail);
    if (existing) {
      return buildEmailConflictResponse(res);
    }

    const user = await createLocalUser({ email: normalizedEmail, password });
    const token = await createEmailVerificationToken(user.id, { ttlHours: 24 });

    let verificationEmailSent = true;
    try {
      await sendVerificationEmail({ to: normalizedEmail, token });
    } catch (mailError) {
      verificationEmailSent = false;
      console.warn('Verification email send failed:', mailError);
    }

    return res.status(201).json({
      success: true,
      emailVerificationSent: verificationEmailSent,
      message: verificationEmailSent
        ? '註冊成功，請到信箱收取驗證信'
        : '註冊成功，但目前無法寄出驗證信，請稍後再試或使用重新寄送功能'
    });
  } catch (error) {
    if (isDuplicateUserError(error)) {
      console.warn('Register blocked due to duplicate email or username', {
        email: normalizedEmail,
        constraint: error.constraint
      });
      return buildEmailConflictResponse(res);
    }

    console.error('Register failed.', error);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: '伺服器錯誤，請稍後再試'
    });
  }
}

REGISTER_ENDPOINTS.forEach((path) => {
  app.post(path, handleEmailRegister);
});

// Email 驗證連結
app.get('/auth/verify-email', async (req, res) => {
  const token = req.query.token;
  if (!token) {
    return res.status(400).send('缺少驗證 token。');
  }

  try {
    const result = await consumeEmailVerificationToken(token);
    if (!result.ok) {
      const reason = result.reason || 'UNKNOWN';
      return res
        .status(400)
        .send(`驗證連結無效或已過期（原因：${reason}）。請重新請求驗證信。`);
    }

    const user = result.user;
    req.session.userId = user.id;
    req.session.nickname = user.username || user.email;

    req.session.save((error) => {
      if (error) {
        console.error('Failed to persist session after email verify.', error);
        return res.status(500).send('伺服器錯誤，請稍後再試。');
      }
      return res.redirect('/chat');
    });
  } catch (error) {
    console.error('Email verification failed.', error);
    return res.status(500).send('伺服器錯誤，請稍後再試。');
  }
});

// Email + 密碼登入
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail || !password) {
    return res.status(400).json({
      errorCode: 'INVALID_INPUT',
      message: '請輸入 Email 與密碼'
    });
  }

  try {
    const user = await findUserByEmail(normalizedEmail);
    const passwordOk = await verifyPassword(user, password);

    if (!user || !passwordOk) {
      return res.status(401).json({
        errorCode: 'INVALID_CREDENTIALS',
        message: 'Email 或密碼錯誤'
      });
    }

    if (!user.email_verified) {
      return res.status(403).json({
        errorCode: 'EMAIL_NOT_VERIFIED',
        message: 'Email 尚未驗證，請先至信箱點擊驗證連結'
      });
    }

    req.session.userId = user.id;
    req.session.nickname = user.username || user.email;

    req.session.save((error) => {
      if (error) {
        console.error('Failed to persist session on login.', error);
        return res.status(500).json({
          errorCode: 'SERVER_ERROR',
          message: '伺服器錯誤，請稍後再試'
        });
      }

      return res.json({ success: true });
    });
  } catch (error) {
    console.error('Auth login failed.', error);
    return res.status(500).json({
      errorCode: 'SERVER_ERROR',
      message: '伺服器錯誤，請稍後再試'
    });
  }
});

const RESEND_RATE_LIMIT_WINDOW_MINUTES = 5;
const RESEND_RATE_LIMIT_MAX = 3;
const GENERIC_RESEND_SUCCESS_MESSAGE = '如果此 Email 有註冊，我們已重新寄出驗證信，請稍候並檢查信箱。';

function isValidEmailFormat(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 重新寄送驗證信
app.post('/auth/resend-verification', async (req, res) => {
  const { email } = req.body || {};
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail || !isValidEmailFormat(normalizedEmail)) {
    return res.status(400).json({
      error: 'INVALID_EMAIL',
      message: '請提供有效的 Email'
    });
  }

  try {
    const user = await findUserByEmail(normalizedEmail);
    if (!user) {
      await delay(400);
      return res.json({
        success: true,
        message: GENERIC_RESEND_SUCCESS_MESSAGE
      });
    }

    if (user.email_verified) {
      return res.json({
        success: true,
        alreadyVerified: true,
        message: '此 Email 已完成驗證，請直接登入。'
      });
    }

    const recentAttemptsResult = await pool.query(
      `SELECT COUNT(*) AS attempts
       FROM email_verification_tokens
       WHERE user_id = $1
         AND created_at > datetime('now', '-${RESEND_RATE_LIMIT_WINDOW_MINUTES} minutes')`,
      [user.id]
    );
    const recentAttempts = Number.parseInt(recentAttemptsResult.rows[0]?.attempts || '0', 10);
    if (recentAttempts >= RESEND_RATE_LIMIT_MAX) {
      return res.status(429).json({
        success: false,
        error: 'TOO_MANY_REQUESTS',
        message: '請稍後再重新請求驗證信'
      });
    }

    await pool.query(
      `UPDATE email_verification_tokens
       SET used_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND used_at IS NULL`,
      [user.id]
    );

    const token = await createEmailVerificationToken(user.id, { ttlHours: 24 });
    await sendVerificationEmail({ to: normalizedEmail, token });

    return res.json({
      success: true,
      message: GENERIC_RESEND_SUCCESS_MESSAGE
    });
  } catch (error) {
    console.error('Resend verification failed.', error);
    return res.status(500).json({
      errorCode: 'SERVER_ERROR',
      message: '伺服器錯誤，請稍後再試'
    });
  }
});

// 忘記密碼（目前僅回傳尚未實作）
app.post('/auth/forgot-password', (req, res) => {
  return res.status(501).json({
    errorCode: 'NOT_IMPLEMENTED',
    message: '重設密碼功能尚未實作'
  });
});

// Google OAuth 登入
app.get(
  '/auth/google',
  (req, res, next) => {
    if (!passport._strategy('google')) {
      return res.status(503).send('Google 登入尚未在伺服器上設定。');
    }
    next();
  },
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    prompt: 'select_account'
  })
);

app.get(
  '/auth/google/callback',
  passport.authenticate('google', {
    session: false,
    failureRedirect: '/'
  }),
  (req, res) => {
    const googleUser = req.user;
    if (!googleUser) {
      return res.redirect('/');
    }

    req.session.userId = googleUser.id;
    req.session.nickname = googleUser.username || googleUser.email || 'Google User';

    req.session.save((error) => {
      if (error) {
        console.error('Failed to persist session after Google login.', error);
        return res.redirect('/');
      }
      return res.redirect('/chat');
    });
  }
);

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// API端點：獲取當前用戶資訊
app.get('/api/user', async (req, res) => {
  if (!req.session.nickname || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  let email = null;
  try {
    const result = await pool.query('SELECT email FROM users WHERE id = $1 LIMIT 1', [
      req.session.userId
    ]);
    email = result.rows[0]?.email || null;
  } catch (error) {
    console.warn('Failed to load user email for /api/user', error);
  }

  res.json({
    nickname: req.session.nickname,
    userId: req.session.userId,
    email
  });
});

// 更新暱稱
app.post('/api/user/nickname', async (req, res) => {
  if (!req.session.nickname || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const rawName = (req.body?.nickname || '').trim();
  if (!rawName) {
    return res.status(400).json({ error: 'INVALID_NICKNAME', message: '請輸入暱稱' });
  }
  if (rawName.length > 50) {
    return res.status(400).json({ error: 'INVALID_NICKNAME', message: '暱稱長度需在 1-50 字內' });
  }

  try {
    await pool.query(
      `UPDATE users
       SET username = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [rawName, req.session.userId]
    );

    const result = await pool.query(
      `SELECT id, username FROM users WHERE id = $1 LIMIT 1`,
      [req.session.userId]
    );

    if (!result.rows || result.rows.length === 0) {
      return res.status(404).json({ error: 'USER_NOT_FOUND' });
    }

    // 更新 session
    req.session.nickname = rawName;
    if (typeof req.session.save === 'function') {
      req.session.save(() => {});
    }

    // 更新目前連線中的使用者暱稱
    for (const [, user] of users.entries()) {
      if (user.sessionId === req.session.userId) {
        user.nickname = rawName;
      }
    }

    // 廣播暱稱變更
    io.emit('nicknameUpdated', {
      sessionId: req.session.userId,
      nickname: rawName
    });

    res.json({ success: true, nickname: rawName, userId: req.session.userId });
  } catch (error) {
    if (isDuplicateUserError(error)) {
      return res
        .status(409)
        .json({ error: 'DUPLICATE_NICKNAME', message: '暱稱已被使用，請改用其他暱稱' });
    }
    console.error('Failed to update nickname.', error);
    res.status(500).json({ error: 'SERVER_ERROR', message: '更新暱稱失敗，請稍後再試' });
  }
});

app.get('/api/s3-upload-url', async (req, res) => {
  const fileType = req.query.fileType;
  const fileName = req.query.fileName;

  if (!fileType || !fileName) {
    return res.status(400).json({ error: 'MISSING_PARAMS' });
  }

  const bucketName = process.env.S3_BUCKET_NAME;
  if (!bucketName) {
    return res.status(500).json({ error: 'S3 bucket is not configured' });
  }

  try {
    const { client: s3Client, region } = await getS3Client();
    const uniqueFileName = `uploads/${Date.now()}_${fileName}`;

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: uniqueFileName,
      ContentType: fileType
    });

    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 60 });
    const publicUrl = `https://${bucketName}.s3.${region}.amazonaws.com/${uniqueFileName}`;

    res.json({ uploadUrl, publicUrl });
  } catch (error) {
    console.error('S3 Presign Error:', error);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

app.get('/health/db', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (error) {
    console.error('Database health check failed.', error);
    res.status(503).json({ ok: false });
  }
});

// Socket.io 事件處理
io.on('connection', async (socket) => {
  console.log('New connection:', socket.id);
  
  const sessionData = socket.request.session;
  if (!sessionData?.nickname) {
    socket.disconnect();
    return;
  }

  let groupContext = null;
  try {
    if (!sessionData.userId) {
      const ensuredUserId = await ensureUser(sessionData.nickname);
      sessionData.userId = ensuredUserId;
      if (typeof sessionData.save === 'function') {
        sessionData.save(() => {});
      }
    }
    groupContext = await ensureDefaultGroup();

    // 確保群聊成員表有一筆唯一的紀錄，避免後續查詢時重複出現
    try {
      await pool.query(
        `INSERT INTO group_members (group_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT (group_id, user_id) DO NOTHING`,
        [groupContext.groupId, sessionData.userId]
      );
    } catch (error) {
      console.warn('Failed to upsert group membership', {
        userId: sessionData.userId,
        groupId: groupContext?.groupId
      });
    }
  } catch (error) {
    console.error('Failed to initialize connection.', error);
    socket.disconnect();
    return;
  }
  // 記錄該 session 的連線數，避免同帳號多開時重複廣播加入事件
  const previousConnections = sessionConnections.get(sessionData.userId) || 0;
  const isFirstConnectionForSession = previousConnections === 0;
  sessionConnections.set(sessionData.userId, previousConnections + 1);
  
  // 使用者連線
  const userInfo = {
    id: socket.id,
    sessionId: sessionData.userId,
    nickname: sessionData.nickname,
    room: 'group', // 預設在群聊
    typing: false
  };
  
  users.set(socket.id, userInfo);
  
  // 加入群聊
  socket.join('group');
  
  // 廣播使用者加入
  if (isFirstConnectionForSession) {
    socket.to('group').emit('userJoined', {
      nickname: userInfo.nickname,
      timestamp: new Date().toISOString()
    });
  }
  
  // 發送線上使用者列表
  updateOnlineUsers();
  
  // 處理訊息
  socket.on('sendMessage', async (data) => {
    const user = users.get(socket.id);
    if (!user) return;

    const messageType = data.type || 'text';
    if (messageType === 'image' && isImageTooLarge(data.content)) {
      socket.emit('messageRejected', {
        reason: 'IMAGE_TOO_LARGE'
      });
      return;
    }

    try {
      let roomName = 'group';
      let conversationId = defaultGroupContext?.conversationId;
      let targetSocketId = null;
      let targetUser = null;

      if (!conversationId) {
        const context = await ensureDefaultGroup();
        conversationId = context.conversationId;
      }

      if (data.room !== 'group') {
        targetSocketId = data.room;
        targetUser = users.get(targetSocketId);
        if (!targetUser) {
          socket.emit('messageRejected', { reason: 'TARGET_OFFLINE' });
          return;
        }
        conversationId = await ensureDmConversation(user.sessionId, targetUser.sessionId);
        roomName = generatePrivateRoomName(user.sessionId, targetUser.sessionId);
      }

      const createdAt = new Date().toISOString();
      const insertResult = await pool.query(
        `INSERT INTO messages (conversation_id, sender_id, content, type, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [conversationId, user.sessionId, data.content, messageType, createdAt]
      );

      const savedMessage = {
        id: String(insertResult.result?.lastInsertRowid || Date.now()),
        nickname: user.nickname,
        senderSessionId: user.sessionId,
        content: data.content,
        type: messageType,
        timestamp: createdAt,
        room: roomName
      };

      if (data.room === 'group') {
        io.to('group').emit('newMessage', savedMessage);
      } else {
        socket.emit('newMessage', savedMessage);
        socket.to(targetSocketId).emit('newMessage', savedMessage);
      }
    } catch (error) {
      console.error('Failed to handle message.', error);
      socket.emit('messageRejected', { reason: 'SERVER_ERROR' });
    }
  });
  
  // 處理輸入狀態
  socket.on('typing', (data) => {
    const user = users.get(socket.id);
    if (!user) return;
    
    user.typing = data.isTyping;
    
    if (data.room === 'group') {
      socket.to('group').emit('userTyping', {
        nickname: user.nickname,
        isTyping: data.isTyping,
        userId: socket.id
      });
    } else {
      // 私聊：直接發送給目標用戶
      socket.to(data.room).emit('userTyping', {
        nickname: user.nickname,
        isTyping: data.isTyping,
        userId: socket.id
      });
    }
  });
  
  // 切換房間
  socket.on('switchRoom', (data) => {
    const user = users.get(socket.id);
    if (!user) return;
    
    // 離開舊房間
    if (user.room && user.room !== 'group') {
      socket.leave(user.room);
    }
    
    // 加入新房間
    user.room = data.room;
    if (data.room !== 'group') {
      socket.join(data.room);
    }
  });
  
  // 獲取聊天歷史
  socket.on('getChatHistory', async (data) => {
    const user = users.get(socket.id);
    if (!user) return;

    const requestedRoom = data.room;
    try {
      if (requestedRoom === 'group') {
        const context = groupContext || (await ensureDefaultGroup());
        const [messages, members] = await Promise.all([
          fetchConversationMessages(context.conversationId, 'group'),
          fetchGroupMembers(context.groupId)
        ]);
        socket.emit('chatHistory', {
          room: 'group',
          messages,
          members
        });
        return;
      }

      const participants = parsePrivateRoomName(requestedRoom);
      if (!participants || !participants.includes(user.sessionId)) {
        socket.emit('chatHistory', {
          room: requestedRoom,
          messages: []
        });
        return;
      }

      const conversationId = await ensureDmConversation(participants[0], participants[1]);
      const messages = await fetchConversationMessages(conversationId, requestedRoom);
      socket.emit('chatHistory', {
        room: requestedRoom,
        messages
      });
    } catch (error) {
      console.error('Failed to fetch chat history.', error);
      socket.emit('chatHistory', {
        room: requestedRoom,
        messages: []
      });
    }
  });
  
  // 斷線處理
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (!user) return;
    const sessionId = user.sessionId;
    
    users.delete(socket.id);
    const currentConnections = sessionConnections.get(sessionId) || 0;
    const nextConnections = Math.max(currentConnections - 1, 0);
    if (nextConnections === 0) {
      sessionConnections.delete(sessionId);
      // 廣播使用者離開（僅最後一個連線離線時）
      socket.to('group').emit('userLeft', {
        nickname: user.nickname,
        timestamp: new Date().toISOString()
      });
    } else {
      sessionConnections.set(sessionId, nextConnections);
    }
    
    updateOnlineUsers();
  });
  
  // 更新線上使用者列表
  function updateOnlineUsers() {
    // 以 sessionId 去重，避免同一帳號多連線導致名單重複
    const dedupedBySession = new Map();
    for (const user of users.values()) {
      if (!dedupedBySession.has(user.sessionId)) {
        dedupedBySession.set(user.sessionId, {
          id: user.id,
          nickname: user.nickname,
          sessionId: user.sessionId
        });
      }
    }
    const onlineUsers = Array.from(dedupedBySession.values());
    
    io.emit('onlineUsers', {
      users: onlineUsers,
      count: onlineUsers.length
    });
  }
});

function isImageTooLarge(dataUrl) {
  const MAX_IMAGE_SIZE_BYTES = 500 * 1024; // 500KB
  if (typeof dataUrl !== 'string') {
    return true;
  }

  if (!dataUrl.startsWith('data:')) {
    return false;
  }

  const [, base64Payload] = dataUrl.split(',');
  if (!base64Payload) {
    return true;
  }

  try {
    const bufferSize = Buffer.from(base64Payload, 'base64').length;
    return bufferSize > MAX_IMAGE_SIZE_BYTES;
  } catch (error) {
    return true;
  }
}

// 啟動伺服器
const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await ensureDefaultGroup();
  } catch (error) {
    console.error('Failed to complete startup checks.', error);
    process.exit(1);
  }

  server.listen(PORT, () => {
    console.log(`伺服器運行在 http://localhost:${PORT}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  server,
  io,
  handleEmailRegister
};
