const { randomUUID } = require('crypto');
const bcrypt = require('bcrypt');
const { pool } = require('./db');

const BCRYPT_ROUNDS = Number.parseInt(process.env.BCRYPT_ROUNDS || '10', 10);

// Normalize email to a consistent lowercase format
function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

async function findUserByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;

  const result = await pool.query(
    'SELECT * FROM users WHERE email = $1 LIMIT 1',
    [normalized]
  );
  return result.rows[0] || null;
}

async function findUserById(id) {
  const result = await pool.query(
    'SELECT * FROM users WHERE id = $1 LIMIT 1',
    [id]
  );
  return result.rows[0] || null;
}

async function createLocalUser({ email, password }) {
  const normalized = normalizeEmail(email);
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const id = randomUUID();

  // For now, keep username equal to email so chat display names stay unique
  const username = normalized;

  const result = await pool.query(
    `INSERT INTO users (id, email, username, password_hash, provider, email_verified)
     VALUES ($1, $2, $3, $4, 'local', false)
     RETURNING *`,
    [id, normalized, username, passwordHash]
  );

  return result.rows[0];
}

async function verifyPassword(user, password) {
  if (!user || !user.password_hash) return false;
  return bcrypt.compare(password, user.password_hash);
}

async function createEmailVerificationToken(userId, { ttlHours = 24 } = {}) {
  const token = randomUUID();
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

  await pool.query(
    `INSERT INTO email_verification_tokens (id, user_id, token, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [id, userId, token, expiresAt]
  );

  return token;
}

// Try to consume a verification token and mark the related user as verified.
// Returns { ok: true, user } or { ok: false, reason }.
async function consumeEmailVerificationToken(token) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const tokenResult = await client.query(
      `SELECT *
       FROM email_verification_tokens
       WHERE token = $1
       LIMIT 1`,
      [token]
    );

    if (tokenResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'TOKEN_NOT_FOUND' };
    }

    const row = tokenResult.rows[0];
    const now = new Date();
    if (row.used_at) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'TOKEN_ALREADY_USED' };
    }

    if (row.expires_at && now > row.expires_at) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'TOKEN_EXPIRED' };
    }

    await client.query(
      `UPDATE email_verification_tokens
       SET used_at = NOW()
       WHERE id = $1`,
      [row.id]
    );

    const userResult = await client.query(
      `UPDATE users
       SET email_verified = true, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [row.user_id]
    );

    await client.query('COMMIT');

    if (userResult.rowCount === 0) {
      return { ok: false, reason: 'USER_NOT_FOUND' };
    }

    return { ok: true, user: userResult.rows[0] };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Find or create a user corresponding to a Google account.
// profile is the Google OAuth profile object.
async function findOrCreateGoogleUser(profile) {
  const googleSub = profile.id;
  const primaryEmail =
    Array.isArray(profile.emails) && profile.emails[0]
      ? normalizeEmail(profile.emails[0].value)
      : null;
  const displayName = profile.displayName || primaryEmail || 'Google User';

  if (!googleSub) {
    throw new Error('Missing google_sub from profile');
  }

  // 1) If user already linked by google_sub, return it
  const byGoogle = await pool.query(
    'SELECT * FROM users WHERE google_sub = $1 LIMIT 1',
    [googleSub]
  );
  if (byGoogle.rowCount > 0) {
    return byGoogle.rows[0];
  }

  // 2) If we have an email, try linking to an existing local account
  if (primaryEmail) {
    const byEmail = await pool.query(
      'SELECT * FROM users WHERE email = $1 LIMIT 1',
      [primaryEmail]
    );
    if (byEmail.rowCount > 0) {
      const existing = byEmail.rows[0];
      const updatedResult = await pool.query(
        `UPDATE users
         SET google_sub = $1,
             email_verified = true,
             updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [googleSub, existing.id]
      );
      return updatedResult.rows[0];
    }
  }

  // 3) Create a new Google-based user
  const id = randomUUID();
  const username = primaryEmail || displayName;

  const insertResult = await pool.query(
    `INSERT INTO users (id, email, username, provider, google_sub, email_verified)
     VALUES ($1, $2, $3, 'google', $4, true)
     RETURNING *`,
    [id, primaryEmail, username, googleSub]
  );

  return insertResult.rows[0];
}

module.exports = {
  normalizeEmail,
  findUserByEmail,
  findUserById,
  createLocalUser,
  verifyPassword,
  createEmailVerificationToken,
  consumeEmailVerificationToken,
  findOrCreateGoogleUser
};

