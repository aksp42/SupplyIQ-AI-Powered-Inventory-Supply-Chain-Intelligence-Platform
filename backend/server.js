require('dotenv').config();
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');
const express  = require('express');
const cors     = require('cors');
const { query, run, queryOne, withTransaction } = require('./mysql');
const {
  hashPassword, verifyPassword, needsRehash, sessionPayload,
  requireAuth, requireStore, throttleLogin,
  recordFailure, clearFailures, attemptKey, verifyFirebaseIdToken,
} = require('./auth');
const { PURPOSE: OTP_PURPOSE, sendCode, verifyCode, clearCodes } = require('./otp');
const { resolveProfile } = require('./catalog');
const { storeContext, permissionsFor } = require('./tenancy');
const stock = require('./stock');
const imports = require('./imports');
const forecast = require('./forecast');

const app  = express();
const PORT = process.env.PORT || 4000;

app.use(cors());

// ── Body parsing ──────────────────────────────────────────────────────────────
// The dashboard posts a CSV as text inside a JSON body, so an import request is
// far larger than anything else on this API. express.json() defaults to a 100kb
// limit, which rejected perfectly ordinary spreadsheets with a bare 413 and no
// message — the upload just appeared to do nothing. Ordinary routes keep a small
// limit; the import route gets its own, explicitly bounded one so raising it
// cannot open up every other endpoint.
const MAX_IMPORT_BYTES = Number(process.env.MAX_IMPORT_BYTES || 12 * 1024 * 1024);
const normalJson = express.json({ limit: '1mb' });
const importJson = express.json({ limit: MAX_IMPORT_BYTES });
app.use((req, res, next) => (
  req.method === 'POST' && req.path === '/api/imports/validate'
    ? importJson(req, res, next)
    : normalJson(req, res, next)
));

// ── Helpers ───────────────────────────────────────────────────────────────────
// Kept as the single definition the dashboard already expects (OK / Low /
// Critical / Overstock). stock.js owns the same rule for the write path.
function computeStatus(qty, reorderPt) {
  return stock.computeStatus(qty, reorderPt, 0);
}

// ── Per-user business provisioning ────────────────────────────────────────────
function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'SI';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

async function uniqueStoreId(base) {
  const seed = slugify(base) || 'store';
  for (let attempt = 0; attempt < 12; attempt++) {
    const candidate = attempt === 0
      ? seed
      : `${seed}-${crypto.randomBytes(3).toString('hex')}`;
    const clash = await queryOne('SELECT store_id FROM stores WHERE store_id = ?', [candidate]);
    if (!clash) return candidate;
  }
  return `store-${crypto.randomBytes(6).toString('hex')}`;
}

// Every signup gets its own organization + store, because organization_id is the
// tenant boundary for every inventory/sales/order read. Without this, every
// account would share a store and read the same numbers.
//
// Order matters and each step depends on the last:
//   organizations → stores → user → store_members(owner) → categories → products
//   → suppliers → supplier_products → warehouse → inventory(+opening ledger)
//   → settings
//
// The user is created in here rather than by the caller because users.store_id
// has a real foreign key to stores.store_id, and the owner's role grant needs
// users.id. Keeping all of it in one transaction is what makes the workspace
// atomic: previously the user was inserted afterwards, so a failure between the
// two left a tenant with an owner who had no role grant at all — signed in, but
// with no permissions and no membership row to fix it.
//
// Returns { storeId, orgId, userId }.
async function provisionWorkspaceForUser({
  name, email, businessType, phone, passwordHash, provider, firebaseUid, emailVerifiedAt,
}) {
  const profile = resolveProfile(businessType);
  const businessKey = ['grocery','stationery','hardware','ecommerce','general']
    .includes(String(businessType || '').toLowerCase())
    ? String(businessType).toLowerCase()
    : profile.key;

  const slugBase = slugify(name || email) || 'store';
  const storeId = await uniqueStoreId(slugBase);

  // Sample data is opt-in, and off for real signups.
  //
  // A new workspace used to be seeded with a starter catalogue — ten products
  // under GRC-001…GRC-010, four suppliers and their opening stock. Two things
  // were wrong with that for a genuine new user. Their dashboard showed a
  // grocery shop's stock before they had entered anything, and the seeded SKUs
  // collided with the ones in a ledger upload: four of the six SKUs in the
  // ledger template already existed under a *different* product name, so
  // importing it renamed those products and desynchronised the inventory copy.
  //
  // A tenant is therefore created empty and filled by the shopkeeper's own file.
  // The demo tenant keeps its data because it already exists in the database and
  // is never re-provisioned; development runs that want the sample catalogue can
  // set SEED_NEW_WORKSPACES=1.
  const seedSample = /^(1|true|yes)$/i.test(String(process.env.SEED_NEW_WORKSPACES || ''));

  return withTransaction(async (tx) => {
    // 1. Organization — the tenant root. owner_user_id is left NULL until the
    //    user exists; the FK is deferred on purpose so the cycle
    //    organization → user → store → organization can be satisfied in one pass.
    const orgSlug = `${slugBase}-${crypto.randomBytes(2).toString('hex')}`;
    const org = await tx.run(
      `INSERT INTO organizations
         (slug, name, business_type, email, currency, timezone, is_active)
       VALUES (?,?,?,?, 'INR', 'Asia/Kolkata', 1)`,
      [orgSlug, `${name} Store`, businessKey, email]);
    const orgId = org.insertId;

    // 2. Store — the shop itself. suppliers are NOT stored as JSON on the row
    //    any more; they live in the suppliers table (see step 5).
    await tx.run(
      `INSERT INTO stores
         (store_id, organization_id, name, code, owner_name, owner_initials,
          email, type, currency, timezone, theme, tagline, is_active)
       VALUES (?,?,?,?,?,?,?,?, 'INR', 'Asia/Kolkata', 'green', 'Your SupplyIQ workspace', 1)`,
      [storeId, orgId, `${name} Store`, storeId.slice(0, 8).toUpperCase(),
       name, initialsOf(name), email, profile.label]);

    // 3. The account itself. Created here so its store_id has something to point
    //    at and so the owner grant below can reference it.
    const user = await tx.run(
      `INSERT INTO users
         (email, password, name, phone, store_id, business_type, provider,
          firebase_uid, email_verified_at, status)
       VALUES (?,?,?,?,?,?,?,?,?, 'active')`,
      [email, passwordHash || null, name, phone || null, storeId, businessKey,
       provider || 'email', firebaseUid || null, emailVerifiedAt || new Date()]);
    const userId = user.insertId;

    await tx.run('UPDATE organizations SET owner_user_id = ? WHERE id = ?', [userId, orgId]);

    // 4. Owner role grant. Without this row the account signs in but holds no
    //    permissions, because every permission check reads store_members.
    const ownerRole = await tx.queryOne(
      `SELECT id FROM roles WHERE organization_id IS NULL AND key_name = 'owner'`);
    if (!ownerRole)
      throw new Error('System owner role is missing — run the reference data migration (002).');
    await tx.run(
      `INSERT INTO store_members (organization_id, store_id, user_id, role_id, is_active)
       VALUES (?,?,?,?,1)`,
      [orgId, storeId, userId, ownerRole.id]);

    await tx.run(
      `INSERT INTO notification_preferences
         (user_id, organization_id, store_id, channel, alert_type, is_enabled, min_severity)
       VALUES (?,?,?,?,?,1,'medium')`,
      [userId, orgId, storeId, 'in_app', 'all']);

    // 5. Warehouse. Kept even for an empty workspace: it is the default
    //    destination every stock movement is posted against, not sample data.
    const warehouse = await tx.run(
      'INSERT INTO warehouses (organization_id, code, name, warehouse_type, in_use) VALUES (?,?,?,?,1)',
      [orgId, 'MAIN', 'Main store', 'warehouse']);

    if (seedSample) {
      // Sample catalogue. Development and demo only — see seedSample above.
      //
      // 5. Categories — one per distinct category in the starter catalogue.
      const categories = [...new Set(profile.items.map(i => i.category))];
      const categoryIds = new Map();
      for (const name_ of categories) {
        const r = await tx.run(
          'INSERT INTO categories (organization_id, name) VALUES (?,?)', [orgId, name_]);
        categoryIds.set(name_, r.insertId);
      }

      // 6. Suppliers, normalised out of the old stores.suppliers JSON column.
      const supplierIds = [];
      for (const supplierName of profile.suppliers) {
        const r = await tx.run(
          'INSERT INTO suppliers (organization_id, name, is_active) VALUES (?,?,1)',
          [orgId, supplierName]);
        supplierIds.push(r.insertId);
      }

      // 7. Stock + opening ledger, via the one module allowed to write quantity.
      //    `tx` is handed over so the opening balance lands in this same
      //    transaction — the alternative was committing the workspace first and
      //    writing stock afterwards, which left a real tenant visible in the app
      //    with an empty inventory whenever that second step failed.
      const productIds = [];
      for (const [i, item] of profile.items.entries()) {
        const p = await tx.run(
          `INSERT INTO products
             (organization_id, category_id, sku, name, unit, default_unit_cost,
              default_sell_price, is_active)
           VALUES (?,?,?,?, 'pc', ?, ?, 1)`,
          [orgId, categoryIds.get(item.category), item.sku, item.name,
           item.unit_cost, item.price]);
        productIds.push(p.insertId);

        // 6. Supplier price list. Preferred supplier is spread round-robin so no
        //    supplier is the only source for a SKU in the demo workspace.
        const supplierId = supplierIds[i % supplierIds.length];
        await tx.run(
          `INSERT INTO supplier_products
             (organization_id, supplier_id, product_id, unit_cost, min_order_qty, is_preferred)
           VALUES (?,?,?,?,?,1)`,
          [orgId, supplierId, p.insertId, item.unit_cost, 1]);

        await stock.openStock({
          tx,
          storeId, organizationId: orgId, productId: p.insertId,
          warehouseId: warehouse.insertId,
          sku: item.sku, name: item.name, category: item.category,
          quantity: item.opening_qty, unitCost: item.unit_cost,
          reorderPt: item.reorder_pt, safetyStock: Math.round(item.reorder_pt * 0.3),
          maxStock: item.reorder_pt * 8, monthlyDemand: item.monthly_demand,
          supplier: profile.suppliers[i % profile.suppliers.length] || null,
          userId,
        });
      }
    }

    // 8. Settings + AI defaults, so the workspace is usable straight away.
    await tx.run(
      'INSERT INTO organization_settings (organization_id, settings) VALUES (?,?)',
      [orgId, JSON.stringify({
        default_warehouse: 'MAIN',
        slow_moving_days: 60,
        stockout_buffer_days: 7,
        default_reorder_cover_days: 30,
        low_stock_multiplier: 1.0,
      })]);
    for (const module of ['forecast', 'risk', 'replenishment', 'chat']) {
      await tx.run(
        'INSERT INTO ai_configurations (organization_id, module, is_enabled, provider) VALUES (?,?,1,?)',
        [orgId, module, 'builtin']);
    }

    return { storeId, orgId, userId };
  });
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'SupplyIQ Backend (MySQL) running', timestamp: new Date().toISOString() });
});

// ── Store profiles ────────────────────────────────────────────────────────────
// The dashboard expects `suppliers` as an array of names, so it is projected out
// of the normalised suppliers table rather than stored as JSON on stores.
async function storePayload(store) {
  const suppliers = await query(
    'SELECT name FROM suppliers WHERE organization_id = ? AND is_active = 1 ORDER BY name',
    [store.ORGANIZATION_ID || store.organization_id]);
  const { organization_id, ...rest } = store;
  return { ...rest, suppliers: suppliers.map(s => s.name) };
}

app.get('/api/stores', requireAuth, async (req, res) => {
  try {
    const row = await queryOne('SELECT * FROM stores WHERE store_id = ?', [req.user.store_id]);
    res.json(row ? [await storePayload(row)] : []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stores/:storeId', requireAuth, async (req, res) => {
  try {
    if (req.params.storeId !== req.user.store_id)
      return res.status(403).json({ error: 'You do not have access to this store.' });
    const store = await queryOne('SELECT * FROM stores WHERE store_id = ?', [req.params.storeId]);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    res.json(await storePayload(store));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/me/permissions', requireAuth, requireStore, async (req, res) => {
  try {
    res.json({ permissions: await permissionsFor(req.user.id, req.storeId) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── KPIs ──────────────────────────────────────────────────────────────────────
// Response shape is unchanged so the existing dashboard keeps working. The
// numbers now come from the normalised tables: inventory for stock, sales for
// the daily rollup, purchase_orders (not the old single-line `orders` table).
app.get('/api/kpis', requireAuth, requireStore, async (req, res) => {
  try {
    const storeId = req.storeId;

    const allItems = await query(
      'SELECT quantity, unit_cost, status, category FROM inventory WHERE store_id = ?', [storeId]);
    // "Today" and "this week" have to be real date windows. These used to be read
    // as `allSales.slice(0, 7)` — simply the seven most recent rows in the table —
    // so once the newest recorded sale was more than a week old the dashboard kept
    // reporting that old week as "this week", and "today" fell back to the most
    // recent row of any age. Both figures are now filtered in SQL, and a day with
    // no trading reports zero instead of borrowing an older day's numbers.
    const allSales = await query(
      `SELECT date, sales, profit, units_sold FROM sales
        WHERE store_id = ? AND date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
        ORDER BY date DESC`, [storeId]);
    const allOrders = await query(
      'SELECT status, subtotal FROM purchase_orders WHERE store_id = ?', [storeId]);

    const inventoryValue = allItems.reduce((s, i) => s + Number(i.quantity) * Number(i.unit_cost), 0);
    const stockoutRisk   = allItems.filter(i => ['Critical','Low'].includes(i.status)).length;
    const overstockCount = allItems.filter(i => i.status === 'Overstock').length;

    const today = new Date().toISOString().slice(0, 10);
    // sales.date is a DATE column, so mysql2 hands back a Date at UTC midnight
    // (the pool pins timezone '+00:00'). Comparing it with String() would produce
    // "Sat Oct 04" and never match, so it is formatted the same way forecast.js
    // does before it is compared.
    const ymd = d => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
    const zero  = { sales: 0, profit: 0, units_sold: 0 };
    const todaySales = allSales.find(d => ymd(d.date) === today) || zero;
    const weekSales  = allSales.reduce((s, d) => ({
      sales:      s.sales      + Number(d.sales),
      profit:     s.profit     + Number(d.profit),
      units_sold: s.units_sold + Number(d.units_sold),
    }), { sales: 0, profit: 0, units_sold: 0 });

    const openStatuses = ['draft','pending_approval','approved','ordered','part_received'];
    const pendingOrders = allOrders.filter(o => openStatuses.includes(o.status)).length;
    const runningOut    = allItems.filter(i => i.status === 'Critical').length;

    // Stock received = goods actually booked in, taken from the ledger rather
    // than inferred from PO status.
    const receivedRow = await queryOne(
      `SELECT COALESCE(SUM(quantity),0) AS qty
         FROM stock_movements
        WHERE store_id = ? AND direction = 'IN' AND reason = 'purchase'
          AND occurred_at >= CURDATE() - INTERVAL 30 DAY`, [storeId]);
    const received = Number(receivedRow?.qty || 0);

    // Keyed by category name, with uncategorised stock collected under one explicit
    // label. `categories` here is also read by the dashboard's category filter,
    // so an unset column must not surface as a literal "undefined" bucket.
    const categories = {};
    allItems.forEach(i => {
      const name = (i.category == null || String(i.category).trim() === '')
        ? 'Uncategorised'
        : String(i.category).trim();
      categories[name] = (categories[name] || 0) + 1;
    });

    res.json({
      inventoryValue: +inventoryValue.toFixed(2),
      stockoutRisk, overstockCount,
      todaySales:     Number(todaySales.sales),
      todayProfit:    Number(todaySales.profit),
      todayUnitsSold: Number(todaySales.units_sold),
      weekSales:      weekSales.sales,
      weekProfit:     weekSales.profit,
      margin:         weekSales.sales > 0 ? +(weekSales.profit / weekSales.sales * 100).toFixed(1) : 0,
      pendingOrders,  runningOut,
      stockReceived:  received,
      totalProducts:  allItems.length,
      categories,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Sales chart ───────────────────────────────────────────────────────────────
app.get('/api/sales', requireAuth, requireStore, async (req, res) => {
  try {
    const storeId = req.storeId;
    const { period = '1W' } = req.query;
    const limit = { '1D': 1, '1W': 7, '15D': 15, '1M': 30 }[period] || 7;
    const rows = await query('SELECT * FROM sales WHERE store_id = ? ORDER BY date DESC LIMIT ?', [storeId, limit]);
    res.json(rows.reverse());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Inventory ─────────────────────────────────────────────────────────────────
app.get('/api/inventory', requireAuth, requireStore, async (req, res) => {
  try {
    const storeId = req.storeId;
    const { status, search, category } = req.query;

    let sql = `SELECT i.*, p.pack_size, p.unit, p.default_sell_price
                 FROM inventory i
                 LEFT JOIN products p ON p.id = i.product_id
                WHERE i.store_id = ?`;
    const params = [storeId];
    if (status)   { sql += ' AND i.status = ?';   params.push(status); }
    if (category) {
      sql += category === 'Uncategorised'
        ? " AND (i.category IS NULL OR TRIM(i.category) = '')"
        : ' AND i.category = ?';
      if (category !== 'Uncategorised') params.push(category);
    }
    sql += ' ORDER BY i.updated_at DESC';

    let items = await query(sql, params);
    if (search) {
      const s = search.toLowerCase();
      items = items.filter(i => i.name.toLowerCase().includes(s) || i.sku.toLowerCase().includes(s));
    }

    // Attach the demand band the forecast panel reads. forecast_results is
    // empty until the Python pipeline has been run, so the band is computed
    // from the movement ledger instead of leaving the panel on its fallback.
    let demand = new Map();
    try {
      // The tenant comes from the store row, not the JWT: it is the same value
      // every other route in this file resolves, so the forecast cannot
      // accidentally span two organisations.
      const ctx = await storeContext(storeId);
      if (ctx && ctx.organizationId) {
        demand = await forecast.demandByProduct({ organizationId: ctx.organizationId, storeId });
      }
    } catch (err) {
      // A missing forecast must not take the inventory list down with it: the
      // panel falls back to its own defaults and the rest of the page still works.
      console.warn('forecast: demand unavailable,', err.message);
    }

    res.json(items.map(i => {
      const d = demand.get(Number(i.product_id));
      return {
        ...i,
        forecast_low:  d ? d.low  : null,
        forecast_high: d ? d.high : null,
        forecast_level: d ? d.level : null,
        forecast_basis: d ? d.basis : null,
        monthly_demand_est: d ? d.monthlyDemandEst : null,
        forecast_observed_days: d ? d.observedDays : 0,
        // Whether a forecast can honestly be shown at all, and why not when it
        // cannot. The panel reads this instead of guessing from a null band.
        forecast_sufficient: d ? !!d.sufficient : false,
        forecast_note: d ? (d.note || null) : 'Not enough sales history to forecast this product yet.',
      };
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Real demand history for one product, for the forecast chart's "Actual" line.
// Returns whatever the ledger holds, including an empty series, and states
// whether there is enough of it to forecast from.
app.get('/api/forecast/history', requireAuth, requireStore, async (req, res) => {
  try {
    const sku = String(req.query.sku || '').trim();
    if (!sku) return res.status(400).json({ error: 'sku is required' });

    const days = Math.min(365, Math.max(7, Number(req.query.days) || 30));
    const ctx = await storeContext(req.storeId);
    const history = await forecast.historyForProduct({
      organizationId: ctx.organizationId, storeId: req.storeId, sku, days });

    res.json({
      sku: history.sku,
      name: history.name,
      days,
      points: history.points,
      observedDays: history.observedDays,
      sufficient: history.sufficient,
      note: history.sufficient
        ? null
        : 'Not enough recorded sales to draw a reliable history yet. Import more trading days, then this chart fills in.',
    });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ── Create product ────────────────────────────────────────────────────────────
// "Add Stock" in the dashboard accepts a product name typed by hand. There was
// no route to save that name: the frontend invented a local-only row with an
// empty SKU, skipped the stock call because a SKU was required, and showed a
// success toast — so the quantity vanished on the next refresh.
//
// This creates the product and its opening quantity in one transaction, so a
// typed product behaves exactly like one created by a CSV import. If the name
// already exists in this organization it is reported as a conflict rather than
// creating a second product with a generated SKU.
app.post('/api/products', requireAuth, requireStore, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const sku = String(req.body.sku || '').trim();
    if (!name)
      return res.status(400).json({ error: 'Product name is required.' });
    if (sku.length > imports.SKU_MAX)
      return res.status(400).json({
        error: `SKU must be ${imports.SKU_MAX} characters or fewer.` });

    const quantity = Number(req.body.quantity ?? 0);
    if (!Number.isFinite(quantity) || quantity < 0)
      return res.status(400).json({ error: 'Quantity must be zero or more.' });
    const unitCost = Number(req.body.unitCost ?? 0);
    if (!Number.isFinite(unitCost) || unitCost < 0)
      return res.status(400).json({ error: 'Unit cost must be zero or more.' });

    const ctx = await storeContext(req.storeId);

    // A SKU is the product's identity, so it is required here too. When the
    // caller does not supply one it is derived from the name and de-duplicated
    // inside the organization rather than silently colliding on the unique key.
    const result = await withTransaction(async (tx) => {
      const dupe = await tx.queryOne(
        'SELECT id, sku, name FROM products WHERE organization_id = ? AND LOWER(name) = LOWER(?) LIMIT 1',
        [ctx.organizationId, name]);
      if (dupe)
        throw Object.assign(
          new Error(`"${dupe.name}" already exists in this workspace (SKU ${dupe.sku}).`),
          { status: 409, code: 'duplicate_product' });

      const categoryName = String(req.body.category || '').trim();
      let categoryId = null;
      if (categoryName) {
        const cat = await tx.queryOne(
          'SELECT id FROM categories WHERE organization_id = ? AND LOWER(name) = LOWER(?) LIMIT 1',
          [ctx.organizationId, categoryName]);
        if (cat) categoryId = cat.id;
        else {
          const created = await tx.run(
            'INSERT INTO categories (organization_id, name) VALUES (?,?)',
            [ctx.organizationId, categoryName]);
          categoryId = created.insertId;
        }
      }

      let finalSku = sku;
      if (!finalSku) {
        const base = name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
          .toUpperCase().slice(0, imports.SKU_MAX) || 'PRODUCT';
        finalSku = base;
        // products.sku is unique per organization, so a second product with a
        // similar name gets a suffix rather than failing the insert.
        for (let n = 2; await tx.queryOne(
              'SELECT id FROM products WHERE organization_id = ? AND sku = ?',
              [ctx.organizationId, finalSku]); n++) {
          const suffix = `-${n}`;
          finalSku = base.slice(0, imports.SKU_MAX - suffix.length) + suffix;
        }
      } else {
        const clash = await tx.queryOne(
          'SELECT id FROM products WHERE organization_id = ? AND sku = ?',
          [ctx.organizationId, finalSku]);
        if (clash)
          return res.status(409).json({
            error: `SKU ${finalSku} is already used by another product in this workspace.`,
            code: 'duplicate_sku' });
      }

      const supplierName = String(req.body.supplier || '').trim();
      let supplierId = null;
      if (supplierName) {
        const sup = await tx.queryOne(
          'SELECT id FROM suppliers WHERE organization_id = ? AND LOWER(name) = LOWER(?) LIMIT 1',
          [ctx.organizationId, supplierName]);
        if (sup) supplierId = sup.id;
        else {
          // Create it, exactly as the category above does. This only looked for an
          // existing supplier, so naming one that the workspace had never seen
          // wrote the name into the inventory text column and nothing else: no
          // supplier record, no product link, and a silent 200 that looked saved.
          // The response echoed the name back, which hid it completely.
          const created = await tx.run(
            'INSERT INTO suppliers (organization_id, name) VALUES (?,?)',
            [ctx.organizationId, supplierName]);
          supplierId = created.insertId;
        }
      }

      const product = await tx.run(
        `INSERT INTO products
           (organization_id, category_id, sku, name, unit, default_unit_cost,
            default_sell_price, is_active)
         VALUES (?,?,?,?, 'pc', ?, ?, 1)`,
        [ctx.organizationId, categoryId, finalSku, name,
         unitCost, Number(req.body.sellPrice ?? 0) || unitCost]);

      // An inventory row must exist before any movement can be posted against
      // it, so open it at zero and then record the quantity as a real IN. That
      // leaves the same ledger trail an imported opening balance produces.
      const wh = await tx.queryOne(
        'SELECT id FROM warehouses WHERE organization_id = ? AND in_use = 1 ORDER BY id LIMIT 1',
        [ctx.organizationId]);

      await stock.openStock({
        tx, storeId: req.storeId, organizationId: ctx.organizationId,
        productId: product.insertId, warehouseId: wh ? wh.id : null,
        sku: finalSku, name, category: categoryName || null,
        quantity: 0, unitCost,
        reorderPt: Number(req.body.reorderPoint ?? 0) || 0,
        safetyStock: Number(req.body.safetyStock ?? 0) || 0,
        maxStock: Number(req.body.maxStock ?? 0) || 0,
        monthlyDemand: Number(req.body.monthlyDemand ?? 0) || 0,
        supplier: supplierName || null, userId: req.user.id,
      });

      if (supplierId) {
        await tx.run(
          `INSERT INTO supplier_products
             (organization_id, supplier_id, product_id, unit_cost, min_order_qty, is_preferred)
           VALUES (?,?,?,?,1,1)`,
          [ctx.organizationId, supplierId, product.insertId, unitCost]);
      }

      let balance = 0;
      let status = 'Healthy';
      if (quantity > 0) {
        const moved = await stock.postMovement({
          tx, storeId: req.storeId, organizationId: ctx.organizationId,
          productId: product.insertId, direction: 'IN', quantity,
          unitCost, reason: 'purchase', note: 'Added from dashboard',
          userId: req.user.id, referenceType: 'manual',
        });
        balance = moved.balance;
        status = moved.status;
      }

      return { sku: finalSku, productId: product.insertId, balance, status,
               category: categoryName || null, supplier: supplierName || null };
    });

    res.status(201).json({ success: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, code: err.code || null });
  }
});

// ── Stock IN ──────────────────────────────────────────────────────────────────
// Both stock routes write through stock.postMovement, which is the only place
// allowed to change inventory.quantity — it keeps the ledger and the projection
// consistent inside one transaction.
app.post('/api/stock/in', requireAuth, requireStore, async (req, res) => {
  try {
    const { sku, quantity, note, unitCost, reason } = req.body;
    if (!sku || !quantity || Number(quantity) <= 0)
      return res.status(400).json({ error: 'sku and a positive quantity are required' });

    // A manual stock entry is an adjustment unless the caller says otherwise.
    // It used to be recorded as "return", which implied a customer returned the
    // goods and quietly distorted every report grouped by reason.
    const useReason = reason || 'adjustment';
    if (!stock.REASONS.IN.includes(useReason))
      return res.status(400).json({
        error: `reason must be one of: ${stock.REASONS.IN.join(', ')}` });

    const ctx = await storeContext(req.storeId);
    const item = await stock.findBySku(req.storeId, sku);
    if (!item) return res.status(404).json({ error: `SKU ${sku} not found` });

    const result = await stock.postMovement({
      storeId: req.storeId, organizationId: ctx.organizationId, productId: item.product_id,
      direction: 'IN', quantity, unitCost, reason: useReason,
      note: note || 'Stock IN', userId: req.user.id,
    });
    res.json({ success: true, sku: result.sku, name: result.name, newQuantity: result.balance, status: result.status });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ── Stock OUT ─────────────────────────────────────────────────────────────────
app.post('/api/stock/out', requireAuth, requireStore, async (req, res) => {
  try {
    const { sku, quantity, note, reason, date, invoiceNo } = req.body;
    if (!sku || !quantity || Number(quantity) <= 0)
      return res.status(400).json({ error: 'sku and a positive quantity are required' });

    // 'sale' stays the default so the existing dashboard button keeps meaning
    // "sold", but damage, expiry and adjustments must be passed explicitly —
    // and they must NOT be booked as revenue.
    const useReason = reason || 'sale';
    if (!stock.REASONS.OUT.includes(useReason))
      return res.status(400).json({
        error: `reason must be one of: ${stock.REASONS.OUT.join(', ')}` });

    // An optional business date, so "stock that left on the 4th" can be recorded
    // on the 5th and still be filed under the 4th. Absent or unparseable means
    // now, which is what every existing caller of this route gets — the Sales
    // button sends neither field and behaves exactly as it did before.
    const bookedDate = stockOutDate(date);
    const when = bookedDate ? new Date(`${bookedDate}T00:00:00Z`) : undefined;

    const ctx = await storeContext(req.storeId);
    const item = await stock.findBySku(req.storeId, sku);
    if (!item) return res.status(404).json({ error: `SKU ${sku} not found` });

    const result = await stock.postMovement({
      storeId: req.storeId, organizationId: ctx.organizationId, productId: item.product_id,
      direction: 'OUT', quantity, reason: useReason, invoiceNo,
      note: note || 'Stock OUT', userId: req.user.id, occurredAt: when,
    });

    // Only an actual sale moves revenue. Writing off spoilage or a counting error
    // as a sale inflated both sales and profit on the dashboard, because the
    // rollup used to be booked for every OUT regardless of the reason.
    if (useReason === 'sale') {
      // Upsert on the unique (store_id, date) key so two sales on the same day add
      // up instead of creating a second row and double-counting the day.
      const saleValue  = Number(item.unit_cost) * Number(quantity);
      const saleProfit = Math.round(saleValue * 0.26 * 100) / 100;
      // Revenue lands on the day the goods actually left, so a sale entered on the
      // 5th for the 4th does not inflate today's takings. With no date given this
      // is the same CURDATE() the route always used.
      const bookedOn = bookedDate ? `${bookedDate} 00:00:00` : 'CURDATE()';
      await run(
        `INSERT INTO sales (organization_id, store_id, date, sales, profit, units_sold, orders_count)
         VALUES (?,?,${bookedOn},?,?,?,1)
         ON DUPLICATE KEY UPDATE
           sales      = sales + VALUES(sales),
           profit     = profit + VALUES(profit),
           units_sold = units_sold + VALUES(units_sold),
           orders_count = orders_count + 1`,
        [ctx.organizationId, req.storeId, saleValue, saleProfit, Number(quantity)]);
    }

    res.json({ success: true, sku: result.sku, name: result.name, newQuantity: result.balance, status: result.status, bookedAs: useReason, date: bookedDate || null });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

/**
 * Business date for a stock movement, as YYYY-MM-DD, or null when the caller did
 * not supply one. Returns null rather than defaulting so the caller can keep its
 * own "today" behaviour; an unusable string is treated as absent for the same
 * reason - a typo in the date must not silently file the movement under today
 * without saying so, and the response reports the date actually used.
 */
function stockOutDate(value) {
  if (value == null || String(value).trim() === '') return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : s;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// ── Stock OUT history ─────────────────────────────────────────────────────────
// The read side of the same ledger the POST above writes to, so a row entered by
// hand and a row imported from a CSV are indistinguishable here: both are an OUT
// movement, and both appear in the same table with the same columns.
app.get('/api/stock/out', requireAuth, requireStore, async (req, res) => {
  try {
    const { from, to, sku } = req.query;
    // A filter that is not a plain date is ignored rather than interpolated, so
    // these can only ever narrow the window.
    const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
    const { rows, summary } = await stock.outHistory(req.storeId, {
      from: day(from), to: day(to), sku: sku ? String(sku) : null,
    });
    res.json({
      summary,
      rows: rows.map(r => ({
        id: r.id,
        date: r.occurred_at,
        product: r.name,
        sku: r.sku,
        category: r.category || null,
        unit: r.unit || null,
        quantity: Number(r.quantity),
        reason: r.reason,
        invoice: r.invoice_no || null,
        balance_after: r.balance_after == null ? null : Number(r.balance_after),
      })),
    });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ── Stock ledger ──────────────────────────────────────────────────────────────
// Reads the normalised stock_movements ledger instead of the old `transactions`
// table, so it carries reason, running balance and the document it came from.
app.get('/api/stock/transactions', requireAuth, requireStore, async (req, res) => {
  try {
    const { sku } = req.query;
    let productId = null;
    if (sku) {
      const item = await stock.findBySku(req.storeId, sku);
      if (!item) return res.json([]);
      productId = item.product_id;
    }
    const rows = await stock.ledgerFor(req.storeId, productId, 50);
    res.json(rows.map(r => ({
      id: r.id, store_id: req.storeId, sku: r.sku, product_name: r.product_name,
      type: r.direction, quantity: r.quantity, balance_after: r.balance_after,
      note: r.note || `${r.reason} ${r.direction}`,
      created_at: r.occurred_at,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Purchase orders ───────────────────────────────────────────────────────────
// Replaces the old single-line `orders` table. A PO header plus item rows, so a
// PO for five SKUs from one supplier is one document. The response keeps the
// flat shape the dashboard renders (p, q, s, st).
app.get('/api/orders', requireAuth, requireStore, async (req, res) => {
  try {
    const storeId = req.storeId;
    const rows = await query(
      `SELECT po.id, po.po_no, po.order_date, po.expected_date, po.status,
              po.total_amount, po.subtotal, po.delivered_qty,
              s.name AS supplier,
              COALESCE(SUM(pi.quantity), 0)      AS quantity,
              COALESCE(SUM(pi.received_qty), 0) AS received_quantity,
              GROUP_CONCAT(p.name ORDER BY pi.id SEPARATOR ', ') AS products,
              GROUP_CONCAT(p.sku     ORDER BY pi.id SEPARATOR ', ') AS skus
         FROM purchase_orders po
         JOIN suppliers s         ON s.id = po.supplier_id
         LEFT JOIN purchase_order_items pi ON pi.purchase_order_id = po.id
         LEFT JOIN products p              ON p.id = pi.product_id
        WHERE po.store_id = ?
        GROUP BY po.id, po.po_no, po.order_date, po.expected_date, po.status,
                 po.total_amount, po.subtotal, po.delivered_qty, s.name
        ORDER BY po.order_date DESC, po.id DESC`, [storeId]);

    res.json(rows.map(o => ({
      id: o.id, order_no: o.po_no, date: o.order_date, expected_date: o.expected_date,
      supplier: o.supplier, product: o.products, sku: o.skus,
      quantity: Number(o.quantity), received: Number(o.received_quantity),
      total_value: Number(o.total_amount), status: o.status,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/orders', requireAuth, requireStore, async (req, res) => {
  try {
    const { supplier, sku, product, quantity, total_value, unit_cost, expected_date } = req.body;
    if (!supplier || !sku || !quantity)
      return res.status(400).json({ error: 'supplier, sku, and quantity are required' });

    const ctx = await storeContext(req.storeId);
    const sup = await queryOne(
      'SELECT id FROM suppliers WHERE organization_id = ? AND name = ? AND is_active = 1',
      [ctx.organizationId, supplier]);
    if (!sup)
      return res.status(400).json({ error: `Supplier "${supplier}" is not in your supplier list.` });

    const inv = await stock.findBySku(req.storeId, sku);
    if (!inv) return res.status(404).json({ error: `SKU ${sku} not found` });

    const cost = Number(unit_cost) || Number(total_value || 0) / Number(quantity) || 0;
    const lineTotal = +(cost * Number(quantity)).toFixed(2);
    const poNo = `PO-${req.storeId.toUpperCase().slice(0, 3)}-${Date.now().toString().slice(-8)}`;

    const poId = await withTransaction(async (tx) => {
      const po = await tx.run(
        `INSERT INTO purchase_orders
           (organization_id, store_id, po_no, supplier_id, order_date, expected_date,
            status, subtotal, total_amount, source, created_by)
         VALUES (?,?,?,?,CURDATE(),?,'draft',?,?,'manual',?)`,
        [ctx.organizationId, req.storeId, poNo, sup.id,
         expected_date || null, lineTotal, Number(total_value) || lineTotal, req.user.id]);
      await tx.run(
        `INSERT INTO purchase_order_items
           (organization_id, purchase_order_id, product_id, quantity, unit_cost, line_total)
         VALUES (?,?,?,?,?,?)`,
        [ctx.organizationId, po.insertId, inv.product_id, Number(quantity), cost, lineTotal]);
      await tx.run(
        `INSERT INTO purchase_order_status_history
           (organization_id, purchase_order_id, from_status, to_status, changed_by, remark)
         VALUES (?,?,NULL,'draft',?,'Created')`,
        [ctx.organizationId, po.insertId, req.user.id]);
      return po.insertId;
    });

    res.json({ success: true, order_no: poNo, id: poId });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Receiving a PO posts real stock movements through the ledger, records the
// delivery document, and rolls the PO forward to received/partial. If any line
// fails, the whole receipt is rolled back — a partially applied delivery would
// leave stock that arrived without a document.
app.post('/api/orders/:order_no/receive', requireAuth, requireStore, async (req, res) => {
  try {
    const { order_no } = req.params;
    const ctx = await storeContext(req.storeId);

    const po = await queryOne(
      `SELECT id, po_no, supplier_id, status, order_date, expected_date
         FROM purchase_orders
        WHERE store_id = ? AND po_no = ?`, [req.storeId, order_no]);
    if (!po) return res.status(404).json({ error: 'Order not found' });
    if (po.status === 'received' || po.status === 'cancelled')
      return res.json({ success: true, message: 'Already received', status: po.status });

    const items = await query(
      `SELECT pi.id, pi.product_id, pi.quantity, pi.received_qty, pi.unit_cost
         FROM purchase_order_items pi WHERE pi.purchase_order_id = ?`, [po.id]);

    // Everything below is one transaction. A receipt is a single business fact:
    // stock arriving, the line being marked received, the delivery document and
    // the new PO status either all become visible together or none of them do.
    // Committing each movement separately would allow stock to arrive with no
    // delivery record, which is the exact gap the ledger is meant to close.
    await withTransaction(async (tx) => {
      let deliveryId = null;
      const receivedToday = new Date();

      for (const item of items) {
        const outstanding = Number(item.quantity) - Number(item.received_qty);
        if (outstanding <= 0) continue;

        await stock.postMovement({
          tx,
          storeId: req.storeId, organizationId: ctx.organizationId, productId: item.product_id,
          direction: 'IN', quantity: outstanding, unitCost: item.unit_cost, reason: 'purchase',
          note: `Received: ${po.po_no}`, userId: req.user.id,
          referenceType: 'purchase_order', referenceId: po.id,
        });

        await tx.run(
          'UPDATE purchase_order_items SET received_qty = received_qty + ? WHERE id = ?',
          [outstanding, item.id]);

        // One delivery document per receipt, shared by every line on it.
        if (!deliveryId) {
          const d = await tx.run(
            `INSERT INTO deliveries
               (organization_id, store_id, purchase_order_id, delivery_no, supplier_id,
                received_on, status, received_by)
             VALUES (?,?,?,?,?,CURDATE(),'received',?)`,
            [ctx.organizationId, req.storeId, po.id,
             `DL-${Date.now().toString().slice(-8)}`, po.supplier_id, req.user.id]);
          deliveryId = d.insertId;
        }

        await tx.run(
          `INSERT INTO delivery_items
             (organization_id, delivery_id, product_id, quantity, unit_cost, accepted)
           VALUES (?,?,?,?,?,1)`,
          [ctx.organizationId, deliveryId, item.product_id, outstanding, item.unit_cost]);

        // Lead time is measured against the dates already read from the PO, not
        // against subqueries repeated here — fewer round trips, and the values
        // cannot disagree with the header the caller was shown.
        const orderedOn   = new Date(po.order_date);
        const actualDays  = Math.max(0, Math.round((receivedToday - orderedOn) / 86400000));
        const isLate      = po.expected_date
          ? receivedToday > new Date(po.expected_date) ? 1 : 0
          : null;

        await tx.run(
          `INSERT INTO supplier_lead_times
             (organization_id, supplier_id, product_id, purchase_order_id,
              ordered_on, received_on, actual_days, is_late)
           VALUES (?,?,?,?,?,?,?,?)`,
          [ctx.organizationId, po.supplier_id, item.product_id, po.id,
           po.order_date, receivedToday, actualDays, isLate]);
      }

      const totals = await tx.queryOne(
        `SELECT COALESCE(SUM(received_qty),0) AS got, COALESCE(SUM(quantity),0) AS want
           FROM purchase_order_items WHERE purchase_order_id = ?`, [po.id]);
      const complete   = Number(totals.got) >= Number(totals.want);
      const nextStatus = complete ? 'received' : 'part_received';

      await tx.run(
        'UPDATE purchase_orders SET status = ?, delivered_qty = ? WHERE id = ?',
        [nextStatus, totals.got, po.id]);
      await tx.run(
        `INSERT INTO purchase_order_status_history
           (organization_id, purchase_order_id, from_status, to_status, changed_by, remark)
         VALUES (?,?,?,?,?,?)`,
        [ctx.organizationId, po.id, po.status, nextStatus, req.user.id, 'Stock received']);

      return nextStatus;
    }).then(nextStatus =>
      res.json({ success: true, order_no: order_no, status: nextStatus }));
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ── TradeSaarthi Chat ─────────────────────────────────────────────────────────
app.post('/api/chat', requireAuth, requireStore, async (req, res) => {
  try {
    const { message } = req.body;
    const storeId = req.storeId;
    if (!message) return res.status(400).json({ error: 'message is required' });

    const lower     = message.toLowerCase();
    const allItems  = await query('SELECT * FROM inventory WHERE store_id = ?', [storeId]);
    const allSales  = await query('SELECT sales, profit FROM sales WHERE store_id = ? ORDER BY date DESC LIMIT 7', [storeId]);
    const allOrders = await query(
      `SELECT po.status, sup.name AS supplier, po.total_amount
         FROM purchase_orders po JOIN suppliers sup ON sup.id = po.supplier_id
        WHERE po.store_id = ? ORDER BY po.order_date DESC LIMIT 5`, [storeId]);
    const ctx   = await storeContext(storeId);
    const store = ctx?.store;

    // Supplier names and real on-time rates come from the normalised tables.
    const supplierRows = await query(
      `SELECT s.name, COALESCE(p.on_time_rate, 0) AS on_time_rate,
              COALESCE(p.avg_lead_time_days, 0) AS avg_lead_days
         FROM suppliers s
         LEFT JOIN supplier_performance p
                ON p.supplier_id = s.id AND p.period_end = (
                     SELECT MAX(p2.period_end) FROM supplier_performance p2
                      WHERE p2.supplier_id = s.id)
        WHERE s.organization_id = ? AND s.is_active = 1
        ORDER BY s.name LIMIT 5`, [ctx.organizationId]);
    const suppliers = supplierRows.map(s => s.name);

    const critical    = allItems.filter(i => i.status === 'Critical');
    const lowStock    = allItems.filter(i => i.status === 'Low');
    const overstock   = allItems.filter(i => i.status === 'Overstock');
    const weekRevenue = allSales.reduce((s, d) => s + Number(d.sales), 0);
    const weekProfit  = allSales.reduce((s, d) => s + Number(d.profit), 0);
    const cur         = store?.currency || '\u20b9';
    const openOrders  = allOrders.filter(o => ['draft','approved','ordered','part_received'].includes(o.status)).length;

    let reply = '', actions = [];

    if (/run out|running|stockout|khatam|critical|low stock/.test(lower)) {
      const list = [...critical, ...lowStock].map(i => `• **${i.name}**: ${i.quantity} units (reorder at ${i.reorder_pt})`).join('\n');
      reply = `⚠️ **${critical.length + lowStock.length} Products Need Attention**\n\n${list}\n\n💡 Place purchase orders immediately to avoid stockout.`;
      actions = ['What should I order tomorrow?', 'Show all inventory', 'Which product sold the most?'];
    } else if (/order|buy|purchase|reorder/.test(lower)) {
      const needs = [...critical, ...lowStock];
      const list = needs.map(i => `• **${i.name}** — ${Math.max(50, i.monthly_demand - i.quantity)} units from ${i.supplier || 'supplier'}`).join('\n');
      reply = `📦 **Tomorrow's Order Plan**\n\n${list || '• All products are well stocked!'}\n\n${openOrders} orders already pending with suppliers.`;
      actions = ['Which product will run out soon?', 'How much profit did I make?'];
    } else if (/sold|sell|best|top/.test(lower)) {
      const sorted = [...allItems].sort((a, b) => b.monthly_demand - a.monthly_demand).slice(0, 3);
      const list = sorted.map((i, n) => `${n+1}. **${i.name}** — ${i.monthly_demand} units/month`).join('\n');
      reply = `🏆 **Best Selling Products**\n\n${list}\n\nConsider ordering extra stock for your top sellers!`;
      actions = ['What should I order tomorrow?', 'How much profit did I make?'];
    } else if (/profit|margin|revenue|sales/.test(lower)) {
      const margin = weekRevenue > 0 ? (weekProfit / weekRevenue * 100).toFixed(1) : 0;
      reply = `💰 **Weekly Financial Summary**\n\n• Sales Revenue: ${cur}${Math.round(weekRevenue).toLocaleString('en-IN')}\n• Profit: ${cur}${Math.round(weekProfit).toLocaleString('en-IN')}\n• Margin: ${margin}%`;
      actions = ['Which product sold the most?', 'Which stock is moving slowly?'];
    } else if (/slow|dead|stuck|overstock/.test(lower)) {
      const list = overstock.map(i => `• **${i.name}**: ${i.quantity} units (${cur}${(i.quantity * Number(i.unit_cost)).toLocaleString('en-IN')} tied up)`).join('\n');
      reply = `🐌 **Slow Moving / Overstock**\n\n${list || '• No overstocked items currently'}\n\n💡 Apply 20% clearance offer to free up cash.`;
      actions = ['How much profit did I make?', 'What should I order tomorrow?'];
    } else if (/supplier|delay/.test(lower)) {
      // Real numbers only. When no performance snapshot exists yet (a brand new
      // store), say so instead of inventing an on-time percentage.
      const rated = supplierRows.filter(s => Number(s.on_time_rate) > 0);
      const body = rated.length
        ? rated.map(s => {
            const pct = Number(s.on_time_rate);
            const mark = pct < 80 ? '\u26A0\uFE0F' : pct < 90 ? '\uD83D\uDCA1' : '\u2705';
            return `\u2022 **${s.name}**: ${pct.toFixed(0)}% on-time ${mark}`;
          }).join('\n')
        : `\u2022 ${supplierRows.length} suppliers registered. No delivery history yet, so no on-time rate is available yet.`;
      const best = rated.length
        ? [...rated].sort((a, b) => Number(b.on_time_rate) - Number(a.on_time_rate))[0].name
        : null;
      reply = `\uD83D\uDED3 **Supplier Performance**\n\n${body}` +
              (best ? `\n\n\ud83d\udca1 Prefer **${best}** for urgent orders.` : '');
      actions = ['What should I order tomorrow?', 'Which product will run out soon?'];
    } else {
      const critCount = critical.length + lowStock.length;
      reply = `🙏 Namaste! I am TradeSaarthi, your supply chain assistant for **${store?.name || storeId}**.\n\nToday's snapshot:\n• ${critCount} products need reordering\n• Weekly sales: ${cur}${Math.round(weekRevenue).toLocaleString('en-IN')}\n• ${openOrders} pending purchase orders\n\nAsk me what is running out, what to order, or how your profit looks.`;
      actions = ['Which product will run out soon?', 'What should I order tomorrow?', 'Which product sold the most?', 'How much profit did I make?'];
    }

    res.json({ reply, actions });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CSV imports ───────────────────────────────────────────────────────────────
// Validate then commit, never a single "upload and write" call. The user sees
// per-row errors and a preview first, and the commit re-reads only the rows that
// passed validation, so fixing the file and re-uploading is the normal path.
app.get('/api/imports/types', requireAuth, requireStore, (req, res) => {
  res.json(Object.entries(imports.TEMPLATES).map(([key, spec]) => ({
    type: key,
    entity_type: imports.dbEntityType(key),
    label: spec.label,
    required_columns: spec.required,
    optional_columns: spec.optional,
  })));
});

// Serves the canonical CSV template so the UI never ships a second copy that
// can drift from what imports.js actually validates.
app.get('/api/imports/template/:type', requireAuth, requireStore, (req, res) => {
  const type = req.params.type;
  if (!imports.TEMPLATES[type])
    return res.status(404).json({ error: `Unknown import type "${type}".` });

  // type is already restricted to a known key above, so it cannot escape the
  // templates directory - no separate path check is needed.
  const file = path.join(__dirname, 'csv', 'templates', `${type}.csv`);
  if (!fs.existsSync(file))
    return res.status(404).json({ error: `No template file for "${type}".` });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${type}.csv"`);
  res.send(fs.readFileSync(file, 'utf8'));
});

app.post('/api/imports/validate', requireAuth, requireStore, async (req, res) => {
  try {
    const { type, fileName, content } = req.body;
    if (!content)
      return res.status(400).json({ error: 'File content is required.' });
    if (typeof content !== 'string')
      return res.status(400).json({ error: 'Send the file as text in "content".' });

    const ctx = await storeContext(req.storeId);
    const job = await imports.validate({
      // type is optional: omitted or "auto" means "work it out from the
      // headers". That is the default the dashboard uses, because naming the
      // type by hand is what allowed a transaction ledger to be committed as a
      // set of opening balances.
      type: type || 'auto', fileName, text: content,
      organizationId: ctx.organizationId, storeId: req.storeId, userId: req.user.id,
    });
    res.json({ ...job, message: job.errorCount
      ? `${job.valid} of ${job.total} rows are ready; ${job.errorCount} need attention.`
      : `All ${job.total} rows are ready to import as "${job.type}".` });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, code: err.code || null });
  }
});

app.get('/api/imports/:id', requireAuth, requireStore, async (req, res) => {
  try {
    const ctx = await storeContext(req.storeId);
    const job = await queryOne(
      'SELECT * FROM import_jobs WHERE id = ? AND organization_id = ? AND store_id = ?',
      [req.params.id, ctx.organizationId, req.storeId]);
    if (!job) return res.status(404).json({ error: 'Import not found' });

    const errors = await query(
      `SELECT row_no, column_name, raw_value, error_code, error_message
         FROM import_row_errors WHERE import_job_id = ? ORDER BY row_no, column_name`,
      [job.id]);

    let preview = null;
    if (job.preview_data) {
      const parsed = JSON.parse(job.preview_data);
      preview = { rows: parsed.rows || [], warnings: parsed.warnings || [] };
    }

    res.json({
      id: job.id, type: job.entity_type, file_name: job.file_name, status: job.status,
      total_rows: job.total_rows, valid_rows: job.valid_rows, error_rows: job.error_rows,
      created_rows: job.created_rows, updated_rows: job.updated_rows,
      error_message: job.error_message, can_commit: job.status === 'ready',
      preview, errors,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/imports/:id/commit', requireAuth, requireStore, async (req, res) => {
  try {
    const ctx = await storeContext(req.storeId);
    const result = await imports.commit({
      jobId: req.params.id, organizationId: ctx.organizationId,
      storeId: req.storeId, userId: req.user.id,
    });
    res.json({ success: true, ...result,
      message: `Imported ${result.created} new and updated ${result.updated} row(s).` });
  } catch (err) {
    // Mark the job failed so the history shows why it stopped, but only when the
    // failure was ours — a 409 (already committed / not ready) is a state the
    // job was already in.
    if (!err.status || err.status >= 500) {
      await run(`UPDATE import_jobs SET status = 'failed', error_message = ? WHERE id = ? AND status = 'committing'`,
        [String(err.message).slice(0, 500), req.params.id]).catch(() => {});
    }
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/imports', requireAuth, requireStore, async (req, res) => {
  try {
    const ctx = await storeContext(req.storeId);
    const rows = await query(
      `SELECT id, entity_type, file_name, status, total_rows, valid_rows, error_rows,
              created_rows, updated_rows, committed_at, created_at
         FROM import_jobs
        WHERE organization_id = ? AND store_id = ?
        ORDER BY id DESC LIMIT 50`,
      [ctx.organizationId, req.storeId]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Auth: Login ───────────────────────────────────────────────────────────────
const DUMMY_HASH = '$2b$10$abcdefghijklmnopqrstuuZq4vZq3sQ0eWJh1rXo9d2YyQ0p6J8uQm8Zi';

app.post('/api/login', throttleLogin, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password are required.' });

    const normalEmail = email.trim().toLowerCase();
    const key = attemptKey(normalEmail, req.ip);
    const user = await queryOne('SELECT * FROM users WHERE email = ?', [normalEmail]);

    // Same message and a bcrypt compare either way, so a wrong email cannot be
    // told apart from a wrong password by timing or by the response body.
    const storedHash = user?.password || DUMMY_HASH;
    const ok = await verifyPassword(password.trim(), storedHash) && !!user;
    if (!ok) {
      recordFailure(key);
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }
    if (user.provider !== 'email')
      return res.status(401).json({ error: 'This account signs in with Google/Microsoft. Use that button instead.' });

    clearFailures(key);
    if (needsRehash(storedHash)) {
      const upgraded = await hashPassword(password.trim());
      await run('UPDATE users SET password = ? WHERE id = ?', [upgraded, user.id]);
    }

    const store = await queryOne('SELECT * FROM stores WHERE store_id = ?', [user.store_id]);
    res.json(sessionPayload(user, store));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Auth: Signup (email/password) ─────────────────────────────────────────────
app.post('/api/signup', throttleLogin, async (req, res) => {
  try {
    const { name, email, password, businessType, phone, code } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'Name, email and password are required.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (!/[A-Z]/.test(password) || !/[0-9]/.test(password))
      return res.status(400).json({ error: 'Password must include an uppercase letter and a number.' });

    const normalEmail = email.trim().toLowerCase();

const existing = await queryOne('SELECT id FROM users WHERE email = ?', [normalEmail]);
    if (existing)
      return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });

    // Email ownership is proven before the account exists — the code was issued
    // for this address and consumed here, so it cannot be reused for another signup.
    const otp = await verifyCode({ email: normalEmail, code, purpose: OTP_PURPOSE.SIGNUP });
    if (!otp.verified) {
      const error = otp.reason === 'expired' ? 'That code has expired. Request a new one.'
                 : otp.reason === 'locked'  ? 'Too many incorrect attempts. Request a new code.'
                 : 'That verification code is not correct.';
      return res.status(400).json({ error });
    }

const passwordHash = await hashPassword(password);

// The whole workspace — organization, store, catalogue, opening stock and this
// account with its owner role — is created in one transaction. If any part of it
// fails, nothing is left behind, so a retry starts clean.
const { storeId, userId } = await provisionWorkspaceForUser({
  name, email: normalEmail, businessType, phone,
  passwordHash, provider: 'email', emailVerifiedAt: new Date(),
});

const user  = await queryOne('SELECT * FROM users WHERE id = ?', [userId]);
const store = await queryOne('SELECT * FROM stores WHERE store_id = ?', [storeId]);

res.status(201).json({ ...sessionPayload(user, store) });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY')
      return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });
    res.status(500).json({ error: err.message });
  }
});

// ── Auth: Firebase signup/login (Google, Microsoft) ──────────────────────────
// Called by frontend after Firebase popup succeeds. The caller must present a
// Firebase ID token — the email is read from the verified token, never from the
// request body, so this endpoint cannot be used to mint a session for any email.
app.post('/api/auth/firebase', throttleLogin, async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'idToken is required.' });

    let identity;
    try {
      identity = await verifyFirebaseIdToken(idToken);
    } catch (err) {
      return res.status(503).json({ error: err.message });
    }
    if (!identity)
      return res.status(401).json({ error: 'Invalid or expired Firebase token.' });

    const uid         = identity.uid;
    const normalEmail = identity.email.trim().toLowerCase();
    const name        = identity.name;
    const providerKey = identity.provider === 'microsoft.com' ? 'microsoft' : 'google';

    // A Firebase account that has already been used here always resolves by UID,
    // never by email — that is what makes repeat sign-ins stable even if the
    // email on the provider profile later changes.
    const byUid = await queryOne(
      `SELECT u.* FROM auth_identities ai
         JOIN users u ON u.id = ai.user_id
        WHERE ai.provider = ? AND ai.provider_uid = ?`, [providerKey, uid]);

    if (byUid) {
      await run('UPDATE auth_identities SET last_used_at = NOW() WHERE provider = ? AND provider_uid = ?',
        [providerKey, uid]);
      const store = await queryOne('SELECT * FROM stores WHERE store_id = ?', [byUid.store_id]);
      if (!store) return res.status(403).json({ error: 'No store is linked to this account.' });
      return res.json(sessionPayload(byUid, store));
    }

    // No identity yet. Linking by email is only safe when the provider says the
    // address is verified — otherwise anyone could register an unverified
    // lookalike address and inherit someone else's business data.
    const userByEmail = await queryOne('SELECT * FROM users WHERE email = ?', [normalEmail]);
    if (userByEmail && !identity.email_verified) {
      return res.status(403).json({
        error: 'This Google/Microsoft account has an unverified email address, ' +
               'so it cannot be linked to your existing SupplyIQ account. ' +
               'Verify the address with the provider and try again, or sign in with your email and password.',
      });
    }

    // One unified user row: reuse the existing account on a verified email,
    // create a new one only when this address has never been seen.
    let user = userByEmail;

    if (!user) {
      const created = await provisionWorkspaceForUser({
        name, email: normalEmail, businessType: null, phone: null,
        passwordHash: null, provider: providerKey, firebaseUid: uid,
        emailVerifiedAt: identity.email_verified ? new Date() : null,
      });
      user = await queryOne('SELECT * FROM users WHERE id = ?', [created.userId]);
    }

    // Record the external identity. The unique key on (provider, provider_uid)
    // makes this the duplicate guard: one Firebase account resolves to exactly
    // one row, and one provider per user per row.
    await run(
      `INSERT INTO auth_identities
         (user_id, provider, provider_uid, email_at_provider, email_verified, last_used_at)
       VALUES (?,?,?,?,?,NOW())
       ON DUPLICATE KEY UPDATE last_used_at = NOW()`,
      [user.id, providerKey, uid, normalEmail, identity.email_verified ? 1 : 0]);

    // Keep the fast-path columns in step for the current session. The provider
    // column is only relabelled when the account has no password at all —
    // overwriting it for a password account would make /api/login start refusing
    // that user and lock them out of their own password.
    if (user.provider !== providerKey || user.firebase_uid !== uid) {
      await run(
        user.password
          ? 'UPDATE users SET firebase_uid = ? WHERE id = ?'
          : 'UPDATE users SET firebase_uid = ?, provider = ? WHERE id = ?',
        user.password ? [uid, user.id] : [uid, providerKey, user.id]);
      user = await queryOne('SELECT * FROM users WHERE id = ?', [user.id]);
    }

    // Every user now owns a store, so a missing store_id means a broken account
    // rather than a reason to silently fall back to a shared one.
    if (!user.store_id)
      return res.status(403).json({ error: 'No store is linked to this account.' });

    const store = await queryOne('SELECT * FROM stores WHERE store_id = ?', [user.store_id]);

    res.json(sessionPayload(user, store));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Auth: Me (validate token) ─────────────────────────────────────────────────
app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const store = await queryOne('SELECT * FROM stores WHERE store_id = ?', [req.user.store_id]);
    const permissions = await permissionsFor(req.user.id, req.user.store_id);
    res.json({
      success:   true,
      email:     req.user.email,
      name:      req.user.name,
      storeId:   req.user.store_id,
      storeName: store?.name || req.user.store_id,
      provider:  req.user.provider,
      permissions,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Dev: reseed ───────────────────────────────────────────────────────────────
app.post('/api/dev/reseed', requireAuth, async (req, res) => {
  res.json({
    success: true,
    message: 'Run: node backend/seed-mysql.js to reseed inventory/sales/orders, and node backend/seed-users.js to reset demo passwords.',
  });
});

// ── Email OTP ─────────────────────────────────────────────────────────────────
// /otp/send is throttled and only ever mails the address that is being registered
// or reset, so it cannot be used as an open relay.
app.post('/api/otp/send', throttleLogin, async (req, res) => {
  const { email, purpose } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!Object.values(OTP_PURPOSE).includes(purpose))
    return res.status(400).json({ error: 'Unknown purpose.' });

  const normalEmail = email.trim().toLowerCase();
  const existing = await queryOne('SELECT id, name FROM users WHERE email = ?', [normalEmail]);

  // Always answer the same way regardless of whether the account exists, so these
  // endpoints cannot be used to enumerate registered users.
  const generic = { success: true, message: 'If that address can receive a code, one has been sent.' };

  if (purpose === OTP_PURPOSE.SIGNUP && existing)
    return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });
  if (purpose === OTP_PURPOSE.RESET && !existing)
    return res.json(generic);

  try {
    const result = await sendCode({ email: normalEmail, purpose, userName: existing?.name });
    if (!result.ok) {
      const retryAfter = result.retryAfter || 60;
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: result.reason === 'hourly_limit'
          ? `Too many codes requested. Try again in ${Math.ceil(retryAfter / 60)} minutes.`
          : `Please wait ${retryAfter} seconds before requesting another code.`,
      });
    }
    // Local development convenience only: with SMTP unset the code is logged so
    // the flow stays testable. This must never happen in production.
    if (result.code && process.env.NODE_ENV !== 'production') {
      console.log(`\x1b[33m📮 OTP for ${normalEmail} (${purpose}): ${result.code}\x1b[0m`);
      if (process.env.NODE_ENV !== 'production' && !process.env.SMTP_HOST)
        return res.json({ ...generic, devCode: result.code });
    }
    res.json(generic);
  } catch (err) {
    console.error('OTP send failed:', err.message);
    res.status(500).json({ error: 'Could not send the verification code. Please try again.' });
  }
});

app.post('/api/otp/verify', throttleLogin, async (req, res) => {
  const { email, code, purpose } = req.body;
  if (!email || !code)
    return res.status(400).json({ error: 'Email and code are required.' });
  if (!Object.values(OTP_PURPOSE).includes(purpose))
    return res.status(400).json({ error: 'Unknown purpose.' });

  const result = await verifyCode({ email, code, purpose });
  if (result.verified) return res.json({ success: true, verified: true });

  const error = result.reason === 'expired'   ? 'That code has expired. Request a new one.'
             : result.reason === 'locked'    ? 'Too many incorrect attempts. Request a new code.'
             : 'That code is not correct.';
  res.status(400).json({ error });
});

// Password reset runs entirely on our own OTP: the code proves control of the
// mailbox, then the password is replaced and the OTP is consumed.
app.post('/api/password/reset', throttleLogin, async (req, res) => {
  const { email, code, newPassword } = req.body;
  if (!email || !code || !newPassword)
    return res.status(400).json({ error: 'Email, code and new password are required.' });
  if (newPassword.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (!/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword))
    return res.status(400).json({ error: 'Password must include an uppercase letter and a number.' });

  const normalEmail = email.trim().toLowerCase();
  const result = await verifyCode({ email: normalEmail, code, purpose: OTP_PURPOSE.RESET });
  if (!result.verified) {
    const error = result.reason === 'expired'  ? 'That code has expired. Request a new one.'
               : result.reason === 'locked'   ? 'Too many incorrect attempts. Request a new code.'
               : 'That code is not correct.';
    return res.status(400).json({ error });
  }

  const user = await queryOne('SELECT id FROM users WHERE email = ?', [normalEmail]);
  if (!user) return res.status(400).json({ error: 'That code is not correct.' });

  await run('UPDATE users SET password = ? WHERE id = ?', [await hashPassword(newPassword), user.id]);
  await clearCodes(normalEmail, OTP_PURPOSE.RESET);

  res.json({ success: true, message: 'Password updated. You can now sign in.' });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
// Body-parser failures happen before any route runs, so without this they reach
// the browser as an HTML error page with a bare status code. The client cannot
// read that, which is how an oversized CSV looked like a silent failure.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    const isImport = req.path === '/api/imports/validate';
    const cap = isImport ? MAX_IMPORT_BYTES : 1024 * 1024;
    return res.status(413).json({
      error: isImport
        ? `That file is too large to upload (limit ${(cap / 1024 / 1024).toFixed(0)} MB). Split it into smaller CSVs, or raise MAX_IMPORT_BYTES on the server.`
        : 'That request was too large (limit 1 MB).',
      code: 'payload_too_large',
      limitBytes: cap,
    });
  }
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ error: 'Malformed request body.', code: 'bad_json' });
  }
  console.error('unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error.' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 SupplyIQ Backend (MySQL)  →  http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health`);
  console.log(`   DB:     supplyiq @ localhost:3306`);
});
// Also listen on IPv6 (::) so `localhost` resolves correctly on dual-stack systems
try {
  const server6 = app.listen(PORT, '::', () => {
    console.log(`   IPv6:   http://[::1]:${PORT}/api/health`);
  });
  server6.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') console.error('IPv6 server error:', err);
  });
} catch (e) {
  console.log('   IPv6:   not available on this system');
}
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌  Port ${PORT} is already in use. Run: npx kill-port ${PORT}\n`);
    process.exit(1);
  } else { throw err; }
});

module.exports = app;
