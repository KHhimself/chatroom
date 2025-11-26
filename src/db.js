const { Pool } = require('pg');

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

function buildPoolConfig() {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString) {
    return { connectionString };
  }

  const config = {};
  if (process.env.PGHOST) {
    config.host = process.env.PGHOST;
  }
  if (process.env.PGPORT) {
    const parsedPort = Number(process.env.PGPORT);
    if (!Number.isNaN(parsedPort)) {
      config.port = parsedPort;
    }
  }
  if (process.env.PGUSER) {
    config.user = process.env.PGUSER;
  }
  if (process.env.PGPASSWORD) {
    config.password = process.env.PGPASSWORD;
  }
  if (process.env.PGDATABASE) {
    config.database = process.env.PGDATABASE;
  }

  return config;
}

const pool = new Pool(buildPoolConfig());

pool.on('error', (error) => {
  console.error('Unexpected database error', error);
});

module.exports = { pool };
