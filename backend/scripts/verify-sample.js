/**
 * verify-sample.js — integrity checks that only make sense once data exists.
 *
 *   node backend/scripts/verify-sample.js
 *
 * verify-schema.js proves the *shape* of the database is right. This proves the
 * data written into it is internally consistent:
 *
 *   1. inventory.quantity is exactly the sum of its stock_movements
 *      (the projection has not drifted from the ledger),
 *   2. no row claims an organization that disagrees with its own store,
 *   3. no purchase order is marked received with items still outstanding,
 *   4. purchase order headers agree with their item totals.
 *
 * Exits non-zero on the first failed invariant so it can gate a deploy.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const { query, queryOne, getPool } = require('../mysql');

const results = [];

function check(name, rows, describe) {
  const failed = rows.length;
  results.push({ check: name, result: failed === 0 ? 'PASS' : `FAIL (${failed})`, detail: failed === 0 ? describe(rows) : JSON.stringify(rows.slice(0, 5)) });
}

(async () => {
  console.log('Verifying sample data integrity…\n');

  // 1. Ledger vs projection. A mismatch means some route updated inventory
  //    without posting a movement, which is the one thing stock.js exists to stop.
  const drift = await query(`
    SELECT i.store_id, i.sku, i.quantity AS inventory_qty,
           COALESCE(SUM(CASE WHEN m.direction = 'IN' THEN m.quantity ELSE -m.quantity END), 0) AS ledger_qty
      FROM inventory i
      LEFT JOIN stock_movements m
             ON m.product_id = i.product_id AND m.store_id = i.store_id
     GROUP BY i.id, i.store_id, i.sku, i.quantity
    HAVING inventory_qty <> ledger_qty`);
  check('inventory matches stock ledger', drift, () => 'every projected quantity equals IN minus OUT');

  // 2. Tenant consistency. organization_id is denormalised alongside store_id on
  //    purpose (so reports can filter on one column), which means it can disagree.
  const tenant = await query(`
    SELECT 'inventory' AS tbl, i.id, i.organization_id, s.organization_id AS store_org
      FROM inventory i JOIN stores s ON s.store_id = i.store_id
     WHERE i.organization_id <> s.organization_id
    UNION ALL
    SELECT 'sales', x.id, x.organization_id, s.organization_id
      FROM sales x JOIN stores s ON s.store_id = x.store_id
     WHERE x.organization_id <> s.organization_id
    UNION ALL
    SELECT 'stock_movements', m.id, m.organization_id, s.organization_id
      FROM stock_movements m JOIN stores s ON s.store_id = m.store_id
     WHERE m.organization_id <> s.organization_id
    UNION ALL
    SELECT 'purchase_orders', p.id, p.organization_id, s.organization_id
      FROM purchase_orders p JOIN stores s ON s.store_id = p.store_id
     WHERE p.organization_id <> s.organization_id
    UNION ALL
    SELECT 'store_members', sm.id, sm.organization_id, s.organization_id
      FROM store_members sm JOIN stores s ON s.store_id = sm.store_id
     WHERE sm.organization_id <> s.organization_id`);
  check('organization_id agrees with store', tenant, () => 'no cross-tenant row is reachable');

  // 3. A received PO must be fully received.
  const badStatus = await query(`
    SELECT po.po_no, po.status, SUM(pi.quantity) AS ordered, SUM(pi.received_qty) AS received
      FROM purchase_orders po JOIN purchase_order_items pi ON pi.purchase_order_id = po.id
     WHERE po.status = 'received'
     GROUP BY po.id, po.po_no, po.status
    HAVING ordered <> received`);
  check('received POs are fully received', badStatus, () => 'status only says received when every line is complete');

// 4. Header money must equal the sum of its lines.
  const badTotals = await query(`
    SELECT po.po_no, po.total_amount, SUM(pi.line_total) AS lines_total
      FROM purchase_orders po JOIN purchase_order_items pi ON pi.purchase_order_id = po.id
     GROUP BY po.id, po.po_no, po.total_amount
    HAVING ABS(po.total_amount - SUM(pi.line_total)) > 0.01`);
  check('PO total matches line totals', badTotals, () => 'header amount equals the sum of its lines');

  // 5. The inverse of check 3, and the one that actually caught a bug: a PO whose
  //    lines are fully received but whose header still says draft/approved/ordered.
  //    That state means the receipt committed its stock and its line updates but
  //    not its status change, so the document disagrees with reality.
  const stuckStatus = await query(`
    SELECT po.po_no, po.status, SUM(pi.quantity) AS ordered, SUM(pi.received_qty) AS received
      FROM purchase_orders po JOIN purchase_order_items pi ON pi.purchase_order_id = po.id
     WHERE po.status IN ('draft','pending_approval','approved','ordered')
     GROUP BY po.id, po.po_no, po.status
    HAVING received > 0`);
  check('received lines agree with PO status', stuckStatus,
    () => 'no PO has stock received while still sitting in a pre-receipt status');

  console.table(results);

  const failed = results.filter(r => r.result !== 'PASS');
  if (failed.length) {
    console.error(`\n${failed.length} integrity check(s) failed.`);
    await getPool().end();
    process.exit(1);
  }

  const counts = {};
  for (const t of ['organizations', 'stores', 'users', 'products', 'suppliers', 'stock_movements',
                   'sales', 'purchase_orders', 'supplier_performance']) {
    counts[t] = (await queryOne(`SELECT COUNT(*) n FROM \`${t}\``)).n;
  }
  console.log('\nRow counts:', JSON.stringify(counts, null, 2));
  console.log('All integrity checks passed.');
  await getPool().end();
})().catch(async (err) => {
  console.error('Verification failed:', err.message);
  try { await getPool().end(); } catch { /* pool never opened */ }
  process.exit(1);
});