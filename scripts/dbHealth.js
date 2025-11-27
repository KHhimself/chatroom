const { query, pool } = require('../src/db');

async function checkHealth() {
  try {
    const result = await query('SELECT 1 AS ok');
    console.log(result.rows[0]);
  } finally {
    await pool.end();
  }
}

checkHealth().catch((error) => {
  console.error('Database health check failed.', error);
  process.exitCode = 1;
});
