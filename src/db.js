const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const defaultDbPath = path.join(__dirname, '..', 'tmp', 'chatroom.sqlite');
const dbPath = process.env.SQLITE_PATH || defaultDbPath;
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function normalizeSql(sql) {
  return sql.replace(/\$([0-9]+)/g, '?');
}

function isSelectLike(sql) {
  const trimmed = sql.trim().toLowerCase();
  return trimmed.startsWith('select') || trimmed.startsWith('with') || trimmed.startsWith('pragma');
}

async function query(sql, params = []) {
  const normalized = normalizeSql(sql);
  const stmt = db.prepare(normalized);

  if (isSelectLike(sql) || /\breturning\b/i.test(sql)) {
    const rows = stmt.all(params);
    return { rows };
  }

  const result = stmt.run(params);
  return {
    rows: [],
    result
  };
}

async function end() {
  db.close();
}

// 提供與 pg Pool 相容的介面，便於現有程式碼使用
const pool = {
  query,
  connect: async () => ({
    query,
    release: () => {}
  }),
  end
};

module.exports = {
  pool,
  db,
  query
};
