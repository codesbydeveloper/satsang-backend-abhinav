// GET / status check: says the API is up and whether the database answers, without exposing config.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { api } = h;
const config = require('../src/config');
const db = require('../src/db');

after(() => h.pool.end());

test('GET / reports the API running and the database connected', async () => {
  const r = await api().get('/');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { success: true, message: 'Satsang Spark API is running', status: 'ok', database: 'connected' });
});

test('GET / reports database "error" when the query fails, without leaking details', async () => {
  const original = db.pool.query;
  db.pool.query = async () => { throw new Error(`connect ECONNREFUSED ${config.db.host}`); };
  try {
    const r = await api().get('/');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { success: true, message: 'Satsang Spark API is running', status: 'ok', database: 'error' });
  } finally {
    db.pool.query = original;
  }
});

test('GET / never includes config values', async () => {
  const text = JSON.stringify((await api().get('/')).body);
  for (const v of [config.env, config.db.database, config.db.user, config.db.host, String(config.port)]) {
    if (v) assert.ok(!text.includes(v), `response leaks ${v}`);
  }
});
