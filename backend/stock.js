/**
 * stock.js — the only writer of stock quantities.
 *
 * Rule: `inventory.quantity` is a projection of `stock_movements`, and the two
 * are always written together inside one transaction. A ledger row without the
 * matching inventory update (or the reverse) would make the "what arrived, what
 * was sold, what remains" answer lie, so no route is allowed to update
 * `inventory.quantity` directly.
 *
 * Negative stock is prevented twice: the inventory row is locked FOR UPDATE
 * before the arithmetic, and a CHECK constraint on inventory.quantity is the
 * final backstop if a caller ever gets this wrong.
 */
const { withTransaction, query, queryOne } = require('./mysql');

/** status buckets used by the dashboard. Kept identical to the existing UI. */
function computeStatus(qty, reorderPt, maxStock) {
  const q = Number(qty), r = Number(reorderPt);
  if (q <= 0)                  return 'Critical';
  if (r > 0 && q < r * 0.3)    return 'Critical';
  if (r > 0 && q < r)          return 'Low';
  if (maxStock > 0 && q > maxStock) return 'Overstock';
  if (maxStock > 0 && q > r * 8)   return 'Overstock';
  return 'OK';
}

const REASONS = {
  IN:  ['purchase', 'return', 'opening', 'import', 'adjustment'],
  OUT: ['sale', 'damage', 'expiry', 'lost', 'transfer', 'adjustment'],
};

/**
 * Post one stock movement and apply it to the inventory projection.
 *
 * @param {object}  p
 * @param {string}  p.storeId
 * @param {number}  p.organizationId
 * @param {number}  p.productId
 * @param {'IN'|'OUT'} p.direction
 * @param {number}  p.quantity   must be > 0
 * @param {string}  p.reason     must be allowed for that direction
 * @param {number} [p.unitCost]  required for IN, keeps the moving average sane
 * @param {string} [p.invoiceNo] bill/invoice this movement belongs to, stored as
 *                                 data in stock_movements.invoice_no rather than
 *                                 folded into the free-text note
 * @param {string} [p.note]
 * @param {number} [p.userId]    who did it, for the audit trail
 * @param {string} [p.referenceType] / [p.referenceId]  links back to the document
 * @param {Date}   [p.occurredAt]  business timestamp; defaults to now
 * @param {object} [p.tx]          reuse an open transaction instead of starting
 *                                  one. Callers that write several documents at
 *                                  once (PO receipt, provisioning) pass their
 *                                  executor so the whole unit commits or rolls
 *                                  back together; opening a second transaction
 *                                  here would deadlock against the rows the outer
 *                                  transaction already holds.
 */
async function postMovement({
  storeId, organizationId, productId, direction, quantity, reason,
  unitCost, invoiceNo, note, userId, referenceType, referenceId, occurredAt, tx: givenTx,
}) {
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0)
    throw Object.assign(new Error('Quantity must be a number greater than zero.'), { status: 400 });
  if (!REASONS[direction] || !REASONS[direction].includes(reason))
    throw Object.assign(
      new Error(`reason "${reason}" is not valid for a ${direction} movement.`), { status: 400 });

  const apply = async (tx) => {
    // Lock the row so two concurrent receipts cannot both read the old balance.
    const item = await tx.queryOne(
      `SELECT id, sku, name, quantity, unit_cost, reorder_pt, max_stock, warehouse_id
         FROM inventory WHERE store_id = ? AND product_id = ? FOR UPDATE`,
      [storeId, productId]);
    if (!item)
      throw Object.assign(new Error('This product is not stocked in this store.'), { status: 404 });

    const current = Number(item.quantity);
    const balance = direction === 'IN' ? current + qty : current - qty;
    if (balance < 0)
      throw Object.assign(
        new Error(`Not enough stock for ${item.name}. Available: ${current}, requested: ${qty}.`),
        { status: 400 });

    // Moving average cost: an IN raises the average, an OUT leaves it alone.
    let newUnitCost = Number(item.unit_cost);
    if (direction === 'IN' && Number(unitCost) > 0) {
      const heldValue = current * newUnitCost;
      newUnitCost = (heldValue + qty * Number(unitCost)) / (current + qty);
    }

    const cost = direction === 'IN' ? (Number(unitCost) || newUnitCost) : newUnitCost;
    const status = computeStatus(balance, item.reorder_pt, item.max_stock);

    await tx.run(
      `INSERT INTO stock_movements
         (organization_id, store_id, product_id, warehouse_id, direction, quantity,
          balance_after, unit_cost, reason, invoice_no, reference_type, reference_id,
          occurred_at, note, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [organizationId, storeId, productId, item.warehouse_id, direction, qty,
       balance, Number(cost.toFixed(2)), reason,
       // Trimmed to the column width rather than rejected: an invoice is a
       // reference, not a reason to fail a stock movement that is otherwise
       // valid, and a longer bill number still identifies the document.
       invoiceNo ? String(invoiceNo).trim().slice(0, 60) || null : null,
       referenceType || null, referenceId || null,
       occurredAt || new Date(), note || null, userId || null]);

    await tx.run(
      `UPDATE inventory
          SET quantity = ?, unit_cost = ?, status = ?, updated_at = NOW()
        WHERE id = ?`,
      [balance, Number(newUnitCost.toFixed(2)), status, item.id]);

    // Keep the product master in step so catalogue reports are not stale.
    await tx.run(
      'UPDATE products SET default_unit_cost = ?, default_sell_price = GREATEST(default_sell_price, ?) WHERE id = ?',
      [Number(newUnitCost.toFixed(2)), cost, productId]);

    return { sku: item.sku, name: item.name, quantity: qty, balance, status };
  };

  return givenTx ? apply(givenTx) : withTransaction(apply);
}

/** Opening quantity for a brand-new inventory row. Used at signup and by import. */
async function openStock({
  storeId, organizationId, productId, warehouseId, sku, name, category,
  quantity, unitCost, reorderPt, safetyStock, maxStock, monthlyDemand, supplier, userId,
  tx: givenTx,
}) {
  const apply = async (tx) => {
    const status = computeStatus(quantity, reorderPt, maxStock);
    await tx.run(
      `INSERT INTO inventory
         (organization_id, store_id, product_id, warehouse_id, sku, name, category,
          quantity, unit_cost, reorder_pt, safety_stock, monthly_demand, max_stock,
          supplier, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         quantity = VALUES(quantity), unit_cost = VALUES(unit_cost),
         reorder_pt = VALUES(reorder_pt), safety_stock = VALUES(safety_stock),
         max_stock = VALUES(max_stock), monthly_demand = VALUES(monthly_demand),
         status = VALUES(status), updated_at = NOW()`,
      [organizationId, storeId, productId, warehouseId || null, sku, name, category || null,
       quantity, unitCost, reorderPt || 0, safetyStock || 0, monthlyDemand || 0,
       maxStock || 0, supplier || null, status]);

    if (quantity > 0) {
      await tx.run(
        `INSERT INTO stock_movements
           (organization_id, store_id, product_id, warehouse_id, direction, quantity,
            balance_after, unit_cost, reason, occurred_at, note, created_by)
         VALUES (?,?,?,?, 'IN', ?, ?, ?, 'opening', NOW(), 'Opening stock', ?)`,
        [organizationId, storeId, productId, warehouseId || null, quantity, quantity,
         unitCost, userId || null]);
    }
    return status;
  };

  return givenTx ? apply(givenTx) : withTransaction(apply);
}

/** Running stock history for one product, newest first. */
async function ledgerFor(storeId, productId, limit = 50) {
  return query(
    `SELECT m.id, m.direction, m.quantity, m.balance_after, m.unit_cost, m.reason,
            m.reference_type, m.reference_id, m.occurred_at, m.note, m.created_at,
            p.name AS product_name, p.sku
       FROM stock_movements m
       JOIN products p ON p.id = m.product_id
      WHERE m.store_id = ? AND (? IS NULL OR m.product_id = ?)
      ORDER BY m.occurred_at DESC, m.id DESC
      LIMIT ?`, [storeId, productId || null, productId || null, limit]);
}

/** Look up the inventory row the dashboard/UI addresses by SKU. */
async function findBySku(storeId, sku) {
  return queryOne(
    'SELECT id, product_id, sku, name, quantity, unit_cost, reorder_pt, status ' +
    'FROM inventory WHERE store_id = ? AND sku = ?', [storeId, sku]);
}

/**
 * Stock OUT history: the ledger read as "what left, when, how much and why".
 *
 * A read over stock_movements, not a table of its own. Manual entries and CSV
 * imports both arrive here through postMovement, so this is the one place the
 * answer can come from — a separate stock_out table would be a second source of
 * truth that could disagree with the inventory balance.
 *
 * The date filter is applied to occurred_at (the business date), not created_at:
 * a movement entered on the 5th for the 4th belongs to the 4th.
 */
async function outHistory(storeId, { from, to, sku, limit = 200 } = {}) {
  const where = ['m.store_id = ?', "m.direction = 'OUT'"];
  const params = [storeId];

  if (sku) { where.push('i.sku = ?'); params.push(sku); }
  if (from) { where.push('m.occurred_at >= ?'); params.push(`${from} 00:00:00`); }
  if (to)   { where.push('m.occurred_at < ?');  params.push(`${to} 23:59:59`); }

  const rows = await query(
    `SELECT m.id, m.occurred_at, m.quantity, m.reason, m.invoice_no, m.balance_after,
            m.note, m.created_at,
            i.sku, i.name, p.category, p.unit
       FROM stock_movements m
       JOIN inventory i ON i.product_id = m.product_id AND i.store_id = m.store_id
       LEFT JOIN products p ON p.id = m.product_id
      WHERE ${where.join(' AND ')}
      ORDER BY m.occurred_at DESC, m.id DESC
      LIMIT ?`, [...params, Number(limit) || 200]);

  // The two summary numbers are counted over the filtered rows, so they always
  // describe the table the user is looking at rather than the store in total.
  const totals = await queryOne(
    `SELECT COUNT(*) AS lines, COUNT(DISTINCT m.product_id) AS items,
            COALESCE(SUM(m.quantity), 0) AS quantity
       FROM stock_movements m
       JOIN inventory i ON i.product_id = m.product_id AND i.store_id = m.store_id
      WHERE ${where.join(' AND ')}`, params);

  return { rows, summary: {
    items: Number(totals.items || 0),
    lines: Number(totals.lines || 0),
    quantity: Number(totals.quantity || 0),
  } };
}

module.exports = {
  postMovement, openStock, ledgerFor, findBySku, outHistory, computeStatus, REASONS,
};