#!/usr/bin/env node
/**
 * migrate.js — ordered SQL migration runner for SupplyIQ.
 *
 *   node backend/scripts/migrate.js status
 *   node backend/scripts/migrate.js up          apply every pending migration
 *   node backend/scripts/migrate.js up 002      apply up to and including 002
 *   node backend/scripts/migrate.js down 1      roll back the last 1 migration
 *   node backend/scripts/migrate.js fresh       DROP the database and rebuild
 *
 * Why a runner instead of `mysql < schema.sql`: applied versions are recorded
 * in schema_migrations with a checksum, so a file edited after it ran is
 * detected instead of silently diverging, and every step has a rollback path.
 *
 * "fresh" is destructive and asks for typed confirmation.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const mysql = require('mysql2/promise');

const DB_NAME  = process.env.DB_NAME || 'supplyiq';
const MIGR_DIR = path.join(__dirname, '..', 'migrations');
const DOWN_DIR = path.join(MIGR_DIR, 'rollback');

// A rollback that drops structure while rows still live throws data away
// silently. `down` refuses to run if any of these still holds data, so the
// operator has to back up or use `fresh` first — deliberately.
const BUSINESS_TABLES = [
  'inventory', 'sales', 'sales_orders', 'purchase_orders', 'suppliers',
  'products', 'customers', 'users',
];

function fail(msg) { console.error(`\x1b[31m✖ ${msg}\x1b[0m`); process.exit(1); }

async function connect(withDatabase) {
  try {
    return await mysql.createConnection({
      host:     process.env.DB_HOST || 'localhost',
      port:     Number(process.env.DB_PORT || 3306),
      user:     process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD,
      database: withDatabase ? DB_NAME : undefined,
      multipleStatements: true,
      charset: 'utf8mb4',
      timezone: 'Z',
    });
  } catch (err) {
    fail(`Cannot connect to MySQL as ${process.env.DB_USER || 'root'}: ${err.message}`);
  }
}

function checksum(sql) {
  // Ignore comment-only and whitespace-only differences so reformatting a file
  // does not read as "the migration was tampered with".
  const normalised = sql
    .split('\n')
    .map(l => l.replace(/--.*$/, '').trimEnd())
    .filter(l => l.trim() !== '')
    .join('\n');
  return crypto.createHash('sha256').update(normalised, 'utf8').digest('hex');
}

function discover() {
  if (!fs.existsSync(MIGR_DIR)) fail(`No migrations directory at ${MIGR_DIR}`);
  return fs.readdirSync(MIGR_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(file => {
      const version = file.split('_')[0];
      const downFile = path.join(DOWN_DIR, `${version}_down.sql`);
      return {
        version, file,
        sql:   fs.readFileSync(path.join(MIGR_DIR, file), 'utf8'),
        down:  fs.existsSync(downFile) ? fs.readFileSync(downFile, 'utf8') : null,
        downFile: fs.existsSync(downFile) ? path.basename(downFile) : null,
      };
    });
}

async function ensureBookkeeping(conn) {
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`
    CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  await conn.query(`USE \`${DB_NAME}\``);
  await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version     VARCHAR(64) NOT NULL PRIMARY KEY,
    checksum    CHAR(64)    NOT NULL,
    applied_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    duration_ms INT         NOT NULL DEFAULT 0
  ) ENGINE=InnoDB`);
}

async function appliedVersions(conn) {
  const [rows] = await conn.query('SELECT version, checksum FROM schema_migrations ORDER BY version');
  return new Map(rows.map(r => [r.version, r.checksum]));
}

/**
 * Split a migration file into statements, so one bad statement does not leave a
 * half-applied migration recorded as successful.
 *
 * Comments are stripped while splitting, which matters: a CREATE TABLE that is
 * introduced by a `--` comment would otherwise look like a comment-only fragment
 * and get thrown away with it.
 */
function stripEdgeComments(stmt) {
  return stmt
    .split('\n')
    .filter(line => {
      const t = line.trim();
      return t !== '' && !t.startsWith('--') && !t.startsWith('#');
    })
    .join('\n')
    .trim();
}

function splitStatements(sql) {
  const out = [];
  let buf = '', inSingle = false, inDouble = false, inBacktick = false, inLineComment = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i], n = sql[i + 1];
    if (inLineComment) { if (c === '\n') inLineComment = false; buf += c; continue; }
    if (!inSingle && !inDouble && !inBacktick && c === '-' && n === '-') {
      inLineComment = true; buf += c; continue;
    }
    if (c === "'" && !inDouble && !inBacktick) inSingle = !inSingle;
    else if (c === '"' && !inSingle && !inBacktick) inDouble = !inDouble;
    else if (c === '`' && !inSingle && !inDouble) inBacktick = !inBacktick;
    if (c === ';' && !inSingle && !inDouble && !inBacktick) { out.push(buf); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) out.push(buf);

  return out
    .map(stripEdgeComments)
    .filter(s => s.length > 0);
}

async function applyMigration(conn, m) {
  const statements = splitStatements(m.sql);
  const started = Date.now();
  for (let i = 0; i < statements.length; i++) {
    try {
      await conn.query(statements[i]);
    } catch (err) {
      const firstLine = statements[i].split('\n').find(l => l.trim()) || '';
      err.message = `migration ${m.version} (${m.file}) failed on statement ${i + 1}/${statements.length}:\n` +
                    `${firstLine.slice(0, 120)}\n  → ${err.message}`;
      throw err;
    }
  }
  const ms = Date.now() - started;
  await conn.query(
    'INSERT INTO schema_migrations (version, checksum, duration_ms) VALUES (?,?,?) ' +
    'ON DUPLICATE KEY UPDATE checksum = VALUES(checksum), duration_ms = VALUES(duration_ms)',
    [m.version, checksum(m.sql), ms]
  );
  console.log(`\x1b[32m✔\x1b[0m ${m.file}  (${statements.length} statements, ${ms} ms)`);
}

async function revertMigration(conn, m) {
  if (!m.down) fail(`No rollback file for ${m.file} (expected migrations/rollback/${m.version}_down.sql)`);
  console.log(`\x1b[33m↩\x1b[0m rolling back ${m.file}`);
  await conn.query(m.down);
  await conn.query('DELETE FROM schema_migrations WHERE version = ?', [m.version]);
}

async function cmdUp(limitVersion) {
  const migrations = discover();
  const boot = await connect(false);
  await ensureBookkeeping(boot);
  const applied = await appliedVersions(boot);

  // A changed checksum means the file was edited after it ran. Applying it again
  // is refused rather than guessed at — write a new migration instead.
  for (const m of migrations) {
    if (applied.has(m.version) && applied.get(m.version) !== checksum(m.sql))
      fail(`${m.file} was already applied but its contents changed.\n` +
           `  Add a new migration instead of editing an applied one.`);
  }

  const pending = migrations.filter(m => !applied.has(m.version))
    .filter(m => !limitVersion || m.version <= limitVersion);

  if (!pending.length) { console.log('Nothing to apply — database is up to date.'); await boot.end(); return; }

  for (const m of pending) {
    await boot.query(`USE \`${DB_NAME}\``);
    try {
      await applyMigration(boot, m);
    } catch (err) { await boot.end(); fail(err.message); }
  }
  await boot.end();
  console.log(`\n\x1b[1mApplied ${pending.length} migration(s).\x1b[0m`);
}

async function cmdDown(count) {
  const migrations = discover();
  const conn = await connect(true);
  const applied = await appliedVersions(conn);
  const done = migrations.filter(m => applied.has(m.version)).sort().reverse().slice(0, count);
  if (!done.length) { console.log('Nothing to roll back.'); await conn.end(); return; }

  // Guard against destroying live data.
  const populated = [];
  for (const t of BUSINESS_TABLES) {
    const [[row]] = await conn.query(
      `SELECT COUNT(*) AS n FROM information_schema.tables
        WHERE table_schema = ? AND table_name = ?`, [DB_NAME, t]);
    if (!row.n) continue;
    const [[cnt]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
    if (cnt.n > 0) populated.push(`${t} (${cnt.n} rows)`);
  }
  if (populated.length) {
    await conn.end();
    fail(`Rollback blocked — these tables still hold data:\n` +
         populated.map(p => `    • ${p}`).join('\n') +
         `\n  Back up first (mysqldump -u root -p ${DB_NAME} > backup.sql), or run:\n` +
         `    node backend/scripts/migrate.js fresh`);
  }

  for (const m of done.reverse()) await revertMigration(conn, m);
  await conn.end();
  console.log(`\n\x1b[1mRolled back ${done.length} migration(s).\x1b[0m`);
}

async function cmdStatus() {
  const migrations = discover();
  const conn = await connect(true);
  const applied = await appliedVersions(conn);
  console.log(`\nDatabase: \x1b[1m${DB_NAME}\x1b[0m\n`);
  for (const m of migrations) {
    const isApplied = applied.has(m.version);
    const drift = isApplied && applied.get(m.version) !== checksum(m.sql);
    const mark = drift ? '\x1b[31m✖ DRIFT\x1b[0m' : isApplied ? '\x1b[32m✔ applied\x1b[0m' : '\x1b[90m• pending\x1b[0m';
    console.log(`  ${m.version.padEnd(6)} ${m.file.padEnd(32)} ${mark}${m.down ? '' : '  \x1b[90m(no rollback)\x1b[0m'}`);
  }
  const tables = await conn.query(
    'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?', [DB_NAME]);
  console.log(`\n  tables in ${DB_NAME}: ${tables[0][0].n}\n`);
  await conn.end();
}

async function cmdFresh() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(r => rl.question(
    `\x1b[31mThis DROPs the entire \`${DB_NAME}\` database and rebuilds it from migrations.\x1b[0m\n` +
    `Type the database name to confirm: `, r));
  rl.close();
  if (answer.trim() !== DB_NAME) { console.log('Aborted — nothing was changed.'); return; }

  const conn = await connect(false);
  await conn.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
  console.log(`\x1b[33mDropped \`${DB_NAME}\`.\x1b[0m`);
  await conn.end();
  await cmdUp();
}

(async function main() {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case 'up':    await cmdUp(arg); break;
    case 'down':  await cmdDown(Number(arg) || 1); break;
    case 'status':await cmdStatus(); break;
    case 'fresh': await cmdFresh(); break;
    default:
      console.log(`SupplyIQ migrations\n
  node backend/scripts/migrate.js status     show applied / pending / drift
  node backend/scripts/migrate.js up         apply pending migrations
  node backend/scripts/migrate.js up 002     apply up to and including version 002
  node backend/scripts/migrate.js down 1     roll back the last N migrations
  node backend/scripts/migrate.js fresh      DROP the database and rebuild (asks to confirm)\n`);
  }
})().catch(err => { console.error(err); process.exit(1); });