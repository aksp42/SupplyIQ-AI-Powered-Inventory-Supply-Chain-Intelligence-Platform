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
    const connConfig = {
      host:     process.env.DB_HOST || 'localhost',
      port:     Number(process.env.DB_PORT || 3306),
      user:     process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD,
      database: withDatabase ? DB_NAME : undefined,
      multipleStatements: true,
      charset: 'utf8mb4',
      timezone: 'Z',
    };
    if (process.env.DB_SSL === 'true' || process.env.DB_SSL === '1') {
      connConfig.ssl = { rejectUnauthorized: false };
    }
    return await mysql.createConnection(connConfig);
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

function parseStatement1(sql) {
  const norm = sql.replace(/\s+/g, ' ').trim();
  return /^ALTER TABLE\s+stores\s+ADD\s+UNIQUE\s+(?:KEY|INDEX)\s+uq_store_org_store\s*\(\s*organization_id\s*,\s*store_id\s*\)$/i.test(norm);
}

function parseFkStatement(sql) {
  const norm = sql.replace(/\s+/g, ' ').trim();
  const m = norm.match(/^ALTER TABLE\s+(\w+)\s+ADD\s+CONSTRAINT\s+(\w+)\s+FOREIGN\s+KEY\s*\(\s*organization_id\s*,\s*store_id\s*\)\s+REFERENCES\s+stores\s*\(\s*organization_id\s*,\s*store_id\s*\)\s+ON\s+DELETE\s+(NO\s+ACTION|CASCADE)$/i);
  if (!m) return null;
  return {
    table: m[1],
    constraintName: m[2],
    deleteRule: m[3].toUpperCase().replace(/\s+/, ' ')
  };
}

async function verifyStoresUniqueKey(conn) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME, NON_UNIQUE, SEQ_IN_INDEX
       FROM information_schema.statistics
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'stores'
        AND INDEX_NAME = 'uq_store_org_store'
      ORDER BY SEQ_IN_INDEX`
  );
  if (rows.length !== 2) {
    throw new Error(
      `Verification failed: uq_store_org_store on stores expected 2 columns, found ${rows.length}.`
    );
  }
  if (Number(rows[0].NON_UNIQUE) !== 0 || Number(rows[1].NON_UNIQUE) !== 0) {
    throw new Error(
      `Verification failed: uq_store_org_store on stores is not marked UNIQUE.`
    );
  }
  if (Number(rows[0].SEQ_IN_INDEX) !== 1 || rows[0].COLUMN_NAME !== 'organization_id') {
    throw new Error(
      `Verification failed: uq_store_org_store on stores column at position 1 is '${rows[0].COLUMN_NAME}', expected 'organization_id'.`
    );
  }
  if (Number(rows[1].SEQ_IN_INDEX) !== 2 || rows[1].COLUMN_NAME !== 'store_id') {
    throw new Error(
      `Verification failed: uq_store_org_store on stores column at position 2 is '${rows[1].COLUMN_NAME}', expected 'store_id'.`
    );
  }
  return true;
}

async function verifyTenantForeignKey(conn, { table, constraintName, deleteRule }) {
  const [rcRows] = await conn.query(
    `SELECT TABLE_NAME, REFERENCED_TABLE_NAME, UNIQUE_CONSTRAINT_SCHEMA, DELETE_RULE,
            DATABASE() AS CURRENT_DB
       FROM information_schema.referential_constraints
      WHERE CONSTRAINT_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND CONSTRAINT_NAME = ?`,
    [table, constraintName]
  );
  if (rcRows.length !== 1) {
    throw new Error(
      `Verification failed: foreign key '${constraintName}' on table '${table}' expected 1 referential constraint row, found ${rcRows.length}.`
    );
  }
  const rc = rcRows[0];
  if (!rc.CURRENT_DB || !rc.UNIQUE_CONSTRAINT_SCHEMA ||
      rc.UNIQUE_CONSTRAINT_SCHEMA.toLowerCase() !== rc.CURRENT_DB.toLowerCase()) {
    throw new Error(
      `Verification failed: foreign key '${constraintName}' references unique constraint in schema '${rc.UNIQUE_CONSTRAINT_SCHEMA}', expected current database '${rc.CURRENT_DB}'.`
    );
  }
  if (rc.TABLE_NAME.toLowerCase() !== table.toLowerCase()) {
    throw new Error(
      `Verification failed: foreign key '${constraintName}' belongs to table '${rc.TABLE_NAME}', expected '${table}'.`
    );
  }
  if (rc.REFERENCED_TABLE_NAME.toLowerCase() !== 'stores') {
    throw new Error(
      `Verification failed: foreign key '${constraintName}' references '${rc.REFERENCED_TABLE_NAME}', expected 'stores'.`
    );
  }

  const actualRule = rc.DELETE_RULE ? rc.DELETE_RULE.toUpperCase() : '';
  const ruleMatches =
    (deleteRule === 'NO ACTION' && (actualRule === 'NO ACTION' || actualRule === 'RESTRICT')) ||
    actualRule === deleteRule;
  if (!ruleMatches) {
    throw new Error(
      `Verification failed: foreign key '${constraintName}' on '${table}' has DELETE_RULE '${actualRule}', expected '${deleteRule}'.`
    );
  }

  const [kcuRows] = await conn.query(
    `SELECT COLUMN_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, ORDINAL_POSITION,
            DATABASE() AS CURRENT_DB
       FROM information_schema.key_column_usage
      WHERE CONSTRAINT_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND CONSTRAINT_NAME = ?
      ORDER BY ORDINAL_POSITION`,
    [table, constraintName]
  );
  if (kcuRows.length !== 2) {
    throw new Error(
      `Verification failed: foreign key '${constraintName}' on '${table}' expected 2 key columns, found ${kcuRows.length}.`
    );
  }
  for (let idx = 0; idx < 2; idx++) {
    const row = kcuRows[idx];
    if (!row.CURRENT_DB || !row.REFERENCED_TABLE_SCHEMA ||
        row.REFERENCED_TABLE_SCHEMA.toLowerCase() !== row.CURRENT_DB.toLowerCase()) {
      throw new Error(
        `Verification failed: foreign key '${constraintName}' column at position ${idx + 1} references schema '${row.REFERENCED_TABLE_SCHEMA}', expected current database '${row.CURRENT_DB}'.`
      );
    }
  }
  if (Number(kcuRows[0].ORDINAL_POSITION) !== 1 ||
      kcuRows[0].COLUMN_NAME !== 'organization_id' ||
      kcuRows[0].REFERENCED_TABLE_NAME.toLowerCase() !== 'stores' ||
      kcuRows[0].REFERENCED_COLUMN_NAME !== 'organization_id') {
    throw new Error(
      `Verification failed: foreign key '${constraintName}' column 1 mapping is (${kcuRows[0].COLUMN_NAME} -> ${kcuRows[0].REFERENCED_TABLE_NAME}.${kcuRows[0].REFERENCED_COLUMN_NAME}), expected organization_id -> stores.organization_id at position 1.`
    );
  }
  if (Number(kcuRows[1].ORDINAL_POSITION) !== 2 ||
      kcuRows[1].COLUMN_NAME !== 'store_id' ||
      kcuRows[1].REFERENCED_TABLE_NAME.toLowerCase() !== 'stores' ||
      kcuRows[1].REFERENCED_COLUMN_NAME !== 'store_id') {
    throw new Error(
      `Verification failed: foreign key '${constraintName}' column 2 mapping is (${kcuRows[1].COLUMN_NAME} -> ${kcuRows[1].REFERENCED_TABLE_NAME}.${kcuRows[1].REFERENCED_COLUMN_NAME}), expected store_id -> stores.store_id at position 2.`
    );
  }
  return true;
}

async function applyMigration(conn, m) {
  const statements = splitStatements(m.sql);
  const started = Date.now();
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    try {
      await conn.query(stmt);
    } catch (err) {
      // For migration 003 only: handle resumable statements 1–21 if they already exist
      if (m.version === '003' && i < 21) {
        const isDuplicateErr =
          err.errno === 1061 ||
          err.errno === 1826 ||
          err.code === 'ER_DUP_KEYNAME' ||
          err.code === 'ER_FK_DUP_NAME' ||
          (err.errno === 1005 && /foreign key.*already exists|duplicate/i.test(err.message));

        if (isDuplicateErr) {
          if (i === 0) {
            if (!parseStatement1(stmt)) {
              throw new Error(
                `Migration 003 statement 1 failed with duplicate key, but SQL was not recognized as intended stores unique index statement.`
              );
            }
            await verifyStoresUniqueKey(conn);
            console.log(`  ℹ Statement 1/${statements.length} (uq_store_org_store) verified already present; safely resuming.`);
            continue;
          } else {
            const fkSpec = parseFkStatement(stmt);
            if (!fkSpec) {
              throw new Error(
                `Migration 003 statement ${i + 1} failed with duplicate foreign key, but SQL was not recognized as an intended foreign key statement.`
              );
            }
            await verifyTenantForeignKey(conn, fkSpec);
            console.log(`  ℹ Statement ${i + 1}/${statements.length} (${fkSpec.constraintName}) verified already present; safely resuming.`);
            continue;
          }
        }
      }

      const firstLine = stmt.split('\n').find(l => l.trim()) || '';
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