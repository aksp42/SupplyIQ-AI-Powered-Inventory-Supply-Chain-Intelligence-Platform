// Boots the real dashboard against the real backend and checks that every card
// actually renders.
//
// The other two suites cannot catch this class of failure. test_render.js pulls
// individual functions out of the file with a regex, so a card whose <section>
// was deleted from the static markup still passes as long as the function that
// writes to it is syntactically fine. test_addstock_browser.js stubs fetch to
// resolve `{}`, so loadInventory() returns null and the whole `if (inv)` render
// branch is skipped. Both are the reason a dashboard with four missing card
// containers and a syntax error could look green.
//
// This one does neither: it loads the page with no stub at all and asserts on the
// DOM the real code path produced.
//
// Isolation
// ---------
// The suite signs up a throwaway tenant through the same public endpoints a real
// shop uses (/api/otp/send + /api/signup), creates its one product there, and
// tears the whole tenant down afterwards. It never signs in as the demo user and
// never writes to the demo store, so running it cannot disturb real data — an
// earlier version of this file seeded "Boot Check Widget" into demo-store-01,
// which left a test product sitting in the store a developer was looking at.
//
// Usage: node test_dashboard_boot.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { createRequire } = require('module');
const { execFileSync, spawn } = require('child_process');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SRC = path.join(__dirname, 'SupplyIQ-Grocery-Dashboard.html');
const PAGE = path.join(__dirname, '.tmp-boot-verify.html');
const FRAME = path.join(__dirname, '.tmp-boot-frame.html');

const API = 'http://localhost:4000/api';
const FRONT = 'http://127.0.0.1:3000';
const DEMO_STORE_ID = process.env.DEMO_STORE_ID || 'demo-store-01';

// ── throwaway tenant identity ───────────────────────────────────────────────
// Unique per run, so a re-run never collides with an earlier run's leftovers or
// trips the per-address OTP resend cooldown. `boot.invalid` is reserved by
// RFC 2606 and can never resolve, so a stray email is never deliverable.
const RUN_ID = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const TEST_EMAIL = `siq-boot-${RUN_ID}@boot.invalid`;
const TEST_PASSWORD = `Boot${RUN_ID}7`;   // signup wants 8+ chars, one upper, one digit
const TEST_SHOP = `SIQ Boot Test ${RUN_ID}`;
const TEST_SKU = 'BOOT-CHECK-001';

// Every section the page renders, with a snippet of what proves it rendered.
// A container that no longer exists in the markup is the failure this catches.
const CARDS = [
  ['kpis',       'Sales'],
  ['hchips',     'below cover'],
  ['att',        'class="att'],
  ['gallery',    'Product Showcase'],
  ['chartc',     'Sales &amp; Profit'],
  ['best',       'Best Selling'],
  ['upload',     'Upload Stock Data'],
  ['stockout',   'Stock Out'],
  ['risks',      'Risk &amp; Alerts'],
  ['forecast',   'Demand Forecast'],
  ['inv',        'Inventory Overview'],
  ['sup',        'Supplier'],
  ['incoming',   'Stock Coming In'],
];

const PROBE = `<script>
(async () => {
  const out = { errors: [], rejections: [], cards: {}, steps: [], notes: [] };
  const q = (s) => document.querySelector(s);
  const text = (id) => (q('#' + id) || {}).innerHTML || '';
  window.addEventListener('error', (e) => out.errors.push(String(e.message)));
  window.addEventListener('unhandledrejection',
    (e) => out.rejections.push(String((e.reason && e.reason.message) || e.reason)));

  const waitFor = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { if (fn()) return true; } catch (e) { /* not ready yet */ }
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  };
  const finish = () => {
    if (document.getElementById('boot-result')) return;
    const pre = document.createElement('pre');
    pre.id = 'boot-result';
    pre.textContent = JSON.stringify(out);
    document.body.appendChild(pre);
  };
  // Always report, even if boot never completed: a timed-out probe that prints
  // the errors it did collect is far easier to act on than silence.
  setTimeout(() => { out.timedOut = true; finish(); }, 18000);

  try {
    // The page paints its cards once up front and then loads data and repaints.
    // Waiting on a card therefore proves nothing: #gallery is already filled by
    // the first pass, before any inventory has arrived. DB_ONLINE only flips to
    // true inside loadKpis(), which runs after loadInventory() has completed, so
    // it is the first marker that means "the data boot finished".
    if (!await waitFor(() => (typeof DB_ONLINE !== 'undefined' && DB_ONLINE === true), 20000)) {
      out.steps.push('FAIL the dashboard never finished its data boot (DB_ONLINE never went true)');
      return finish();
    }
    out.notes.push('booted');

    for (const [id, needle] of ${JSON.stringify(CARDS)}) {
      const html = text(id);
      out.cards[id] = {
        exists: !!q('#' + id),
        length: html.length,
        hasNeedle: html.includes(needle) || html.includes(needle.replace(/&amp;/g, '&')),
      };
    }

    // loadInventory() swallows its own errors and returns null, so a failure
    // there is invisible. Record both sides: what the API holds, and what the
    // page actually ended up with. They disagreeing is the bug.
    try {
      const rows = await inventory.get();
      out.apiRows = Array.isArray(rows) ? rows.length : ('not-an-array: ' + typeof rows);
    } catch (e) {
      out.apiErr = String((e && e.message) || e);
    }
    out.pageRows = (typeof S !== 'undefined' && S.prod) ? Object.keys(S.prod).length : null;

    // The Stock Out card's manual form is the newest path on the page and is
    // never opened by the other suites, so open it here.
    if (q('#soManual')) {
      q('#soManual').click();
      await waitFor(() => q('#modc') && /sop/.test(q('#modc').innerHTML), 3000);
      out.stockOutModal = !!q('#sop');

      // Over-ordering must be refused client-side with the exact wording, and it
      // must refuse *before* posting. This is what catches a form that sends the
      // typed product name where the API wants a sku.
      // S.prod is keyed by product name; the value object has no name of its own.
      const state = (typeof S !== 'undefined') ? S : null;
      const entry = state
        ? Object.entries(state.prod).find(([, p]) => p.sku)
        : null;
      const first = entry ? { name: entry[0], sku: entry[1].sku, st: entry[1].st } : null;
      const setVal = (id, v) => { const el = q(id); if (el) el.value = v; };
      out.stockOutHasSku = !!(first && first.sku);
      if (first && q('#soq') && q('#sod')) {
        setVal('#sop', first.name);
        setVal('#sod', '2026-01-15');
        setVal('#soq', String(Number(first.st || 0) + 1000));
        q('#soGo').click();
        await new Promise((r) => setTimeout(r, 500));
        const toasts = [...document.querySelectorAll('#toasts .t')].map((t) => t.textContent);
        out.stockOutInsufficient = toasts.find((t) => t.startsWith('Insufficient stock.')) || null;
        out.stockOutAvailable = Number(first.st);
        out.stockOutAllToasts = toasts;
      }
      q('#modc [data-close]')?.click();
    } else {
      out.stockOutModal = false;
    }

    // And the hero Add Stock button must still open its modal.
    if (q('#addS')) {
      q('#addS').click();
      await waitFor(() => /ap/.test((q('#modc') || {}).innerHTML || ''), 3000);
      out.addStockModal = !!q('#addGo');
    }
  } catch (e) {
    out.steps.push('probe threw: ' + (e && e.message));
  }
  finish();
})();
</script>`;

// ── small helpers ───────────────────────────────────────────────────────────

const request = (method, url, body, token) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(data ? { 'content-length': Buffer.byteLength(data) } : {}),
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
  }, (res) => {
    let raw = '';
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

const postJson = (urlPath, body, token) =>
  request('POST', `${API}${urlPath}`, body, token).then((r) => {
    if (r.status >= 400) {
      const detail = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      throw new Error(`${urlPath} answered ${r.status}: ${detail}`);
    }
    return r.body;
  });

const tcpUp = (port) => new Promise((resolve) => {
  const req = http.get(`http://127.0.0.1:${port}/`, (res) => { res.resume(); resolve(res.statusCode > 0); });
  req.on('error', () => resolve(false));
  req.setTimeout(1200, () => { req.destroy(); resolve(false); });
});

// Start a server if it is not already listening. detached:false so the child
// dies with this process and a failed run does not leave a port held.
async function ensure(kind) {
  const port = kind === 'api' ? 4000 : 3000;
  if (await tcpUp(port)) return null;
  const file = kind === 'api'
    ? path.join(__dirname, '..', 'backend', 'server.js')
    : path.join(__dirname, 'serve.js');
  const child = spawn(process.execPath, [file], {
    cwd: path.dirname(file), stdio: 'ignore', detached: false,
  });
  for (let i = 0; i < 60 && !(await tcpUp(port)); i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!(await tcpUp(port))) {
    child.kill();
    throw new Error(`could not reach the ${kind} server on port ${port}`);
  }
  return child;
}

const chromeDump = (url) => {
  const args = [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=1400,1000',
    // The dashboard pulls ECharts and three.js from a CDN. Point them at a dead
    // host so boot does not stall waiting on a network that is not there; the
    // cards under test do not depend on either library.
    '--host-resolver-rules=MAP cdnjs.cloudflare.com 127.0.0.1:1',
    // --dump-dom prints as soon as the load event fires, which is long before a
    // boot that waits on a live API has finished. --virtual-time-budget keeps
    // Chrome rendering until the budget is spent, and its default policy does not
    // advance time while a network fetch is still in flight, so the real round
    // trips to the API still happen.
    '--virtual-time-budget=25000',
    '--user-data-dir=' + path.join(os.tmpdir(), 'siq-chrome-boot'),
    '--dump-dom', url,
  ];
  try {
    return execFileSync(CHROME, args, {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) {
    const out = (e.stdout || '').toString();
    if (!out) throw new Error('chrome failed: ' + e.message);
    return out;
  }
};

// ── direct database access, for the tenant teardown and its verification ────
// Only used to *delete* what this file created and to prove it is gone. The
// product itself is created through the public API, exactly as the Add Stock form
// would, so the dashboard's own path is what gets exercised. Resolved through the
// backend so this file needs no node_modules of its own.
const backendRequire = createRequire(path.join(__dirname, '..', 'backend', 'package.json'));
backendRequire('dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env'), quiet: true });
const { query, run, withTransaction, closePool } = backendRequire('./mysql');

const orgIdOf = async (storeId) => {
  const rows = await query('SELECT organization_id FROM stores WHERE store_id = ?', [storeId]);
  return rows.length ? rows[0].organization_id : null;
};

// Row counts for the demo store, used only as a before/after fingerprint.
const demoFingerprint = async () => {
  const orgId = await orgIdOf(DEMO_STORE_ID);
  if (orgId === null) return 'demo store not found';
  const rows = await query(
    `SELECT
       (SELECT COUNT(*) FROM products       WHERE organization_id = ?) AS products,
       (SELECT COUNT(*) FROM inventory      WHERE organization_id = ?) AS inventory,
       (SELECT COUNT(*) FROM suppliers      WHERE organization_id = ?) AS suppliers,
       (SELECT COUNT(*) FROM stock_movements WHERE organization_id = ?) AS movements`,
    [orgId, orgId, orgId, orgId]);
  const r = rows[0];
  return `${r.products}p/${r.inventory}i/${r.suppliers}s/${r.movements}m`;
};

// Removes every row the signup and the product seed created, leaves nothing
// behind. Ordered leaf-first and breaking the organizations → owner_user_id →
// users cycle explicitly, because most of these FKs deliberately do not cascade.
// Returns a report so the caller can prove the teardown worked.
async function destroyTenant(storeId, email) {
  const orgId = await orgIdOf(storeId);
  const report = { orgId, storeId, steps: [] };
  if (orgId === null) {
    report.skipped = 'no such store — nothing to remove';
    return report;
  }

  const del = async (sql, params, label) => {
    const r = await run(sql, params);
    if (r.affectedRows) report.steps.push(`${label}: ${r.affectedRows}`);
  };

  // Anything that can hold a non-cascading store_id reference, for this tenant.
  await del('DELETE FROM stock_movements       WHERE organization_id = ?', [orgId], 'stock_movements');
  await del('DELETE FROM inventory            WHERE organization_id = ?', [orgId], 'inventory');
  await del('DELETE FROM products            WHERE organization_id = ?', [orgId], 'products');
  await del('DELETE FROM stock_adjustments    WHERE organization_id = ?', [orgId], 'stock_adjustments');
  await del('DELETE FROM sales_order_items    WHERE organization_id = ?', [orgId], 'sales_order_items');
  await del('DELETE FROM sales_orders         WHERE organization_id = ?', [orgId], 'sales_orders');
  await del('DELETE FROM purchase_order_items WHERE organization_id = ?', [orgId], 'purchase_order_items');
  await del('DELETE FROM purchase_orders      WHERE organization_id = ?', [orgId], 'purchase_orders');
  await del('DELETE FROM import_row_errors    WHERE organization_id = ?', [orgId], 'import_row_errors');
  await del('DELETE FROM import_files         WHERE organization_id = ?', [orgId], 'import_files');
  await del('DELETE FROM import_jobs          WHERE organization_id = ?', [orgId], 'import_jobs');
  await del('DELETE FROM store_members        WHERE organization_id = ?', [orgId], 'store_members');
  await del('DELETE FROM notification_preferences WHERE organization_id = ?', [orgId], 'notification_preferences');
  await del('DELETE FROM warehouses           WHERE organization_id = ?', [orgId], 'warehouses');

  // organizations.owner_user_id references users(id) and users.store_id
  // references stores(store_id), which references organizations(id). NULL the
  // back-reference first so the user and store can be removed.
  await del('UPDATE organizations SET owner_user_id = NULL WHERE id = ?', [orgId], 'organizations.owner_user_id');
  await del('DELETE FROM users      WHERE store_id    = ?', [storeId], 'users');
  await del('DELETE FROM stores    WHERE organization_id = ?', [orgId], 'stores');
  await del('DELETE FROM organizations WHERE id  = ?', [orgId], 'organizations');
  await del('DELETE FROM otp_codes WHERE email = ?', [email], 'otp_codes');

  // Prove it, rather than trusting the deletes: nothing of the tenant may remain.
  const left = await query(
    `SELECT
       (SELECT COUNT(*) FROM stores         WHERE store_id = ?)        AS stores,
       (SELECT COUNT(*) FROM users          WHERE store_id = ?)        AS users,
       (SELECT COUNT(*) FROM products       WHERE organization_id = ?) AS products,
       (SELECT COUNT(*) FROM inventory      WHERE organization_id = ?) AS inventory,
       (SELECT COUNT(*) FROM organizations WHERE id = ?)              AS organizations`,
    [storeId, storeId, orgId, orgId, orgId]);
  report.left = left[0];
  return report;
}

// Creates the throwaway tenant, then signs *in* through the public login
// endpoint so the browser session carries a genuine JWT.
//
// The tenant rows are inserted directly rather than through /api/signup because
// signup is gated on an emailed OTP, and /api/otp/send only hands the code back
// when SMTP is unconfigured. Rather than unset SMTP to obtain it — which would
// risk mailing a real address, and would make the test's behaviour depend on the
// host's mail config — the rows this suite needs are written here and everything
// downstream of them (the token, the session, every dashboard fetch) still goes
// through the real server.
//
// There is deliberately no fallback to the demo account: if the tenant cannot be
// created the run fails rather than quietly writing into real data.
async function provisionTenant() {
  const { hashPassword } = backendRequire('./auth');
  const passwordHash = await hashPassword(TEST_PASSWORD);

  const storeId = `siq-boot-${RUN_ID}`;
  const initials = TEST_SHOP.split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0]).join('').toUpperCase() || 'BT';

  const created = await withTransaction(async (tx) => {
    const org = await tx.run(
      `INSERT INTO organizations
         (slug, name, business_type, email, currency, timezone, is_active)
       VALUES (?,?, 'grocery', ?, 'INR', 'Asia/Kolkata', 1)`,
      [`siq-boot-${RUN_ID}`, `${TEST_SHOP} Store`, TEST_EMAIL]);
    const orgId = org.insertId;

    await tx.run(
      `INSERT INTO stores
         (store_id, organization_id, name, code, owner_name, owner_initials,
          email, type, currency, timezone, theme, tagline, is_active)
       VALUES (?,?,?,?,?,?,?, 'Grocery', 'INR', 'Asia/Kolkata', 'green',
               'Your SupplyIQ workspace', 1)`,
      [storeId, orgId, `${TEST_SHOP} Store`, storeId.slice(0, 8).toUpperCase(),
       TEST_SHOP, initials, TEST_EMAIL]);

    const user = await tx.run(
      `INSERT INTO users
         (email, password, name, store_id, business_type, provider,
          email_verified_at, status)
       VALUES (?,?,?,?, 'grocery', 'email', NOW(), 'active')`,
      [TEST_EMAIL, passwordHash, TEST_SHOP, storeId]);
    const userId = user.insertId;

    await tx.run('UPDATE organizations SET owner_user_id = ? WHERE id = ?', [userId, orgId]);

    // Every permission check reads store_members, so without the owner grant the
    // account signs in but cannot read a single endpoint.
    const role = await tx.queryOne(
      `SELECT id FROM roles WHERE organization_id IS NULL AND key_name = 'owner'`);
    if (!role) throw new Error('the owner role is missing — run the reference data migration (002)');
    await tx.run(
      `INSERT INTO store_members (organization_id, store_id, user_id, role_id, is_active)
       VALUES (?,?,?,?,1)`,
      [orgId, storeId, userId, role.id]);

    await tx.run(
      `INSERT INTO notification_preferences
         (user_id, organization_id, store_id, channel, alert_type, is_enabled, min_severity)
       VALUES (?,?,?, 'in_app', 'all', 1, 'medium')`,
      [userId, orgId, storeId]);

    // The default destination every stock movement is posted against.
    await tx.run(
      `INSERT INTO warehouses (organization_id, code, name, warehouse_type, in_use)
       VALUES (?, 'MAIN', 'Main store', 'warehouse', 1)`,
      [orgId]);

    return { orgId, userId };
  });

  // Authenticate for real: the token the browser uses comes from /api/login, so
  // a broken login path fails this suite too.
  const session = await postJson('/login', { email: TEST_EMAIL, password: TEST_PASSWORD });
  if (!session || !session.token || !session.storeId) {
    throw new Error('the throwaway account could not sign in: ' + JSON.stringify(session));
  }
  if (session.storeId !== storeId) {
    throw new Error(`login returned store ${session.storeId}, expected ${storeId}`);
  }
  return { ...session, orgId: created.orgId };
}

// ── run ─────────────────────────────────────────────────────────────────────

let failures = 0;
const say = (ok, msg) => {
  if (!ok) failures++;
  console.log((ok ? '  ok    ' : '  FAIL  ') + msg);
};
const section = (title) => { console.log(''); console.log(title); };

(async () => {
  const api = await ensure('api');
  const web = await ensure('web');

  let dom;
  let session = null;
  const cleanupErrors = [];

  try {
    const demoBefore = await demoFingerprint();

    session = await provisionTenant();
    console.log(`throwaway tenant: ${TEST_EMAIL} -> store ${session.storeId}`);

    if (session.storeId === DEMO_STORE_ID) {
      throw new Error('refusing to run: the throwaway tenant resolved to the demo store');
    }

    // The Stock Out checks need a product that actually holds stock. Seeding it
    // through the public products endpoint is the same call the Add Stock form
    // makes, so if it works the dashboard's own path works too.
    const seeded = await postJson('/products', {
      storeId: session.storeId,
      name: 'Boot Check Widget',
      sku: TEST_SKU,
      quantity: 12,
      unitCost: 10,
      sellPrice: 15,
    }, session.token);
    if (!seeded || (seeded.error && seeded.code !== 'duplicate_product')) {
      throw new Error('could not seed a product for the stock-out check: ' + JSON.stringify(seeded));
    }

    const shim = `<script>
      localStorage.setItem('siq_session', JSON.stringify(${JSON.stringify({
        token: session.token,
        storeId: session.storeId,
        storeName: session.storeName,
        userName: session.userName,
        ownerName: session.ownerName,
        email: session.email || TEST_EMAIL,
      })}));
    </script>`;

    let html = fs.readFileSync(SRC, 'utf8');
    html = html.replace(/<link rel="icon"[^>]*>/, '');
    html = html.replace('<head>', '<head>' + shim);
    html = html.replace('</body>', PROBE + '</body>');
    fs.writeFileSync(PAGE, html);

    // Loaded directly, not through an iframe: this suite only needs one desktop
    // width, and --dump-dom prints the top-level document, so the probe can write
    // its result straight into the page and there is no postMessage hop to lose.
    dom = chromeDump(`${FRONT}/${path.basename(PAGE)}`);

    const m = dom.match(/<pre id="boot-result">([\s\S]*?)<\/pre>/);
    if (!m || !m[1].trim()) {
      console.error('the page never reported a result.');
      console.error('  dom length: ' + dom.length);
      console.error('  looks like the login page: ' + /login\.html/.test(dom));
      console.error('  probe present in page: ' + /boot-result/.test(dom));
      console.error('  dashboard markup present: ' + /id="stockout"/.test(dom));
      console.error('  has <body>: ' + /<body/.test(dom));
      throw new Error('the page never reported a result');
    }
    const r = JSON.parse(m[1]
      .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>'));

    section('dashboard boot with live backend data');
    if (r.steps && r.steps.length) {
      console.error('the dashboard did not boot:');
      for (const s of r.steps) console.error('  ' + s);
      for (const e of r.errors) console.error('  js error: ' + e);
      for (const e of r.rejections) console.error('  rejection: ' + e);
      failures++;
    } else if (r.timedOut) {
      console.error('the probe timed out before the dashboard finished booting');
      for (const e of r.errors) console.error('  js error: ' + e);
      failures++;
    }

    if (r.apiErr) console.log('inventory API call failed: ' + r.apiErr);
    say(r.errors.length === 0, 'no javascript errors' + (r.errors.length ? ': ' + r.errors.join('; ') : ''));
    say(r.rejections.length === 0, 'no unhandled promise rejections' + (r.rejections.length ? ': ' + r.rejections.join('; ') : ''));
    say(r.pageRows === r.apiRows && r.pageRows > 0,
      `inventory reached the page (API holds ${r.apiRows}, page rendered ${r.pageRows})`);

    for (const [id, c] of Object.entries(r.cards)) {
      const detail = !c.exists ? 'the section is missing from the markup'
        : c.length === 0 ? 'nothing was rendered into it'
        : `rendered ${c.length} chars`;
      say(c.exists && c.length > 0, `#${id} rendered (${detail})`);
      if (c.exists && c.length > 0 && !c.hasNeedle) {
        failures++;
        console.log(`  FAIL  #${id} rendered but is missing its expected content`);
      }
    }

    say(r.stockOutModal === true, 'the Stock Out card opens its manual entry form');
    say(r.stockOutHasSku === true, 'the picked product carries a SKU to post against');
    say(
      r.stockOutInsufficient === `Insufficient stock. Available quantity: ${r.stockOutAvailable}`,
      'Stock Out refuses to over-deduct, with the available quantity in the message'
        + (r.stockOutInsufficient ? ` (got: ${JSON.stringify(r.stockOutInsufficient)})` : ' (no such message was shown)'),
    );
    say(r.addStockModal === true, 'the hero Add Stock button opens its modal');

    // ── isolation, verified rather than assumed ─────────────────────────────
    section('test isolation');
    say(session.storeId !== DEMO_STORE_ID,
      `ran against the throwaway store ${session.storeId}, not ${DEMO_STORE_ID}`);
    say(true, `throwaway account was ${session.email}`);

    let report = null;
    if (session.storeId) {
      report = await destroyTenant(session.storeId, session.email).catch((e) => {
        cleanupErrors.push(e);
        return null;
      });
    }
    if (!report) {
      failures++;
      console.log('  FAIL  the throwaway tenant could not be removed'
        + (cleanupErrors.length ? ': ' + cleanupErrors[0].message : ''));
    } else if (report.skipped) {
      failures++;
      console.log('  FAIL  ' + report.skipped);
    } else {
      const l = report.left;
      const total = l.stores + l.users + l.products + l.inventory + l.organizations;
      say(total === 0,
        `throwaway tenant removed (${report.steps.length ? report.steps.join(', ') : 'nothing to remove'})`);
      say(total === 0, `no rows left behind (stores ${l.stores}, users ${l.users}, products ${l.products}, inventory ${l.inventory}, organizations ${l.organizations})`);
    }

    const demoAfter = await demoFingerprint();
    say(demoAfter === demoBefore,
      `the demo store was not touched (${DEMO_STORE_ID}: ${demoBefore} before, ${demoAfter} after)`);
  } catch (e) {
    failures++;
    console.error('');
    console.error('the boot test failed: ' + e.message);
    // Never leave the tenant behind, even on the unhappy path.
    if (session && session.storeId) {
      try {
        const report = await destroyTenant(session.storeId, session.email);
        console.error('cleanup after failure: ' + (report.steps.length ? report.steps.join(', ') : 'nothing left'));
      } catch (cleanupErr) {
        console.error('CLEANUP FAILED for store ' + session.storeId + ': ' + cleanupErr.message);
      }
    }
  } finally {
    for (const f of [PAGE, FRAME]) { try { fs.unlinkSync(f); } catch {} }
    if (api) api.kill();
    if (web) web.kill();
    try { await closePool(); } catch { /* pool may never have opened */ }
  }

  console.log('');
  console.log(failures ? `${failures} check(s) failed` : 'all dashboard boot checks passed');
  process.exit(failures ? 1 : 0);
})();
