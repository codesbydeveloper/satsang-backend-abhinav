const mysql = require('mysql2/promise');
const config = require('./config');

const pool = mysql.createPool({
  ...config.db,
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
  timezone: 'Z',          // all DATETIMEs are stored and read as UTC
  dateStrings: true,      // return DATE/DATETIME as strings, not JS Dates
});

// `timezone: 'Z'` above only covers JS Dates that mysql2 converts. NOW(), CURRENT_TIMESTAMP and the
// `DEFAULT CURRENT_TIMESTAMP` columns (created_at, requested_at, ...) follow the MySQL *session* time zone,
// which is the server's local zone unless set. Pin every pooled connection to UTC so all DATETIMEs are UTC.
// A connection runs its queries in order, so this always runs before that connection's first real query.
pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'", (err) => { if (err) console.error('Could not set the MySQL session time zone to UTC:', err.message); });
});

/** Run a query and return rows (SELECT) or the result header (INSERT/UPDATE/DELETE). */
async function query(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

/** Run fn(conn) inside a transaction; rolls back on any error. */
async function tx(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn({
      query: async (sql, params = []) => (await conn.query(sql, params))[0],
    });
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { pool, query, tx };
