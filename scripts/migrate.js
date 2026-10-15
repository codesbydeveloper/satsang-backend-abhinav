// Applies db/migrations/*.sql in order and records what has run. Safe to run repeatedly.
//   npm run migrate
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../src/config');

async function main() {
  const conn = await mysql.createConnection({ ...config.db, multipleStatements: true, charset: 'utf8mb4' });
  await conn.query('CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(100) PRIMARY KEY, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const done = new Set((await conn.query('SELECT name FROM schema_migrations'))[0].map((r) => r.name));
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) { console.log(`skip   ${file}`); continue; }
    await conn.query(fs.readFileSync(path.join(dir, file), 'utf8'));
    await conn.query('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
    console.log(`applied ${file}`);
  }
  await conn.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
