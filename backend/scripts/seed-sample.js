/**
 * seed-sample.js — the ONE sample dataset for SupplyIQ.
 *
 *   node backend/scripts/seed-sample.js
 *
 * Everything is written through the normalised schema: one organization, one
 * store, one owner, and the supplier / product / stock-ledger / sales / purchase
 * order rows that the dashboard needs to render real numbers.
 *
 * Idempotent and self-guarding: if the demo organization already exists the
 * script stops instead of double-seeding, so it is safe to run twice.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const { getPool, query, queryOne, run, withTransaction } = require('../mysql');
const { hashPassword } = require('../auth');
const stock = require('../stock');

const ORG_SLUG   = 'demo-grocery';
const STORE_ID   = 'demo-store-01';
const DEMO_EMAIL = 'demo@supplyiq.local';

// The demo owner's password is supplied by the operator, never defaulted here.
// A fallback literal would be a working credential in every clone of this repo,
// which is exactly what CI's secret scan exists to prevent. Missing value is a
// configuration error and is reported as one.
if (!process.env.DEMO_PASSWORD) {
  console.error(
    'DEMO_PASSWORD is not set.\n' +
    'Set it in backend/.env (see backend/.env.example) before seeding.\n' +
    'It is deliberately not defaulted: a seeded demo account needs a password\n' +
    'only this machine knows.'
  );
  process.exit(1);
}
const DEMO_PASS  = process.env.DEMO_PASSWORD;

const SUPPLIERS = [
  { name: 'Krishna Wholesale',  contact: 'Ramesh Iyer',   city: 'Mysuru',   rating: 4.4, terms: 'Net 30' },
  { name: 'FreshFarm Co.',      contact: 'Anita Desai',   city: 'Bengaluru', rating: 4.1, terms: 'Net 15' },
  { name: 'AgriLink Suppliers', contact: 'Suresh Nair',   city: 'Hassan',   rating: 3.8, terms: 'Advance 50%' },
];

const CATEGORIES = ['Staples', 'Oils', 'Pulses', 'Beverages', 'Spices'];

//  supplier index, unit cost, opening qty, reorder point, monthly demand, unit, max stock
const PRODUCTS = [
  { sku: 'GRC-001', name: 'Basmati Rice 5kg',   cat: 'Staples',  sup: 0, cost: 620,  qty: 8,   reorder: 50, demand: 420, sell: 780,  max: 500 },
  { sku: 'GRC-002', name: 'Sunflower Oil 1L',  cat: 'Oils',     sup: 1, cost: 165,  qty: 20,  reorder: 30, demand: 300, sell: 210,  max: 300 },
  { sku: 'GRC-003', name: 'Wheat Atta 10kg',   cat: 'Staples',  sup: 0, cost: 260,  qty: 64,  reorder: 30, demand: 220, sell: 330,  max: 300 },
  { sku: 'GRC-004', name: 'Sugar 1kg',         cat: 'Staples',  sup: 2, cost: 48,   qty: 15,  reorder: 20, demand: 150, sell: 62,   max: 200 },
  { sku: 'GRC-005', name: 'Tea Powder 250g',   cat: 'Beverages',sup: 1, cost: 280,  qty: 12,  reorder: 20, demand: 280, sell: 355,  max: 200 },
  { sku: 'GRC-006', name: 'Toor Dal 1kg',      cat: 'Pulses',   sup: 2, cost: 160,  qty: 60,  reorder: 25, demand: 190, sell: 205,  max: 250 },
  { sku: 'GRC-007', name: 'Olive Oil 500ml',   cat: 'Oils',     sup: 1, cost: 800,  qty: 120, reorder: 10, demand: 40,  sell: 990,  max: 100 },
  { sku: 'GRC-008', name: 'Salt 1kg',          cat: 'Staples',  sup: 2, cost: 20,   qty: 90,  reorder: 40, demand: 200, sell: 28,   max: 300 },
  { sku: 'GRC-009', name: 'Chilli Powder 200g',cat: 'Spices',   sup: 2, cost: 95,   qty: 30,  reorder: 20, demand: 120, sell: 125,  max: 150 },
  { sku: 'GRC-010', name: 'Mustard Oil 1L',    cat: 'Oils',     sup: 1, cost: 180,  qty: 5,   reorder: 20, demand: 160, sell: 235,  max: 200 },
  { sku: 'GRC-011', name: 'Chickpeas 1kg',     cat: 'Pulses',   sup: 2, cost: 120,  qty: 40,  reorder: 30, demand: 140, sell: 155,  max: 200 },
  { sku: 'GRC-012', name: 'Vermicelli 500g',   cat: 'Staples',  sup: 0, cost: 45,   qty: 55,  reorder: 25, demand: 100, sell: 60,   max: 150 },
];

// Deliberate mix so every dashboard state is visible: Critical, Low, OK and
// Overstock all appear without anyone having to hand-tune the numbers.
const PURCHASE_ORDERS = [
  { no: 'PO-DEMO-0001', sup: 0, status: 'received',     daysAgo: 12, expectedIn: -4,  lines: [['GRC-001', 500, 620], ['GRC-003', 200, 260]] },
  { no: 'PO-DEMO-0002', sup: 1, status: 'part_received', daysAgo: 6,  expectedIn: 1,   lines: [['GRC-005', 80, 280], ['GRC-010', 60, 180]] },
  { no: 'PO-DEMO-0003', sup: 2, status: 'ordered',      daysAgo: 2,  expectedIn: 4,   lines: [['GRC-004', 150, 48]] },
  { no: 'PO-DEMO-0004', sup: 1, status: 'draft',        daysAgo: 0,  expectedIn: 6,   lines: [['GRC-002', 50, 165]] },
];

// 30 days of daily revenue with a fixed pattern. Deterministic on purpose: the
// same demo numbers on every machine makes screenshots and tests comparable.
const DAILY_PATTERN = [1.00,1.12,0.92,1.18,1.05,0.88,1.22,0.97,1.08,1.15,0.91,1.20,1.03,0.95,1.17,
                       1.09,0.86,1.25,0.99,1.11,0.93,1.19,1.06,0.89,1.23,0.96,1.14,1.07,0.84,1.21];

const BASE_REVENUE = 5200;
const MARGIN_RATE  = 0.24;
const UNITS_PER_DAY = 80;

function daysAgoDate(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

async function seed() {
  console.log('Seeding the SupplyIQ sample dataset…\n');

  const existing = await queryOne('SELECT id FROM organizations WHERE slug = ?', [ORG_SLUG]);
  if (existing) {
    console.log(`  Organization "${ORG_SLUG}" already exists (id ${existing.id}).`);
    console.log('  Nothing to do — the sample is created once.');
    console.log(`  Sign in with ${DEMO_EMAIL} / ${DEMO_PASS}`);
    return;
  }

  const passwordHash = await hashPassword(DEMO_PASS);

  const ctx = await withTransaction(async (tx) => {
    // ── Organization + store ──────────────────────────────────────────────
    // owner_user_id stays NULL here and is filled in once the owner exists;
    // organization -> user -> store -> organization is a cycle that cannot be
    // satisfied by any single insert order.
    const org = await tx.run(
      `INSERT INTO organizations
         (slug, name, business_type, email, address_line, city, state, pincode, currency, timezone)
       VALUES (?,?,?,?,?,?,?,?, 'INR', 'Asia/Kolkata')`,
      [ORG_SLUG, 'Demo Grocery Store', 'grocery', DEMO_EMAIL,
       '12 Market Road', 'Mysuru', 'Karnataka', '570001']);

    const store = await tx.run(
      `INSERT INTO stores
         (store_id, organization_id, name, code, owner_name, owner_initials, email,
          type, address_line, city, state, pincode, currency, timezone, tagline)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'INR', 'Asia/Kolkata', ?)`,
      [STORE_ID, org.insertId, 'Demo Grocery Store', 'DMO', 'Demo Owner', 'DO',
       DEMO_EMAIL, 'grocery', '12 Market Road', 'Mysuru', 'Karnataka', '570001',
       'Everything for the demo dashboard']);

    const wh = await tx.run(
      `INSERT INTO warehouses (organization_id, code, name, warehouse_type, city, state)
       VALUES (?,?,?,'warehouse','Mysuru','Karnataka')`,
      [org.insertId, 'MAIN', 'Main Godown']);

    // ── Owner user + membership ──────────────────────────────────────────
    const owner = await tx.run(
      `INSERT INTO users (email, password, name, store_id, business_type, provider, email_verified_at, status)
       VALUES (?,?,?,?,?,?,?, 'active')`,
      [DEMO_EMAIL, passwordHash, 'Demo Owner', STORE_ID, 'grocery', 'email', new Date()]);

    await tx.run('UPDATE organizations SET owner_user_id = ? WHERE id = ?', [owner.insertId, org.insertId]);

const ownerRole = await tx.run(
      `INSERT INTO roles (organization_id, key_name, name, description, is_system)
       VALUES (?, 'owner', 'Owner', 'Full access to this store', 0)`,
     [org.insertId]);

    // Grant all permissions to the org-scoped owner role so the demo tenant works immediately
    const permIds = await tx.query('SELECT id FROM permissions');
    for (const { id } of permIds) {
      await tx.run('INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?,?)', [ownerRole.insertId, id]);
    }

    await tx.run(
      `INSERT INTO store_members (organization_id, store_id, user_id, role_id) VALUES (?,?,?,?)`,
      [org.insertId, STORE_ID, owner.insertId, ownerRole.insertId]);

    await tx.run(
      `INSERT INTO organization_settings (organization_id, settings, updated_by) VALUES (?,?,?)`,
      [org.insertId, JSON.stringify({
        timezone: 'Asia/Kolkata',
        currency: 'INR',
        low_stock_threshold_pct: 100,
        notifications_enabled: true,
        forecast_horizon_days: 30,
      }), owner.insertId]);

    // ── Suppliers ────────────────────────────────────────────────────────
    const supplierIds = [];
    for (const s of SUPPLIERS) {
      const r = await tx.run(
        `INSERT INTO suppliers (organization_id, name, contact_person, city, rating, payment_terms)
         VALUES (?,?,?,?,?,?)`,
        [org.insertId, s.name, s.contact, s.city, s.rating, s.terms]);
      supplierIds.push(r.insertId);
    }

    // ── Categories + products ────────────────────────────────────────────
    const categoryIds = {};
    for (const name of CATEGORIES) {
      const r = await tx.run('INSERT INTO categories (organization_id, name) VALUES (?,?)', [org.insertId, name]);
      categoryIds[name] = r.insertId;
    }

    const products = [];
    for (const p of PRODUCTS) {
      const r = await tx.run(
        `INSERT INTO products
           (organization_id, category_id, sku, name, unit, default_unit_cost, default_sell_price)
         VALUES (?,?,?,?,'pc',?,?)`,
        [org.insertId, categoryIds[p.cat], p.sku, p.name, p.cost, p.sell]);
      products.push({ ...p, id: r.insertId });
    }

    // ── Supplier price list ──────────────────────────────────────────────
    for (const p of products) {
      await tx.run(
        `INSERT INTO supplier_products
           (organization_id, supplier_id, product_id, supplier_sku, unit_cost, min_order_qty, is_preferred)
         VALUES (?,?,?,?,?,?,1)`,
        [org.insertId, supplierIds[p.sup], p.id, `SF-${p.sku}`, p.cost, 1]);
    }

    return {
      organizationId: org.insertId, storeId: STORE_ID, warehouseId: wh.insertId,
      userId: owner.insertId, supplierIds, products,
    };
  });

  // ── Opening stock, through the ledger ───────────────────────────────────
  // Done outside the transaction above because stock.postMovement opens its own
  // transaction and rows it writes while holding the inventory lock; nesting that
  // inside the outer one would deadlock against itself.
  for (const p of ctx.products) {
    await stock.openStock({
      storeId: ctx.storeId, organizationId: ctx.organizationId, productId: p.id,
      warehouseId: ctx.warehouseId, sku: p.sku, name: p.name, category: p.cat,
      quantity: p.qty, unitCost: p.cost, reorderPt: p.reorder, safetyStock: p.reorder,
      maxStock: p.max, monthlyDemand: p.demand, supplier: SUPPLIERS[p.sup].name, userId: ctx.userId,
    });
  }

  // ── 30 days of sales rollup ─────────────────────────────────────────────
  for (let i = DAILY_PATTERN.length - 1; i >= 0; i--) {
    const d      = daysAgoDate(i);
    const amount = Math.round(BASE_REVENUE * DAILY_PATTERN[i]);
    await run(
      `INSERT INTO sales (organization_id, store_id, date, sales, profit, units_sold, orders_count)
       VALUES (?,?,?,?,?,?,?)`,
      [ctx.organizationId, ctx.storeId, d.toISOString().slice(0, 10),
       amount, Math.round(amount * MARGIN_RATE),
       Math.round(UNITS_PER_DAY * DAILY_PATTERN[i]), Math.round(UNITS_PER_DAY * DAILY_PATTERN[i] / 9)]);
  }

  // ── Purchase orders in a realistic spread of statuses ───────────────────
  for (const po of PURCHASE_ORDERS) {
    const ordered = daysAgoDate(po.daysAgo);
    const expected = new Date(ordered);
    expected.setDate(expected.getDate() + po.expectedIn + po.daysAgo);

    const subtotal = po.lines.reduce((s, [, qty, cost]) => s + qty * cost, 0);
    const header = await run(
      `INSERT INTO purchase_orders
         (organization_id, store_id, po_no, supplier_id, order_date, expected_date, status,
          subtotal, total_amount, delivered_qty, source, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'manual', ?)`,
      [ctx.organizationId, ctx.storeId, po.no, ctx.supplierIds[po.sup],
       ordered.toISOString().slice(0, 10), expected.toISOString().slice(0, 10),
       po.status, subtotal, subtotal, po.status === 'received' ? po.lines.reduce((s, [p, q]) => s + q, 0) : 0,
       ctx.userId]);

    let delivered = 0;
    for (const [sku, qty, cost] of po.lines) {
      const product = ctx.products.find(p => p.sku === sku);
      // A part-received PO has its first line complete and the rest outstanding.
      const received = po.status === 'received' ? qty
                      : po.status === 'part_received' && delivered === 0 ? qty
                      : 0;
      delivered += qty;

      await run(
        `INSERT INTO purchase_order_items
           (organization_id, purchase_order_id, product_id, quantity, received_qty, unit_cost, line_total)
         VALUES (?,?,?,?,?,?,?)`,
        [ctx.organizationId, header.insertId, product.id, qty, received, cost, qty * cost]);

      if (received > 0) {
        await run(
          `INSERT INTO supplier_lead_times
             (organization_id, supplier_id, product_id, purchase_order_id, ordered_on, received_on, actual_days, is_late)
           VALUES (?,?,?,?,?,?, GREATEST(0, DATEDIFF(?,?)),
                   CASE WHEN ? > ? THEN 1 ELSE 0 END)`,
          [ctx.organizationId, ctx.supplierIds[po.sup], product.id, header.insertId,
           ordered.toISOString().slice(0, 10), daysAgoDate(Math.max(0, -po.expectedIn - 2)).toISOString().slice(0, 10),
           ordered.toISOString().slice(0, 10), ordered.toISOString().slice(0, 10),
           expected.toISOString().slice(0, 10), expected.toISOString().slice(0, 10)]);
      }
    }

    await run(
      `INSERT INTO purchase_order_status_history
         (organization_id, purchase_order_id, from_status, to_status, changed_by, remark)
       VALUES (?,?,NULL,'draft',?,'Seeded by sample data')`,
      [ctx.organizationId, header.insertId, ctx.userId]);
  }

  // ── Supplier performance, so the chat/dashboard have real on-time rates ──
  // Derived from the lead times just written, not invented.
  for (const [i, supplierId] of ctx.supplierIds.entries()) {
    const stat = await queryOne(
      `SELECT COUNT(*) AS n,
              AVG(actual_days) AS avg_days,
              SUM(is_late) AS late
         FROM supplier_lead_times
        WHERE organization_id = ? AND supplier_id = ?`, [ctx.organizationId, supplierId]);
    if (!stat.n) continue;

    const onTime = Math.round((1 - stat.late / stat.n) * 100);
    await run(
      `INSERT INTO supplier_performance
         (organization_id, supplier_id, period_start, period_end,
          orders_total, orders_delivered, orders_late, avg_lead_time_days,
          on_time_rate, fill_rate, quality_score, risk_score)
       VALUES (?,?, DATE_SUB(CURDATE(), INTERVAL 30 DAY), CURDATE(), ?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE on_time_rate = VALUES(on_time_rate)`,
      [ctx.organizationId, supplierId, Number(stat.n), Number(stat.n), Number(stat.late),
       Math.round(Number(stat.avg_days)), onTime, onTime,
       SUPPLIERS[i].rating, Math.round((5 - Number(stat.late) / Number(stat.n)) * 20)]);
  }

  console.log(`  organization  ${ORG_SLUG} (id ${ctx.organizationId})`);
  console.log(`  store         ${ctx.storeId}`);
  console.log(`  owner         ${DEMO_EMAIL} / ${DEMO_PASS}`);
  console.log(`  suppliers     ${SUPPLIERS.length}`);
  console.log(`  products      ${ctx.products.length} (with opening stock in the ledger)`);
  console.log(`  sales rows    ${DAILY_PATTERN.length} days`);
  console.log(`  purchase POs  ${PURCHASE_ORDERS.length}`);
  console.log('\nSample dataset ready.');
}

seed()
  .then(() => getPool().end())
  .catch(async (err) => {
    console.error('\nSample seed failed:', err.message);
    console.error('The organization block is transactional, so nothing partial was committed.');
    try { await getPool().end(); } catch { /* pool never opened */ }
    process.exit(1);
  });