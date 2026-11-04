const config = require('./config');
const { createApp } = require('./app');
const { pool } = require('./db');
const { refreshAllAgeGroups } = require('./utils/profiles');

const app = createApp();
const server = app.listen(config.port, async () => {
  const base = `http://localhost:${config.port}`;
  console.log('----------------------------------------------');
  console.log(`✅ Satsang Spark API server is running (${config.env})`);
  console.log(`   API:      ${base}`);
  console.log(`   Docs:     ${base}/api-docs`);
  try {
    await pool.query('SELECT 1');
    console.log(`   Database: connected (${config.db.database})`);
  } catch (e) {
    console.error(`   Database: NOT connected — ${e.message}`);
  }
  console.log('----------------------------------------------');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`❌ Port ${config.port} is already in use. Stop the other process or change PORT in .env.`);
  else console.error('❌ Server failed to start:', err);
  process.exit(1);
});

// Keep stored age groups current as birthdays pass (also refreshed lazily on login/profile loads).
setInterval(() => refreshAllAgeGroups().catch((e) => console.error('age-group refresh failed', e)), 6 * 60 * 60 * 1000).unref();
