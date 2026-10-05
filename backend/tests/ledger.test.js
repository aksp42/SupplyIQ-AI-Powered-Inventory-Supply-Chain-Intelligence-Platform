/**
 * Consolidated ledger import, end to end.
 *
 *   npm start            # in one terminal
 *   npm run test:ledger  # in another
 *
 * Like tests/api.test.js this drives an already-running server (TEST_PORT,
 * default 4000) so it exercises the process a developer actually runs.
 *
 * Every tenant here is created through the real /api/signup endpoint and removed
 * again in after(), so the suite never touches the demo tenant and can be
 * re-run against the same database as often as you like.
 *
 * Expected quantities, revenue and profit are recomputed from the CSV in this
 * file rather than read back from the importer's own arithmetic: a test that
 * repeats the implementation's formula cannot catch a wrong formula.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Assertions read MySQL directly, so this process needs the server's env.
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const { query, queryOne, run, closePool } = require('../mysql');
const { parseCsvObjects } = require('../csv');

const PORT = process.env.TEST_PORT || '4000';
const API = `http://localhost:${PORT}/api`;
const RUN = Date.now().toString(36).slice(-8);
const LEDGER_CSV = fs.readFileSync(path.join(__dirname, '..', 'csv', 'templates', 'ledger.csv'), 'utf8');

// Tenants created by this run, removed in after().
const createdOrgIds = [];

/** Plain http.request: fetch keeps sockets alive and the runner never exits. */
function api(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    // Paths are written without the /api prefix below; add it here.
    const path_ = urlPath.startsWith('/api') ? urlPath : `/api${urlPath}`;
    const req = http.request({
      method,
      host: 'localhost',
      port: Number(PORT),
      path: path_,
      agent: false,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitForServer(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await api('GET', '/health');
      if (r.status === 200) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not become healthy');
}

/**
 * Sign up a real tenant. The signup code is normally emailed, so the
 * verification code is written straight into otp_codes using the same HMAC the
 * server hashes with; that keeps the test runnable without an SMTP relay while
 * still exercising the genuine signup path.
 */
async function signup(label, businessType = 'grocery') {
  const email = `ledger-${label}-${RUN}@test.local`;
  const code = '246810';
  const pepper = process.env.OTP_PEPPER || process.env.JWT_SECRET;
  const codeHash = crypto.createHmac('sha256', pepper)
    .update(`${email}:${code}`).digest('hex');

  await run(
    `INSERT INTO otp_codes (email, purpose, code_hash, expires_at, attempts)
     VALUES (?, 'signup', ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE), 0)`,
    [email, codeHash]);

  const res = await api('POST', '/signup', {
    name: `Ledger ${label} ${RUN}`, email, password: 'Ledger@1234',
    businessType, phone: '', code,
  });
  assert.strictEqual(res.status, 201, `signup failed: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.token, 'signup must return a token');

  const storeId = res.body.storeId
    || (res.body.store && res.body.store.store_id)
    || (await api('GET', '/me', null, res.body.token)).body.storeId;
  const orgId = (await queryOne('SELECT organization_id FROM stores WHERE store_id = ?', [storeId]))
    .organization_id;
  createdOrgIds.push(orgId);

  return { label, email, token: res.body.token, storeId, orgId };
}

/** Row count for one table inside a tenant, whichever column it is keyed on. */
async function tenantCount(storeId, table) {
  const cols = await query(
    `SELECT column_name c FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ?`, [table]);
  const names = cols.map((r) => r.c || r.C);
  if (names.includes('store_id'))
    return Number((await queryOne(`SELECT COUNT(*) n FROM \`${table}\` WHERE store_id = ?`, [storeId])).n);
  if (names.includes('organization_id'))
    return Number((await queryOne(
      `SELECT COUNT(*) n FROM \`${table}\` WHERE organization_id =
         (SELECT organization_id FROM stores WHERE store_id = ?)`, [storeId])).n);
  throw new Error(`cannot scope ${table} to a tenant`);
}

const VALIDATE = (t, payload) =>
  api('POST', `/imports/validate?storeId=${encodeURIComponent(t.storeId)}`, payload, t.token);
const COMMIT = (t, jobId) =>
  api('POST', `/imports/${jobId}/commit?storeId=${encodeURIComponent(t.storeId)}`, {}, t.token);

// ── Expected values, derived from the file ───────────────────────────────────

const isOut = (v) => ['out', 'sale', 'sold', 'sell', 'issue', 'issued', 'dispatch', 'stock out', 'consumed']
  .includes(String(v == null ? '' : v).trim().toLowerCase());
const reasonOf = (row, direction) => {
  const r = String(row.reason == null ? '' : row.reason).trim().toLowerCase();
  if (r) return r;
  if (direction === 'IN') return 'purchase';
  return 'sale';
};
const positive = (v) => {
  const n = Number(String(v == null ? '' : v).replace(/[,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const round2 = (n) => Math.round(n * 100) / 100;

/** What the ledger says the store should look like once it is committed. */
function expectedFromLedger(csvText) {
  const { rows } = parseCsvObjects(csvText);
  const skus = new Set();
  const finalQty = new Map();
  const days = new Set();
  let movements = 0, revenue = 0, profit = 0, units = 0, orders = 0;

  for (const { data: row } of rows) {
    const dir = isOut(row.direction) ? 'OUT' : 'IN';
    const qty = Number(row.quantity) || 0;
    const sku = String(row.sku).trim();
    const day = String(row.date).trim().slice(0, 10);

    skus.add(sku);
    movements++;
    finalQty.set(sku, (finalQty.get(sku) || 0) + (dir === 'IN' ? qty : -qty));

    if (dir === 'OUT' && reasonOf(row, dir) === 'sale') {
      const price = positive(row.unit_price) || 0;
      const discount = Number.isFinite(Number(row.discount)) ? Number(row.discount) : 0;
      const cost = positive(row.unit_cost) || 0;
      const net = Math.max(0, price * qty - discount);

      revenue += net;
      profit += net - cost * qty;
      units += qty;
      days.add(day);
      if (String(row.invoice_no || '').trim()) orders++;
    }
  }

  return {
    rows: rows.length, skus, movements, finalQty,
    days: days.size, revenue: round2(revenue), profit: round2(profit),
    units, orders,
  };
}

/** A minimal, hand-built ledger. Used where the shipped template cannot test the point. */
function csv(rows, header) {
  return [header.join(','), ...rows.map((r) => r.join(','))].join('\n') + '\n';
}

const LEDGER_HEADER = ['date', 'sku', 'direction', 'quantity', 'product_name', 'category', 'unit',
  'supplier', 'supplier_phone', 'unit_cost', 'unit_price', 'discount', 'channel',
  'invoice_no', 'reason', 'note', 'reorder_pt', 'safety_stock', 'max_stock'];

// ── Fixtures ─────────────────────────────────────────────────────────────────

const EXPECTED = expectedFromLedger(LEDGER_CSV);
const main = {};        // the tenant that imports the shipped ledger
const other = {};       // a second tenant, for isolation
const detect = {};      // a tenant used only for format-detection checks
const reasons = {};     // a tenant with priced non-sale OUT movements
const rollback = {};    // a tenant whose commit must fail part-way

test.before(async () => {
  await waitForServer();
  Object.assign(main, await signup('main'));
  Object.assign(other, await signup('other'));
  Object.assign(detect, await signup('detect'));
  Object.assign(reasons, await signup('reasons'));
  Object.assign(rollback, await signup('rollback'));
});

test.after(async () => {
  for (const orgId of createdOrgIds) {
    for (const table of ['import_row_errors', 'import_jobs', 'sales', 'stock_movements',
      'inventory', 'supplier_products', 'suppliers', 'products', 'categories', 'warehouses',
      'stock_adjustment_items', 'stock_adjustments', 'notification_preferences', 'organization_settings']) {
      try { await run(`DELETE FROM \`${table}\` WHERE organization_id = ?`, [orgId]); } catch { /* absent */ }
    }
    try { await run('UPDATE organizations SET owner_user_id = NULL WHERE id = ?', [orgId]); } catch { /* absent */ }
    try { await run('DELETE FROM users WHERE store_id IN (SELECT store_id FROM stores WHERE organization_id = ?)', [orgId]); } catch { /* absent */ }
    try { await run('DELETE FROM stores WHERE organization_id = ?', [orgId]); } catch { /* absent */ }
    try { await run('DELETE FROM organizations WHERE id = ?', [orgId]); } catch { /* absent */ }
  }
  // Close the pool so the runner can exit.
  await closePool();
});

// ── 1. A new signup starts with nothing ──────────────────────────────────────

test('a brand-new workspace has no stock, products or trading history', async () => {
  // The old behaviour seeded ten demo products with SKUs GRC-001…GRC-010. Four of
  // the six SKUs in the ledger template collided with them under a different
  // product name, so a real shopkeeper's first upload renamed their own goods and
  // left inventory disagreeing with the product master.
  for (const table of ['products', 'categories', 'suppliers', 'supplier_products',
    'inventory', 'stock_movements', 'sales']) {
    assert.strictEqual(await tenantCount(main.storeId, table), 0,
      `a new tenant must have no ${table} rows`);
  }

  // The default warehouse is structure, not sample data: every movement needs a
  // destination, so it is created even for an empty workspace.
  assert.strictEqual(await tenantCount(main.storeId, 'warehouses'), 1);

  // And the read endpoints answer with empty results rather than errors.
  const kpi = await api('GET', `/kpis?storeId=${encodeURIComponent(main.storeId)}`, null, main.token);
  assert.strictEqual(kpi.status, 200, JSON.stringify(kpi.body));
  assert.strictEqual(Number(kpi.body.inventoryValue), 0);
  assert.strictEqual(Number(kpi.body.totalProducts), 0);

  for (const p of ['/inventory', '/sales?period=1M', '/orders']) {
    const r = await api('GET', `${p}&storeId=${encodeURIComponent(main.storeId)}`.replace('&storeId', p.includes('?') ? '&storeId' : '?storeId'),
      null, main.token);
    assert.strictEqual(r.status, 200, `${p} on an empty tenant: ${JSON.stringify(r.body)}`);
    assert.ok(Array.isArray(r.body) ? r.body.length === 0 : true, `${p} should be empty`);
  }
});

// ── 2. The format is identified from the headers ─────────────────────────────

test('a ledger is recognised from its columns with no type supplied', async () => {
  // The dashboard used to hardcode 'stock_levels', so the consolidated ledger was
  // validated against the wrong template: rows silently reshaped into opening
  // stock and the trading history was lost.
  const auto = await VALIDATE(main, { type: 'auto', fileName: 'ledger.csv', content: LEDGER_CSV });
  assert.strictEqual(auto.status, 200, JSON.stringify(auto.body));
  assert.strictEqual(auto.body.type, 'ledger', 'the backend must identify the file as a ledger');
  assert.strictEqual(auto.body.total, EXPECTED.rows);
  assert.strictEqual(auto.body.errorCount, 0);
  assert.strictEqual(auto.body.valid, EXPECTED.rows);
  // Kept so the commit below uses this same job: re-validating the identical file
  // is refused, which is the behaviour the next-but-one test checks.
  main.jobId = auto.body.id;

  // Omitting the type entirely must behave the same way. Done in another tenant,
  // because the same content is already waiting in `main`.
  const omitted = await VALIDATE(detect, { fileName: 'ledger.csv', content: LEDGER_CSV });
  assert.strictEqual(omitted.status, 200, JSON.stringify(omitted.body));
  assert.strictEqual(omitted.body.type, 'ledger');
});

test('an unrecognisable file is refused with an actionable message', async () => {
  const junk = 'colour,shape\nred,round\nblue,square\n';
  const r = await VALIDATE(main, { type: 'auto', fileName: 'notes.csv', content: junk });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, 'unrecognised_format');
  assert.match(r.body.error, /Could not recognise this file/);
});

// The dashboard posts the CSV as text inside a JSON body. express.json() defaults
// to a 100kb limit, which rejected ordinary spreadsheets with a bare 413 that the
// client could not read — the upload just appeared to do nothing. These two
// checks pin the limit and the readable error it produces.

test('a CSV larger than the body limit is refused with a readable 413', async () => {
  const line = '2026-09-01,SKU-1,1,10.00\n';
  const cap = Number(process.env.MAX_IMPORT_BYTES || 12 * 1024 * 1024);
  const tooBig = 'date,sku,quantity,unit_cost\n' + line.repeat(Math.ceil((cap * 1.2) / line.length) + 10);
  assert.ok(Buffer.byteLength(tooBig) > cap, 'the fixture must exceed the cap');

  const r = await VALIDATE(detect, { type: 'auto', fileName: 'huge.csv', content: tooBig });
  assert.strictEqual(r.status, 413);
  assert.strictEqual(r.body.code, 'payload_too_large');
  assert.match(r.body.error, /too large|Split it into smaller files/i);
});

test('an oversized body is reported as JSON, not an HTML error page', async () => {
  // An ordinary route keeps the small limit, and the failure must still be
  // machine-readable: the dashboard parses this response to show the reason.
  const r = await api('POST', `/kpis?storeId=${encodeURIComponent(detect.storeId)}`,
    { pad: 'x'.repeat(2 * 1024 * 1024) }, detect.token);
  assert.strictEqual(r.status, 413);
  assert.strictEqual(r.body.code, 'payload_too_large');
  assert.match(r.body.error, /too large/i);
});

test('a CSV well over the old 100kb default is accepted', async () => {
  // The regression itself: this file would have been a 413 before. Every row is
  // an IN movement, so the fixture is genuinely valid and "ready" is meaningful.
  const header = 'date,sku,direction,quantity,product_name,unit_cost,unit_price,reason\n';
  let body = '';
  for (let i = 1; Buffer.byteLength(header + body, 'utf8') < 300 * 1024; i++) {
    body += `2026-09-${String((i % 28) + 1).padStart(2, '0')},BIG-${i},in,1,Product ${i},10.00,20.00,purchase\n`;
  }
  const csv = header + body;
  assert.ok(Buffer.byteLength(csv) > 100 * 1024, 'the fixture must exceed the old default limit');

  const big = await signup('bigfile', 'stationery');
  const r = await VALIDATE(big, { type: 'auto', fileName: 'big.csv', content: csv });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.type, 'ledger');
  assert.strictEqual(r.body.status, 'ready');
  assert.strictEqual(r.body.valid, r.body.total,
    `every row should be valid, got ${r.body.valid}/${r.body.total}: ${r.body.message}`);
  assert.ok(r.body.total > 1000, `expected the rows to be parsed, got ${r.body.total}`);
});

// ── 3. Committing writes what the file describes ─────────────────────────────

test('committing the ledger writes products, stock, movements and sales', async () => {
  // The job validated above, so this is the one a shopkeeper would commit.
  const commit = await COMMIT(main, main.jobId);
  assert.strictEqual(commit.status, 200, JSON.stringify(commit.body));

  assert.strictEqual(await tenantCount(main.storeId, 'products'), EXPECTED.skus.size);
  assert.strictEqual(await tenantCount(main.storeId, 'inventory'), EXPECTED.skus.size);
  assert.strictEqual(await tenantCount(main.storeId, 'stock_movements'), EXPECTED.movements);
  assert.strictEqual(await tenantCount(main.storeId, 'sales'), EXPECTED.days,
    'one sales row per trading day in the file');

  // Balances are the file's own arithmetic, not the importer's.
  const held = await query(
    `SELECT p.sku, i.quantity FROM inventory i JOIN products p ON p.id = i.product_id
      WHERE i.store_id = ? ORDER BY p.sku`, [main.storeId]);
  assert.strictEqual(held.length, EXPECTED.skus.size);
  for (const row of held) {
    assert.strictEqual(Number(row.quantity), EXPECTED.finalQty.get(row.sku),
      `${row.sku} should hold ${EXPECTED.finalQty.get(row.sku)}`);
  }

  // Revenue is the sum of the sale lines, and orders are counted by invoice.
  const sales = await queryOne(
    'SELECT SUM(sales) s, SUM(profit) p, SUM(units_sold) u, SUM(orders_count) o, COUNT(*) d FROM sales WHERE store_id = ?',
    [main.storeId]);
  assert.strictEqual(round2(Number(sales.s)), EXPECTED.revenue, 'total revenue');
  assert.strictEqual(Number(sales.u), EXPECTED.units, 'units sold');
  assert.strictEqual(Number(sales.o), EXPECTED.orders, 'orders counted by invoice, not by row');
  assert.strictEqual(Number(sales.d), EXPECTED.days);

  // Profit cannot be taken from the CSV alone: the sale rows leave unit_cost
  // empty, so cost comes from the moving average the ledger maintains. That makes
  // the per-movement cost the independent check — the sales rollup has to agree
  // with the movement ledger it summarises, or the two tell different stories.
  const movements = await query(
    `SELECT m.quantity, m.unit_cost FROM stock_movements m
      WHERE m.store_id = ? AND m.direction = 'OUT' AND m.reason = 'sale'`,
    [main.storeId]);
  const costOfGoods = movements.reduce((s, m) => s + Number(m.unit_cost || 0) * Number(m.quantity), 0);
  assert.ok(movements.length > 0, 'the file records sales movements');
  assert.strictEqual(round2(Number(sales.p)), round2(EXPECTED.revenue - costOfGoods),
    'profit must be revenue less the cost recorded on the movements themselves');

  // The job itself is recorded as done, and the numbers agree with the tables.
  const finished = await api('GET', `/imports/${main.jobId}?storeId=${encodeURIComponent(main.storeId)}`,
    null, main.token);
  assert.strictEqual(finished.body.status, 'completed');
  assert.strictEqual(Number(finished.body.valid_rows), EXPECTED.movements,
    'every valid row was written');
  assert.ok(Number(finished.body.created_rows) + Number(finished.body.updated_rows) >= EXPECTED.movements,
    'created plus updated must cover the rows plus metadata');
});

// ── 4. The same file cannot be imported twice ────────────────────────────────

test('re-uploading the same file is refused instead of doubling the numbers', async () => {
  // Without this, a second upload of one ledger added every movement and every
  // sale again: stock halved against reality and revenue doubled.
  const again = await VALIDATE(main, { type: 'auto', fileName: 'ledger.csv', content: LEDGER_CSV });
  assert.strictEqual(again.status, 409, JSON.stringify(again.body));
  assert.strictEqual(again.body.code, 'duplicate_file');
  assert.match(again.body.error, /already imported/i);
  assert.match(again.body.error, /double/i);

  // Renaming the file does not get around it either: the comparison is by content.
  const renamed = await VALIDATE(main, { type: 'auto', fileName: 'ledger-copy.csv', content: LEDGER_CSV });
  assert.strictEqual(renamed.status, 409, 'the same data under another name is the same risk');
  assert.strictEqual(renamed.body.code, 'duplicate_file');

  // And nothing moved while it was being refused.
  assert.strictEqual(await tenantCount(main.storeId, 'stock_movements'), EXPECTED.movements);
  const revenue = await queryOne('SELECT SUM(sales) s FROM sales WHERE store_id = ?', [main.storeId]);
  assert.strictEqual(round2(Number(revenue.s)), EXPECTED.revenue);
});

// ── 5. A failure part-way through leaves nothing behind ──────────────────────

test('a commit that fails part-way rolls back every row and marks the job failed', async () => {
  // Opening stock, so there is a balance to fail against.
  const opening = csv([
    ['2026-08-20', 'RBD-001', 'IN', 300, 'Rollback Widget', 'Test', 'pc', 'Test Supplier',
      '999', 10, 20, 0, 'Wholesale', '', 'purchase', '', 20, 5, 200],
  ], LEDGER_HEADER);
  const seed = await VALIDATE(rollback, { type: 'auto', fileName: 'opening.csv', content: opening });
  assert.strictEqual(seed.body.errorCount, 0, JSON.stringify(seed.body));
  assert.strictEqual((await COMMIT(rollback, seed.body.id)).status, 200);

  // Two sales the store could afford when the file was uploaded. Validation reads
  // stock as it stands at that moment, so this file passes.
  const text = csv([
    ['2026-08-21', 'RBD-001', 'SALE', 100, 'Rollback Widget', 'Test', 'pc', 'Test Supplier',
      '999', 10, 20, 0, 'Retail', 'RB-INV-1', 'sale', '', 20, 5, 200],
    ['2026-08-22', 'RBD-001', 'SALE', 50, 'Rollback Widget', 'Test', 'pc', 'Test Supplier',
      '999', 10, 20, 0, 'Retail', 'RB-INV-2', 'sale', '', 20, 5, 200],
  ], LEDGER_HEADER);

  const job = await VALIDATE(rollback, { type: 'auto', fileName: 'rollback.csv', content: text });
  assert.strictEqual(job.status, 200, JSON.stringify(job.body));
  assert.strictEqual(job.body.errorCount, 0, 'the file is valid when it is uploaded');

  const movementsBefore = await tenantCount(rollback.storeId, 'stock_movements');
  const salesBefore = await tenantCount(rollback.storeId, 'sales');

  // Another till sells stock behind the importer's back: 120 left. The first line
  // of the file still fits, the second does not — so the failure lands *after* a
  // row has already been applied, which is the case that used to leave a
  // half-imported ledger behind.
  await run(`UPDATE inventory SET quantity = 120
              WHERE store_id = ? AND product_id =
                (SELECT id FROM products WHERE organization_id = ? AND sku = 'RBD-001')`,
    [rollback.storeId, rollback.orgId]);

  const commit = await COMMIT(rollback, job.body.id);
  assert.ok(commit.status >= 400, `commit should have failed: ${JSON.stringify(commit.body)}`);
  assert.match(commit.body.error, /more stock than is on hand|not enough stock/i);
  assert.match(commit.body.error, /rolled back|nothing was saved/i);

  // Nothing from the file survived: the row posted before the failure was undone.
  assert.strictEqual(await tenantCount(rollback.storeId, 'stock_movements'), movementsBefore,
    'the row posted before the failure must have been rolled back');
  assert.strictEqual(await tenantCount(rollback.storeId, 'sales'), salesBefore,
    'no sale may survive a failed import');
  const left = await queryOne(
    `SELECT i.quantity FROM inventory i JOIN products p ON p.id = i.product_id
      WHERE i.store_id = ? AND p.sku = 'RBD-001'`, [rollback.storeId]);
  assert.strictEqual(Number(left.quantity), 120, 'stock must be exactly as it was before the commit');

  // The job is failed and carries a reason, so the screen can say what happened
  // rather than showing a stuck "validating" spinner.
  const failed = await api('GET', `/imports/${job.body.id}?storeId=${encodeURIComponent(rollback.storeId)}`,
    null, rollback.token);
  assert.strictEqual(failed.body.status, 'failed');
  assert.match(String(failed.body.error_message || ''), /rolled back|nothing was saved/i);

  // A failed job no longer blocks the store: corrected data can be uploaded.
  const retry = await VALIDATE(rollback, {
    type: 'auto', fileName: 'rollback-retry.csv',
    content: text.replace('100,', '20,'),
  });
  assert.strictEqual(retry.status, 200, 'a failed job must not block the next upload');
});

// ── 6. Movements that are not sales are not revenue ──────────────────────────

test('damage, expiry and transfers move stock without being booked as sales', async () => {
  // These rows are priced like sales and would each add money the shop never
  // took, because the old rule was "any OUT row with a price".
  const text = csv([
    ['2026-08-21', 'RSN-001', 'IN', 200, 'Reason Widget', 'Test', 'pc', 'Test Supplier',
      '888', 10, 25, 0, 'Retail', '', 'purchase', '', 20, 5, 200],
    ['2026-08-22', 'RSN-001', 'OUT', 5, 'Reason Widget', 'Test', 'pc', 'Test Supplier',
      '888', 10, 25, 0, '', '', 'damage', 'broken in transit', 20, 5, 200],
    ['2026-08-22', 'RSN-001', 'OUT', 3, 'Reason Widget', 'Test', 'pc', 'Test Supplier',
      '888', 10, 25, 0, '', '', 'expiry', 'past date', 20, 5, 200],
    ['2026-08-22', 'RSN-001', 'OUT', 7, 'Reason Widget', 'Test', 'pc', 'Test Supplier',
      '888', 10, 25, 0, '', '', 'transfer', 'moved to branch', 20, 5, 200],
    ['2026-08-23', 'RSN-001', 'SALE', 10, 'Reason Widget', 'Test', 'pc', 'Test Supplier',
      '888', 10, 25, 5, 'Retail', 'RSN-INV-1', 'sale', '', 20, 5, 200],
  ], LEDGER_HEADER);

  const job = await VALIDATE(reasons, { type: 'auto', fileName: 'reasons.csv', content: text });
  assert.strictEqual(job.body.errorCount, 0, JSON.stringify(job.body));
  const commit = await COMMIT(reasons, job.body.id);
  assert.strictEqual(commit.status, 200, JSON.stringify(commit.body));

  // Stock reflects every movement: 200 in, 25 out, 10 sold.
  const held = await queryOne(
    `SELECT i.quantity FROM inventory i JOIN products p ON p.id = i.product_id
      WHERE i.store_id = ? AND p.sku = 'RSN-001'`, [reasons.storeId]);
  assert.strictEqual(Number(held.quantity), 200 - 5 - 3 - 7 - 10);

  // Money reflects only the one genuine sale: 10 × 25 less the 5 discount.
  const sales = await queryOne('SELECT SUM(sales) s, SUM(units_sold) u FROM sales WHERE store_id = ?',
    [reasons.storeId]);
  assert.strictEqual(round2(Number(sales.s)), 10 * 25 - 5, 'only the sale line is revenue');
  assert.strictEqual(Number(sales.u), 10, 'only the sale line is a unit sold');

  // The movements themselves are all there, with their reasons intact.
  const movements = await query(
    `SELECT m.reason FROM stock_movements m JOIN products p ON p.id = m.product_id
      WHERE m.store_id = ? AND p.sku = 'RSN-001' ORDER BY m.reason`, [reasons.storeId]);
  assert.deepStrictEqual(movements.map((m) => m.reason),
    ['damage', 'expiry', 'purchase', 'sale', 'transfer']);
});

// ── 7. Product details come from the file, not from stale copies ─────────────

test('the ledger updates product and inventory details instead of leaving stale copies', async () => {
  const text = csv([
    ['2026-08-21', 'UPD-001', 'IN', 40, 'Original Name', 'Original Category', 'pc', 'Original Supplier',
      '111', 10, 20, 0, 'Retail', '', 'purchase', '', 20, 5, 200],
    ['2026-08-22', 'UPD-001', 'IN', 10, 'Renamed Widget', 'New Category', 'pc', 'New Supplier',
      '222', 10, 20, 0, 'Retail', '', 'purchase', '', 35, 12, 150],
  ], LEDGER_HEADER);

  const job = await VALIDATE(main, { type: 'ledger', fileName: 'update.csv', content: text });
  assert.strictEqual(job.body.errorCount, 0, JSON.stringify(job.body));
  assert.strictEqual((await COMMIT(main, job.body.id)).status, 200);

  const product = await queryOne(
    `SELECT p.name, c.name cat, p.default_unit_cost FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.organization_id = ? AND p.sku = 'UPD-001'`, [main.orgId]);
  assert.strictEqual(product.name, 'Renamed Widget', 'the product master must follow the file');
  assert.strictEqual(product.cat, 'New Category');
  assert.strictEqual(Number(product.default_unit_cost), 10);

  // inventory denormalises name/category/supplier for the list screens. Its copy
  // used to keep the first row's values, so the dashboard showed a name the
  // product master no longer used.
  const inv = await queryOne(
    `SELECT i.name, i.category, i.supplier, i.reorder_pt, i.safety_stock, i.max_stock
       FROM inventory i JOIN products p ON p.id = i.product_id
      WHERE i.store_id = ? AND p.sku = 'UPD-001'`, [main.storeId]);
  assert.strictEqual(inv.name, 'Renamed Widget', "inventory's copy must not be stale");
  assert.strictEqual(inv.category, 'New Category');
  assert.strictEqual(inv.supplier, 'New Supplier');
  assert.strictEqual(Number(inv.reorder_pt), 35, 'reorder point must be synchronised');
  assert.strictEqual(Number(inv.safety_stock), 12);
  assert.strictEqual(Number(inv.max_stock), 150);

  const supplier = await queryOne('SELECT name, phone FROM suppliers WHERE organization_id = ? AND name = ?',
    [main.orgId, 'New Supplier']);
  assert.ok(supplier, 'the supplier named in the file must exist');
  assert.strictEqual(supplier.phone, '222', 'a missing supplier phone is filled in');
});

// ── 8. One shop's numbers never reach another ────────────────────────────────

test("a tenant cannot see another tenant's stock, sales or import history", async () => {
  const list = await api('GET', `/inventory?storeId=${encodeURIComponent(other.storeId)}`, null, other.token);
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.body.length, 0, 'the second tenant must see none of the first tenant\'s stock');
  assert.ok(!JSON.stringify(list.body).includes('GRC-001'));

  const history = await api('GET', `/imports?storeId=${encodeURIComponent(other.storeId)}`, null, other.token);
  assert.strictEqual(history.status, 200);
  assert.strictEqual(history.body.length, 0, 'import jobs are tenant-scoped');

  // Reading the first tenant's store is refused rather than quietly returning it.
  const foreign = await api('GET', `/inventory?storeId=${encodeURIComponent(main.storeId)}`, null, other.token);
  assert.ok(foreign.status === 403 || foreign.status === 404,
    `reading another store must be refused, got ${foreign.status}`);

  const kpi = await api('GET', `/kpis?storeId=${encodeURIComponent(other.storeId)}`, null, other.token);
  assert.strictEqual(Number(kpi.body.totalProducts), 0);
});

// ── 9. The dashboard's own numbers match the file ────────────────────────────

test('the KPI endpoints report the imported totals, with correct categories', async () => {
  const kpi = await api('GET', `/kpis?storeId=${encodeURIComponent(main.storeId)}`, null, main.token);
  assert.strictEqual(kpi.status, 200, JSON.stringify(kpi.body));

  const week = await queryOne(
    `SELECT SUM(sales) s FROM sales WHERE store_id = ? AND date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)`,
    [main.storeId]);
  assert.strictEqual(round2(Number(kpi.body.weekSales)), round2(Number(week.s)),
    'weekSales must come from the imported sales rows');
  assert.ok(kpi.body.totalProducts >= EXPECTED.skus.size);

  // The inventory query behind the category breakdown had to select category; when
  // it did not, every product was bucketed as "Uncategorised" and the chart was
  // a single bar however many categories the file described.
  const cats = kpi.body.categories;
  assert.ok(cats && typeof cats === 'object', 'the KPI response must carry categories');

  const counted = await query(
    `SELECT COALESCE(NULLIF(TRIM(i.category),''), 'Uncategorised') c, COUNT(*) n
       FROM inventory i WHERE i.store_id = ? GROUP BY 1`, [main.storeId]);
  const reported = Object.entries(cats);
  assert.strictEqual(reported.reduce((s, [, n]) => s + Number(n), 0), kpi.body.totalProducts,
    'every product belongs to exactly one category bucket');
  for (const row of counted) {
    assert.ok(row.c in cats, `category "${row.c}" from the file is missing from the KPI response`);
    assert.strictEqual(Number(cats[row.c]), Number(row.n), `category "${row.c}" must hold its ${row.n} product(s)`);
  }
  // The ledger describes three categories, so the breakdown cannot be a single
  // "Uncategorised" bar.
  assert.ok(reported.length > 1, 'a multi-category file must not collapse into one bucket');

  const inventory = await api('GET', `/inventory?storeId=${encodeURIComponent(main.storeId)}`, null, main.token);
  const sum = inventory.body.reduce((s, p) => s + Number(p.quantity) * Number(p.unit_cost || 0), 0);
  assert.strictEqual(round2(Number(kpi.body.inventoryValue)), round2(sum),
    'inventory value must equal the sum of what is on the shelf');
});

// ── 10. A forecast is only shown when there is something to base it on ───────

test('a forecast is only shown when there is enough history to base one on', async () => {
  const list = await api('GET', `/inventory?storeId=${encodeURIComponent(main.storeId)}`, null, main.token);
  assert.ok(Array.isArray(list.body) && list.body.length > 0);

  // The shipped ledger covers six weeks of trading, so most of its products do
  // have enough to forecast on. Recompute the band here from the movement ledger
  // and require the API to agree, rather than trusting the number it returns.
  const demand = await query(
    `SELECT p.sku, DATE(m.occurred_at) AS day, SUM(m.quantity) AS sold
       FROM stock_movements m JOIN products p ON p.id = m.product_id
      WHERE m.store_id = ? AND m.direction = 'OUT' AND m.reason = 'sale'
        AND m.occurred_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        AND m.occurred_at < CURDATE()
      GROUP BY p.sku, DATE(m.occurred_at) ORDER BY p.sku, day`,
    [main.storeId]);

  const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
  const soldBySku = new Map();
  for (const r of demand) {
    if (!soldBySku.has(r.sku)) soldBySku.set(r.sku, new Map());
    soldBySku.get(r.sku).set(ymd(r.day), Number(r.sold));
  }

  // Averaging only over days that sold something would read a product selling one
  // unit every other day as selling one unit a day. The series is therefore
  // materialised across the calendar days in the window, with zeros on the days
  // nothing was sold, starting at the product's own first recorded sale (before a
  // product existed, silence is not evidence of zero demand).
  const bounds = await queryOne(
    `SELECT DATE_SUB(CURDATE(), INTERVAL 30 DAY) AS start_at,
            DATE_SUB(CURDATE(), INTERVAL 1 DAY)  AS end_at`);
  const startAt = ymd(bounds.start_at);
  const endAt = ymd(bounds.end_at);
  const seriesFor = (byDay) => {
    if (!byDay || !byDay.size) return [];
    const first = [...byDay.keys()].sort()[0];
    const from = first > startAt ? first : startAt;
    const series = [];
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${endAt}T00:00:00Z`); t += 86400000) {
      series.push(byDay.get(new Date(t).toISOString().slice(0, 10)) || 0);
    }
    return series;
  };

  const WEIGHTS = [1, 2, 3, 4];
  for (const p of list.body) {
    const series = seriesFor(soldBySku.get(p.sku));
    // Days that recorded a sale are the evidence. A day inside the window that
    // sold nothing counts towards the average but is not an observation.
    const n = series.filter(v => v > 0).length;
    assert.strictEqual(p.forecast_sufficient, n >= 5,
      `${p.sku}: ${n} selling day(s), so sufficiency must be ${n >= 5}`);

    if (!n) {
      assert.match(String(p.forecast_note || ''), /not enough.*history/i,
        `${p.sku} has no sales at all and must say so`);
      continue;
    }
    if (n < 5) {
      // A band may exist, but it must be labelled as not forecastable.
      assert.match(String(p.forecast_note || ''), /not enough.*history/i,
        `${p.sku} has only ${n} selling day(s) and must say why it is not forecastable`);
      continue;
    }

    assert.strictEqual(p.forecast_basis, 'history', `${p.sku} is forecast from its own history`);
    assert.strictEqual(Number(p.forecast_observed_days), n,
      `${p.sku}: observedDays must count days that actually recorded a sale, not the window length`);

    // forecast.js: recency-weighted level over the zero-filled series,
    // band = z * sd * sqrt(horizon).
    const days = series.length;
    const mean = series.reduce((s, v) => s + v, 0) / days;
    const recent = series.slice(-WEIGHTS.length);
    let weighted = 0, total = 0;
    recent.forEach((v, i) => { weighted += v * WEIGHTS[i]; total += WEIGHTS[i]; });
    const level = (mean * 0.4 + (weighted / total) * 0.6);
    const sd = Math.sqrt(series.reduce((s, v) => s + (v - mean) ** 2, 0) / (days - 1));
    const band = 1.28 * sd * Math.sqrt(7);
    const round = (v) => Math.max(0, Math.round(v));

    assert.strictEqual(Number(p.forecast_level), round(level), `${p.sku} level`);
    assert.strictEqual(Number(p.forecast_low), round(Math.max(0, level - band)), `${p.sku} low`);
    assert.strictEqual(Number(p.forecast_high), round(level + band), `${p.sku} high`);
  }

  // A product with a single sale day must not be given a confident-looking band:
  // one observation is not a pattern.
  const thin = csv([
    ['2026-09-30', 'THN-001', 'IN', 50, 'Thin History Item', 'Test', 'pc', 'Test Supplier',
      '777', 10, 20, 0, 'Wholesale', '', 'purchase', '', 10, 2, 80],
    ['2026-09-30', 'THN-001', 'SALE', 2, 'Thin History Item', 'Test', 'pc', 'Test Supplier',
      '777', 10, 20, 0, 'Retail', 'THN-INV-1', 'sale', '', 10, 2, 80],
  ], LEDGER_HEADER);
  const thinJob = await VALIDATE(detect, { type: 'auto', fileName: 'thin.csv', content: thin });
  assert.strictEqual((await COMMIT(detect, thinJob.body.id)).status, 200);

  const detectList = await api('GET', `/inventory?storeId=${encodeURIComponent(detect.storeId)}`, null, detect.token);
  const thinRow = detectList.body.find((p) => p.sku === 'THN-001');
  assert.ok(thinRow, 'the thin-history product should be in the list');
  assert.strictEqual(thinRow.forecast_sufficient, false, 'one selling day cannot support a forecast');
  assert.match(String(thinRow.forecast_note || ''), /not enough.*history/i);

  // The history endpoint returns what the ledger holds, and is explicit about it.
  const history = await api('GET',
    `/forecast/history?sku=THN-001&storeId=${encodeURIComponent(detect.storeId)}`,
    null, detect.token);
  assert.strictEqual(history.status, 200, JSON.stringify(history.body));
  assert.strictEqual(history.body.sku, 'THN-001');
  assert.ok(Array.isArray(history.body.points), 'history must be a real series, possibly empty');
  assert.strictEqual(history.body.sufficient, false);
  assert.ok(history.body.note, 'the response must explain why there is no forecast');
  assert.strictEqual(history.body.observedDays, 1);

  // Every number in the series traces to a movement row: one sale of 2 units, and
  // zeros on the days nothing was sold.
  const sold = history.body.points.reduce((s, pt) => s + pt.sold, 0);
  assert.strictEqual(sold, 2, 'the chart series must equal the ledger');
  const ledger = await queryOne(
    `SELECT COALESCE(SUM(m.quantity),0) q FROM stock_movements m JOIN products p ON p.id = m.product_id
      WHERE m.store_id = ? AND p.sku = 'THN-001' AND m.direction = 'OUT' AND m.reason = 'sale'`,
    [detect.storeId]);
  assert.strictEqual(sold, Number(ledger.q));
});

// ── 11. Stock added by hand is actually saved ────────────────────────────────
//
// "Add Stock" on the dashboard takes a product name typed by hand. It used to
// push that name into the page's own state with an empty SKU, skip the stock call
// because a SKU was required, and show a success toast — so the quantity existed
// only in the browser tab and was gone on the next refresh.

test('a product typed into Add Stock is created and its quantity survives a reload', async () => {
  const manual = await signup('manual', 'stationery');

  const before = await api('GET', `/inventory?storeId=${encodeURIComponent(manual.storeId)}`, null, manual.token);
  assert.strictEqual(before.body.length, 0, 'the tenant starts empty');

  const created = await api('POST', `/products?storeId=${encodeURIComponent(manual.storeId)}`,
    { name: 'Basmati Rice', quantity: 25, category: 'Grains', unitCost: 40 }, manual.token);
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  assert.ok(created.body.sku, 'a product created by hand still needs a SKU to be stockable');
  assert.strictEqual(Number(created.body.balance), 25);

  // The quantity must be in the database, not in the tab: re-reading is what the
  // dashboard does after a refresh, and it has to show the same number.
  const after = await api('GET', `/inventory?storeId=${encodeURIComponent(manual.storeId)}`, null, manual.token);
  assert.strictEqual(after.body.length, 1);
  assert.strictEqual(Number(after.body[0].quantity), 25,
    'the added quantity must be readable from the database after a reload');
  assert.strictEqual(after.body[0].sku, created.body.sku);
  assert.strictEqual(after.body[0].category, 'Grains');

  // It is a real ledger entry, not a column that was quietly overwritten.
  const movement = await queryOne(
    `SELECT direction, quantity, reason FROM stock_movements
      WHERE store_id = ? AND reason = 'purchase'`, [manual.storeId]);
  assert.ok(movement, 'adding stock by hand must leave a movement behind');
  assert.strictEqual(movement.direction, 'IN');
  assert.strictEqual(Number(movement.quantity), 25);

  // A second click on the same product adds to it rather than failing.
  const more = await api('POST', `/stock/in?storeId=${encodeURIComponent(manual.storeId)}`,
    { sku: created.body.sku, quantity: 5, note: 'Manual add' }, manual.token);
  assert.strictEqual(more.status, 200, JSON.stringify(more.body));
  assert.strictEqual(Number(more.body.newQuantity), 30);

  // The same name twice must not become two products.
  const dupe = await api('POST', `/products?storeId=${encodeURIComponent(manual.storeId)}`,
    { name: 'basmati rice', quantity: 5 }, manual.token);
  assert.strictEqual(dupe.status, 409, 'a duplicate name must be refused, not duplicated');
  const afterDupe = await api('GET', `/inventory?storeId=${encodeURIComponent(manual.storeId)}`, null, manual.token);
  assert.strictEqual(afterDupe.body.length, 1, 'the refused duplicate must not create a second product');

  // A different product with a similar name gets its own SKU rather than
  // colliding on the unique key.
  const second = await api('POST', `/products?storeId=${encodeURIComponent(manual.storeId)}`,
    { name: 'Basmati Rice Premium', quantity: 3 }, manual.token);
  assert.strictEqual(second.status, 201, JSON.stringify(second.body));
  assert.notStrictEqual(second.body.sku, created.body.sku, 'each product needs its own SKU');

  // And none of it leaks into another tenant.
  const foreign = await api('GET', `/inventory?storeId=${encodeURIComponent(other.storeId)}`, null, manual.token);
  assert.ok(foreign.status === 403 || foreign.status === 404,
    `another store's stock must not be readable, got ${foreign.status}`);
});

// The Add Stock form collects every field this endpoint stores, so each one is
// checked against the database rather than against the response. A 200 that
// echoes the value back is not proof it was written.

test('every field the Add Stock form collects is stored, not just echoed', async () => {
  const t = await signup('allfields', 'stationery');
  const payload = {
    name: 'Basmati Rice', sku: 'RICE-5', quantity: 40,
    unitCost: 82.5, sellPrice: 95, category: 'Grains', supplier: 'Apna Mills',
    reorderPoint: 12, safetyStock: 5, maxStock: 200, monthlyDemand: 60,
  };
  const r = await api('POST', `/products?storeId=${encodeURIComponent(t.storeId)}`, payload, t.token);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));

  const row = await queryOne(
    `SELECT p.sku, p.name, p.default_unit_cost, p.default_sell_price,
            i.quantity, i.reorder_pt, i.safety_stock, i.max_stock, i.monthly_demand,
            i.category, s.name AS supplier
       FROM inventory i
       JOIN products p ON p.id = i.product_id
       LEFT JOIN supplier_products sp ON sp.product_id = p.id AND sp.is_preferred = 1
       LEFT JOIN suppliers s ON s.id = sp.supplier_id
      WHERE i.store_id = ? AND i.sku = 'RICE-5'`, [t.storeId]);
  assert.ok(row, 'the product must be readable from the database');

  assert.strictEqual(row.sku, 'RICE-5');
  assert.strictEqual(row.name, 'Basmati Rice');
  assert.strictEqual(Number(row.default_unit_cost), 82.5);
  assert.strictEqual(Number(row.default_sell_price), 95);
  assert.strictEqual(Number(row.quantity), 40);
  assert.strictEqual(Number(row.reorder_pt), 12);
  assert.strictEqual(Number(row.safety_stock), 5);
  assert.strictEqual(Number(row.max_stock), 200);
  assert.strictEqual(Number(row.monthly_demand), 60);
  assert.strictEqual(row.category, 'Grains');

  // A supplier name the workspace had never seen used to be written only into
  // inventory.supplier: no suppliers row, no product link, and still a 200 that
  // echoed the name back. The category beside it was created on demand, so this
  // one was simply missed.
  assert.strictEqual(row.supplier, 'Apna Mills',
    'a new supplier name must create the supplier and link it to the product');
  const supCount = await queryOne(
    'SELECT COUNT(*) n FROM suppliers WHERE organization_id = ?', [t.orgId]);
  assert.ok(supCount.n >= 1, 'the supplier must exist as a record, not just as text');
});

test('a supplier name that already exists is reused, not duplicated', async () => {
  const t = await signup('reusesup', 'stationery');
  const first = await api('POST', `/products?storeId=${encodeURIComponent(t.storeId)}`,
    { name: 'Rice', quantity: 1, supplier: 'Apna Mills' }, t.token);
  const second = await api('POST', `/products?storeId=${encodeURIComponent(t.storeId)}`,
    { name: 'Wheat', quantity: 1, supplier: 'apna mills' }, t.token);
  assert.strictEqual(first.status, 201);
  assert.strictEqual(second.status, 201);

  const n = await queryOne('SELECT COUNT(*) n FROM suppliers WHERE organization_id = ?', [t.orgId]);
  assert.strictEqual(n.n, 1, 'the same supplier must not be created twice');
});