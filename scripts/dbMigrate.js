const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function runMigrations() {
  const migrationsDir = path.resolve(__dirname, '..', 'migrations');
  const files = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();

  if (files.length === 0) {
    console.log('No migration files found.');
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);

    const appliedResult = await client.query(
      'SELECT filename FROM schema_migrations ORDER BY filename ASC'
    );
    const applied = new Set(appliedResult.rows.map((row) => row.filename));

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`Skipping already applied migration: ${file}`);
        continue;
      }

      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf8');

      console.log(`Running migration: ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1)',
          [file]
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        error.message = `Failed to apply migration ${file}: ${error.message}`;
        throw error;
      }
    }
    console.log('Migrations completed successfully.');
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
