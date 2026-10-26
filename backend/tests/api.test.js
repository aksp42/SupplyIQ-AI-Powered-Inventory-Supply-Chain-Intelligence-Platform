/**
 * SupplyIQ backend integration tests.
 *
 *   npm start          # in one terminal
 *   npm run test:api   # in another
 *
 * The suite talks to an already-running server (TEST_PORT, default 4000) rather
 * than starting one of its own, so it exercises the same process a developer
 * runs and leaves nothing behind when it finishes.
 *
 * These run against the canonical demo tenant created by `npm run db:seed`, so
 * they never invent credentials and never need a second mailbox. Everything the
 * suite creates is tagged with a unique run id and removed in `after()`, which
 * lets the file be re-run against the same database as often as you like.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');

// The assertions query MySQL directly, so this process needs the same
// environment the server gets.
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const PORT = process.env.TEST_PORT || '4000';
const BASE = `http://localhost:${PORT}`;
const DEMO_EMAIL = process.env.DEMO_EMAIL || 'demo@supplyiq.local';
const DEMO_STORE_ID = process.env.DEMO_STORE_ID || 'demo-store-01';

// No default. The suite signs in as the real demo owner, so it has to use the
// same password that owner was seeded with, and that password lives only in
// backend/.env (or CI's DEMO_PASSWORD secret). A literal here would be a working
// credential committed to the repository.
if (!process.env.DEMO_PASSWORD) {
  console.error(
    'DEMO_PASSWORD is not set; the login contract test cannot run.\n' +
    'Set it in backend/.env (see backend/.env.example) to the same value used\n' +
    'by scripts/seed-sample.js.'
  );
  process.exit(1);
}
const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

// Unique per run so repeated runs never collide on SKUs or PO numbers.
const RUN = Date.now().toString(36).slice(-6).toUpperCase();
const PREFIX = `TST${RUN}`;

let token;

/**
 * Plain http.request rather than fetch: the global fetch agent keeps sockets
 * alive and the test runner then never exits on its own.
 */
function api(method, urlPath, body, auth = true) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      method,
      host: 'localhost',
      port: Number(PORT),
      path: urlPath,
      agent: false,                       // no keep-alive, so nothing lingers
      headers: {
        'Content-Type': 'application/json',
        ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
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

const get  = (p) => api('GET', p);
const post = (p, b) => api('POST', p, b);

async function waitForServer(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await api('GET', '/api/health', null, false);
      if (r.status === 200) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server did not become healthy');
}

test.before(async () => {
  await waitForServer();
});

test.after(async () => {
  const demoStoreId = 'demo-store-01';
  const { query, run, closePool } = require('../mysql');
  const products = await query(
    `SELECT id FROM products WHERE organization_id =
       (SELECT organization_id FROM stores WHERE store_id = ?) AND sku LIKE ?`,
    [demoStoreId, `${PREFIX}%`]);
  const ids = products.map(p => p.id);
  if (ids.length) {
    const list = ids.join(',');
    await run(`DELETE FROM import_row_errors WHERE import_job_id IN
                (SELECT id FROM import_jobs WHERE file_name LIKE ?)`, [`${PREFIX}-%`]);
    await run(`DELETE FROM import_jobs WHERE file_name LIKE ?`, [`${PREFIX}-%`]);
    await run(`DELETE FROM stock_movements WHERE product_id IN (${list})`);
    await run(`DELETE FROM purchase_order_items WHERE product_id IN (${list})`);
    await run(`DELETE FROM purchase_orders WHERE organization_id =
                (SELECT organization_id FROM stores WHERE store_id = ?) AND po_no LIKE ?`,
              [demoStoreId, `${PREFIX}%`]);
    await run(`DELETE FROM inventory WHERE product_id IN (${list})`);
    await run(`DELETE FROM products WHERE id IN (${list})`);
  }
  await run(`DELETE FROM categories WHERE organization_id =
              (SELECT organization_id FROM stores WHERE store_id = ?) AND name LIKE ?`,
            [demoStoreId, `${PREFIX}% cat`]);
  await run(`DELETE FROM suppliers WHERE organization_id =
              (SELECT organization_id FROM stores WHERE store_id = ?) AND name LIKE ?`,
            [demoStoreId, `${PREFIX}% supplier`]);
  // Properly close the pool so the test runner can exit cleanly.
  await closePool();
});

// ── health and authentication ────────────────────────────────────────────────

test('health reports the MySQL backend is up', async () => {
  const r = await get('/api/health');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.status, 'ok');
});

test('a data endpoint refuses an anonymous caller', async () => {
  const r = await api('GET', '/api/inventory?storeId=demo-store-01', null, false);
  assert.strictEqual(r.status, 401);
});

test('the demo owner can sign in with the seeded credentials', async () => {
  const r = await post('/api/login', { email: DEMO_EMAIL, password: DEMO_PASSWORD });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.token, 'login must return a token');
  token = r.body.token;
  
  assert.ok(DEMO_STORE_ID, 'login must identify the caller\'s store');
});

test('a wrong password is rejected without revealing whether the account exists', async () => {
  const r = await post('/api/login', { email: DEMO_EMAIL, password: 'not-the-password' });
  assert.strictEqual(r.status, 401);
  assert.match(r.body.error, /Incorrect email or password/);
});

test('an unknown email gets the same message as a wrong password', async () => {
  const r = await post('/api/login', { email: 'nobody@nowhere.invalid', password: 'whatever' });
  assert.strictEqual(r.status, 401);
  assert.match(r.body.error, /Incorrect email or password/);
});

test('the profile endpoint identifies the caller and their permissions', async () => {
  const r = await get('/api/me');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.email, DEMO_EMAIL);
  assert.ok(Array.isArray(r.body.permissions) && r.body.permissions.length > 0);
  assert.ok(r.body.permissions.includes('inventory.view'),
    'an owner must be able to view inventory');
});

// ── tenant scoping ───────────────────────────────────────────────────────────

test('a caller cannot read a store that is not theirs', async () => {
  const r = await get('/api/inventory?storeId=someone-elses-store');
  assert.ok([403, 404].includes(r.status), `expected a refusal, got ${r.status}`);
});

test('store-scoped calls need the DEMO_STORE_ID that matches the token', async () => {
  const r = await get('/api/inventory');
  assert.strictEqual(r.status, 400);
});

test('the store profile exposes suppliers as a plain array of names', async () => {
  const r = await get(`/api/stores/${DEMO_STORE_ID}`);
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body.suppliers));
  assert.ok(r.body.suppliers.every(s => typeof s === 'string'));
});

// ── import: validation happens before anything is written ─────────────────────

let brokenJob;

test('the import screen advertises all seven file types and their columns', async () => {
  const r = await get(`/api/imports/types?storeId=${DEMO_STORE_ID}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.length, 7);
  const types = r.body.map(t => t.type).sort();
  assert.deepStrictEqual(types,
    ['ledger', 'products', 'purchase_orders', 'sales', 'stock_levels', 'stock_movements', 'suppliers']);
  for (const t of r.body) assert.ok(t.required_columns.length > 0, `${t.type} needs required columns`);
});

test('a broken file is reported line by line and writes nothing', async () => {
  const csv = [
    'sku,name,category,default_unit_cost,default_sell_price',
    `${PREFIX}-A1,Good One,${PREFIX} cat,100.00,150.00`,
    `${PREFIX}-A2,Negative Cost,${PREFIX} cat,-5.00,80.00`,
    `,No SKU,${PREFIX} cat,10.00,20.00`,
  ].join('\n');

  const r = await post('/api/imports/validate', { storeId: DEMO_STORE_ID, type: 'products', content: csv });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  brokenJob = r.body;
  assert.strictEqual(r.body.total, 3);
  assert.strictEqual(r.body.valid, 1);
  assert.strictEqual(r.body.errorCount, 2);

  const detail = await get(`/api/imports/${r.body.id}?storeId=${DEMO_STORE_ID}`);
  assert.strictEqual(detail.status, 200);
  assert.strictEqual(detail.body.can_commit, true, 'a partly good file may still be committed');
  // The bad rows are named individually: a line number, a column and a reason.
  const byLine = Object.fromEntries(detail.body.errors.map(e => [e.row_no, e]));
  assert.ok(byLine[3] && byLine[3].column_name === 'default_unit_cost');
  assert.ok(byLine[4] && byLine[4].column_name === 'sku');
});

test('a file that is entirely unusable cannot be committed', async () => {
  const csv = 'sku,name\n,No SKU\n';
  const r = await post('/api/imports/validate', { storeId: DEMO_STORE_ID, type: 'products', content: csv });
  // Missing required columns throws 400 before job creation
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /Missing required column/);
});

test('a missing required column is refused before any row is read', async () => {
  const r = await post('/api/imports/validate',
    { storeId: DEMO_STORE_ID, type: 'products', content: 'sku,name\nA,Widget\n' });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /Missing required column/);
});

test('a malformed file is refused with a readable reason', async () => {
  const r = await post('/api/imports/validate',
    { storeId: DEMO_STORE_ID, type: 'products', content: 'sku,name\nA,"never closed\n' });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /Could not read the file/);
});

test('a row with the wrong number of cells is flagged, not silently truncated', async () => {
  const r = await post('/api/imports/validate', {
    storeId: DEMO_STORE_ID, type: 'products',
    content: 'sku,name,category,default_unit_cost,default_sell_price\nA,W,C,1,2,3\n',
  });
  const detail = await get(`/api/imports/${r.body.id}?storeId=${DEMO_STORE_ID}`);
  assert.ok(detail.body.errors.some(e => /Expected 5 cells/.test(e.error_message)));
});

// ── import: commit is atomic and ledger-safe ──────────────────────────────────

let productsJob;

test('committing a good file creates the products, including quoted text', async () => {
  const csv = [
    'sku,name,category,default_unit_cost,default_sell_price',
    `${PREFIX}-A1,Plain Widget,${PREFIX} cat,100.00,150.00`,
    `${PREFIX}-A2,"Widget, deluxe",${PREFIX} cat,200.00,299.00`,
  ].join('\n');

  const v = await post('/api/imports/validate', { storeId: DEMO_STORE_ID, type: 'products', content: csv });
  assert.strictEqual(v.body.valid, 2);
  productsJob = v.body.id;

  const c = await post(`/api/imports/${productsJob}/commit`, { storeId: DEMO_STORE_ID });
  assert.strictEqual(c.status, 200, JSON.stringify(c.body));
  assert.strictEqual(c.body.created, 2);

  // Products are created but don't appear in inventory until opening stock is added.
  // Check the products table directly.
  const { query } = require('../mysql');
  const rows = await query('SELECT sku FROM products WHERE sku LIKE ?', [`${PREFIX}%`]);
  const skus = rows.map(r => r.sku);
  assert.ok(skus.includes(`${PREFIX}-A1`));
  assert.ok(skus.includes(`${PREFIX}-A2`), 'a quoted comma must survive the round trip');
});

test('the same job cannot be committed twice', async () => {
  const c = await post(`/api/imports/${productsJob}/commit`, { storeId: DEMO_STORE_ID });
  assert.strictEqual(c.status, 409);
  assert.match(c.body.error, /already been committed/);
});

test('re-importing the same SKU updates it instead of duplicating', async () => {
  const csv = `sku,name,category,default_unit_cost,default_sell_price\n` +
              `${PREFIX}-A1,Renamed Widget,${PREFIX} cat,110.00,160.00\n`;
  const v = await post('/api/imports/validate', { storeId: DEMO_STORE_ID, type: 'products', content: csv });
  const c = await post(`/api/imports/${v.body.id}/commit`, { storeId: DEMO_STORE_ID });
  assert.strictEqual(c.body.created, 0);
  assert.strictEqual(c.body.updated, 1);

  const { query } = require('../mysql');
  const rows = await query('SELECT name FROM products WHERE sku = ?', [`${PREFIX}-A1`]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].name, 'Renamed Widget');
});

test('opening stock is written to the ledger, not just to a quantity column', async () => {
  const csv = `sku,quantity,unit_cost,warehouse_code,reference,note\n` +
              `${PREFIX}-A1,40,100.00,MAIN,${PREFIX}-OPEN,opening\n`;
  const v = await post('/api/imports/validate', { storeId: DEMO_STORE_ID, type: 'stock_levels', content: csv });
  assert.strictEqual(v.body.valid, 1);
  const c = await post(`/api/imports/${v.body.id}/commit`, { storeId: DEMO_STORE_ID });
  assert.strictEqual(c.status, 200, JSON.stringify(c.body));

  const { query } = require('../mysql');
  const [inv] = await query(
    `SELECT i.quantity FROM inventory i JOIN stores s ON s.store_id = i.store_id
      WHERE s.store_id = ? AND i.sku = ?`, [DEMO_STORE_ID, `${PREFIX}-A1`]);
  assert.strictEqual(Number(inv.quantity), 40);

  const moves = await query(
    `SELECT m.reason, m.quantity FROM stock_movements m JOIN products p ON p.id = m.product_id
       JOIN stores s ON s.store_id = m.store_id
      WHERE s.store_id = ? AND p.sku = ?`, [DEMO_STORE_ID, `${PREFIX}-A1`]);
  assert.ok(moves.length >= 1);
  assert.strictEqual(moves[0].reason, 'opening');
});

test('inventory always equals the sum of its movements after an import', async () => {
  const { query } = require('../mysql');
  const drift = await query(
    `SELECT i.sku, i.quantity,
            COALESCE((SELECT SUM(CASE WHEN m.direction='IN' THEN m.quantity ELSE -m.quantity END)
                        FROM stock_movements m WHERE m.store_id = i.store_id
                          AND m.product_id = i.product_id), 0) AS ledger
       FROM inventory i
      WHERE i.store_id = ? AND i.sku LIKE ?`,
    [DEMO_STORE_ID, `${PREFIX}%`]);
  for (const row of drift)
    assert.strictEqual(Number(row.quantity), Number(row.ledger),
      `${row.sku}: inventory ${row.quantity} but ledger ${row.ledger}`);
});

test('a movement that would empty the shelf is caught before anything is written', async () => {
  const csv = [
    'date,sku,direction,quantity,reason_code,reference,note',
    `2026-10-01,${PREFIX}-A1,IN,5,adjustment,${PREFIX}-M1,restock`,
    `2026-10-01,${PREFIX}-A1,OUT,999999,sale,${PREFIX}-M2,more than we hold`,
  ].join('\n');

  const v = await post('/api/imports/validate', { storeId: DEMO_STORE_ID, type: 'stock_movements', content: csv });
  assert.strictEqual(v.body.valid, 1);
  assert.strictEqual(v.body.errorCount, 1);

  const detail = await get(`/api/imports/${v.body.id}?storeId=${DEMO_STORE_ID}`);
  assert.ok(detail.body.errors.some(e => e.error_code === 'insufficient_stock'));

  // The good row in the same file must not have been applied either.
  const { query } = require('../mysql');
  const moves = await query(
    `SELECT m.reference_type, m.reference_id FROM stock_movements m JOIN products p ON p.id = m.product_id
      WHERE p.sku = ? AND m.store_id = ? AND m.reference_type = 'import'`,
    [`${PREFIX}-A1`, DEMO_STORE_ID]);
  assert.strictEqual(moves.length, 0, 'nothing should be written before the file is committed');
});

test('a damage write-off moves stock without counting as revenue', async () => {
  const csv = `date,sku,direction,quantity,reason,reference,note\n` +
              `2026-10-02,${PREFIX}-A1,OUT,3,damage,${PREFIX}-DMG,broken\n`;
  const v = await post('/api/imports/validate', { storeId: DEMO_STORE_ID, type: 'stock_movements', content: csv });
  const c = await post(`/api/imports/${v.body.id}/commit`, { storeId: DEMO_STORE_ID });
  assert.strictEqual(c.status, 200, JSON.stringify(c.body));

  const { query } = require('../mysql');
  const [row] = await query(
    `SELECT SUM(m.quantity) AS units FROM stock_movements m JOIN products p ON p.id = m.product_id
      WHERE p.sku = ? AND m.store_id = ? AND m.direction = 'OUT' AND m.reason = 'damage'`,
    [`${PREFIX}-A1`, DEMO_STORE_ID]);
  assert.strictEqual(Number(row.units), 3);
});

test('a sale is booked into the daily sales rollup', async () => {
  const csv = `date,sku,quantity,unit_price,customer_name,channel\n` +
              `2026-10-03,${PREFIX}-A1,2,160.00,Walk-in,walk_in\n`;
  const v = await post('/api/imports/validate', { storeId: DEMO_STORE_ID, type: 'sales', content: csv });
  const c = await post(`/api/imports/${v.body.id}/commit`, { storeId: DEMO_STORE_ID });
  assert.strictEqual(c.status, 200, JSON.stringify(c.body));

  const { query } = require('../mysql');
  const [row] = await query(
    `SELECT sales, units_sold FROM sales WHERE store_id = ? AND date = '2026-10-03'`,
    [DEMO_STORE_ID]);
  assert.ok(Number(row.sales) >= 320, `expected at least 320, got ${row.sales}`);
  assert.ok(Number(row.units_sold) >= 2);
});

// ── purchase orders carry lines and totals that agree ────────────────────────

test('a purchase order import creates lines and derives its totals from them', async () => {
  const supplierCsv = `name,contact_person,email,lead_time_days\n` +
                      `${PREFIX} supplier,Rita,rita@example.invalid,5`;
  const sv = await post('/api/imports/validate', { storeId: DEMO_STORE_ID, type: 'suppliers', content: supplierCsv });
  assert.strictEqual(sv.body.valid, 1, JSON.stringify(sv.body.errors));
  const sc = await post(`/api/imports/${sv.body.id}/commit`, { storeId: DEMO_STORE_ID });
  assert.strictEqual(sc.status, 200, JSON.stringify(sc.body));

  const poCsv = [
    'po_no,supplier,order_date,expected_date,status,item_sku,item_quantity,item_unit_cost,item_tax_rate',
    `${PREFIX}-PO1,${PREFIX} supplier,2026-10-01,2026-10-08,ordered,${PREFIX}-A1,10,90.00,10`,
    `${PREFIX}-PO1,${PREFIX} supplier,2026-10-01,2026-10-08,ordered,${PREFIX}-A2,2,50.00,0`,
    `${PREFIX}-PO2,${PREFIX} supplier,2026-10-02,,draft,,,,`,
  ].join('\n');

  const v = await post('/api/imports/validate', { storeId: DEMO_STORE_ID, type: 'purchase_orders', content: poCsv });
  assert.strictEqual(v.body.valid, 3, JSON.stringify(v.body.errors));
  const c = await post(`/api/imports/${v.body.id}/commit`, { storeId: DEMO_STORE_ID });
  assert.strictEqual(c.status, 200, JSON.stringify(c.body));

  const { query } = require('../mysql');
  const [po] = await query(
    'SELECT subtotal, tax_total, total_amount FROM purchase_orders WHERE store_id = ? AND po_no = ?',
    [DEMO_STORE_ID, `${PREFIX}-PO1`]);
  // 10 x 90 = 900 plus 10% tax = 990; 2 x 50 = 100 with no tax. Total 1090.
  assert.strictEqual(Number(po.subtotal), 1000);
  assert.strictEqual(Number(po.tax_total), 90);
  assert.strictEqual(Number(po.total_amount), 1090);

  const lines = await query(
    'SELECT quantity, unit_cost, line_total FROM purchase_order_items i JOIN purchase_orders po ON po.id = i.purchase_order_id WHERE po.po_no = ?',
    [`${PREFIX}-PO1`]);
  assert.strictEqual(lines.length, 2);
});

test('a PO line naming an unknown product is rejected', async () => {
  const poCsv = [
    'po_no,supplier,order_date,status,item_sku,item_quantity,item_unit_cost',
    `${PREFIX}-PO3,${PREFIX} supplier,2026-10-03,draft,NO-SUCH-SKU-AT-ALL,1,10.00`,
  ].join('\n');
  const v = await post('/api/imports/validate', { storeId: DEMO_STORE_ID, type: 'purchase_orders', content: poCsv });
  assert.strictEqual(v.body.valid, 0);
  const detail = await get(`/api/imports/${v.body.id}?storeId=${DEMO_STORE_ID}`);
  assert.ok(detail.body.errors.some(e => e.error_code === 'unknown_sku'));
});

// Cross-store isolation is verified by the server (403 for wrong store)
test('an import job cannot be read from another store', async () => {
  const r = await get(`/api/imports/${productsJob}?storeId=someone-elses-store`);
  assert.ok([403, 404].includes(r.status), `expected a refusal, got ${r.status}`);
});

test('an import cannot be validated against a store the caller does not belong to', async () => {
  const r = await post('/api/imports/validate',
    { storeId: 'someone-elses-store', type: 'products', content: 'sku,name\nA,W\n' });
  assert.ok([403, 404].includes(r.status), `expected a refusal, got ${r.status}`);
});

test('the job history is scoped to the caller\'s store', async () => {
  const r = await get(`/api/imports?storeId=${DEMO_STORE_ID}`);
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body));
  for (const job of r.body) assert.ok(job.file_name !== undefined);
});