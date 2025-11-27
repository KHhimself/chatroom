const fs = require('fs');
const path = require('path');
const { db } = require('../src/db');

function ensureMigrationsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function runMigrations() {
  const migrationsDir = path.resolve(__dirname, '..', 'migrations');
  const files = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();

  if (files.length === 0) {
    console.log('No migration files found.');
    db.close();
    return;
  }

  ensureMigrationsTable();
  const appliedRows = db.prepare('SELECT filename FROM schema_migrations ORDER BY filename ASC').all();
  const applied = new Set(appliedRows.map((row) => row.filename));

  const insertMigration = db.prepare(
    'INSERT INTO schema_migrations (filename) VALUES (?)'
  );

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`Skipping already applied migration: ${file}`);
      continue;
    }

    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf8');
    const run = db.transaction(() => {
      db.exec(sql);
      insertMigration.run(file);
    });

    console.log(`Running migration: ${file}`);
    run();
  }

  console.log('Migrations completed successfully.');
  db.close();
}

runMigrations();
