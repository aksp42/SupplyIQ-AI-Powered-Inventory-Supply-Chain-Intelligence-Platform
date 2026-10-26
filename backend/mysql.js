/**
 * mysql.js — SupplyIQ MySQL connection pool
 * Uses mysql2/promise for async/await throughout.
 */
const mysql = require('mysql2/promise');

let pool;

function getPool() {
  if (!pool) {
    // No default here on purpose. A hardcoded fallback is a committed secret:
    // it ends up in git history, in the Docker image and in every fork, and it
    // silently connects to whatever machine happens to be running. If DB_PASSWORD
    // is missing the process should stop rather than guess a credential.
    const password = process.env.DB_PASSWORD;
    if (!password) {
      throw new Error(
        'DB_PASSWORD is not set. Copy backend/.env.example to backend/.env and fill it in.'
      );
    }
    pool = mysql.createPool({
      host:               process.env.DB_HOST     || 'localhost',
      port:               process.env.DB_PORT     || 3306,
      user:               process.env.DB_USER     || 'root',
      password,
      database:           process.env.DB_NAME     || 'supplyiq',
      waitForConnections: true,
      connectionLimit:    10,
      timezone:           '+00:00',
      charset:            'utf8mb4',
    });
  }
  return pool;
}

/** Run a SELECT — returns array of rows */
async function query(sql, params) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

/** Run INSERT / UPDATE / DELETE — returns OkPacket */
async function run(sql, params) {
  const [result] = await getPool().execute(sql, params);
  return result;
}

/** Convenience: return first row or null */
async function queryOne(sql, params) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

/**
 * Run `fn` inside a transaction, committing on success and rolling back on any
 * throw. `fn` receives a connection-bound executor with the same query/run/queryOne
 * shape, so callers never have to remember to commit or release.
 *
 * This is what keeps multi-table writes atomic — posting a stock movement must
 * not leave the ledger row written and the inventory row not updated.
 */
async function withTransaction(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const executor = {
      conn,
      query:     async (sql, params) => { const [r] = await conn.execute(sql, params); return r; },
      queryOne:  async (sql, params) => { const [r] = await conn.execute(sql, params); return r[0] || null; },
      run:       async (sql, params) => { const [r] = await conn.execute(sql, params); return r; },
    };
    const result = await fn(executor);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch { /* connection already gone */ }
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Release the pool. Needed by scripts and test runners that would otherwise sit
 * with an idle handle open and never exit on their own.
 */
async function closePool() {
  if (!pool) return;
  const closing = pool;
  pool = undefined;
  // Unref the internal idle timer so the event loop can exit
  if (closing._idleTimer) {
    closing._idleTimer.unref();
  }
  await closing.end();
}

module.exports = { getPool, query, run, queryOne, withTransaction, closePool };
