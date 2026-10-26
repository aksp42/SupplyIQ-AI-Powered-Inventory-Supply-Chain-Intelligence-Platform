require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const { query, queryOne, getPool } = require('../mysql');

const NEGATIVE = 'these SHOULD fail';

/** Try a write that must be rejected, and report whether it was. */
async function mustReject(label, sql, params) {
  try {
    await query(sql, params);
    console.log(`  FAIL  ${label} -> the write was ACCEPTED (constraint missing!)`);
    return false;
  } catch (err) {
    const code = err.code || err.sqlState;
    console.log(`  pass  ${label} -> rejected (${code})`);
    return true;
  }
}

(async () => {
  const store = await queryOne('SELECT store_id, organization_id FROM stores LIMIT 1');
  if (!store) { console.log('No store to test against — run db:seed first.'); await getPool().end(); return; }

  const product = await queryOne(
    'SELECT id, organization_id FROM products WHERE organization_id = ? LIMIT 1', [store.organization_id]);

  // A second organization that owns nothing, standing in for any other tenant.
  await query(`INSERT INTO organizations (slug, name, business_type)
    VALUES ('tenant-check', 'Tenant Check', 'general') ON DUPLICATE KEY UPDATE name = name`);
  const other = await queryOne('SELECT id FROM organizations WHERE slug = ?', ['tenant-check']);

  // A throwaway product in the *real* organization. Without a product that no
  // row uses yet, the probe below would be rejected by the products foreign key
  // (or collide with uq_inv_store_product) and would pass for the wrong reason —
  // the test would prove nothing about tenant isolation.
  const probeSku = `XCHK-${Date.now()}`;
  await query(`INSERT INTO products (organization_id, sku, name) VALUES (?,?,?)`,
    [store.organization_id, probeSku, 'Cross Tenant Probe']);
  const probeProduct = await queryOne('SELECT id FROM products WHERE sku = ?', [probeSku]);

  // A sales date that is definitely not already present.
  const freeDate = '1999-12-31';

  console.log(`\nStore ${store.store_id} belongs to organization ${store.organization_id};`);
  console.log(`neighbouring organization is ${other.id}.`);
  console.log(`probe product ${probeProduct.id} is owned by the real organization.\n`);

  let allGood = true;

  allGood &= await mustReject('inventory row naming another org\'s store',
    `INSERT INTO inventory (organization_id, store_id, product_id, sku, name, quantity, unit_cost, reorder_pt)
     VALUES (?,?,?,?,?, 1, 1, 1)`,
    [other.id, store.store_id, probeProduct.id, probeSku, 'Cross Tenant Probe']);

  allGood &= await mustReject('sales row naming another org\'s store',
    `INSERT INTO sales (organization_id, store_id, date, sales, profit, units_sold)
     VALUES (?,?,?,10,1,1)`,
    [other.id, store.store_id, freeDate]);

  allGood &= await mustReject('stock movement naming another org\'s store',
    `INSERT INTO stock_movements
       (organization_id, store_id, product_id, direction, quantity, unit_cost, reason, occurred_at)
     VALUES (?,?,?, 'IN', 5, 1, 'purchase', NOW())`,
    [other.id, store.store_id, probeProduct.id]);

  allGood &= await mustReject('duplicate system role',
    `INSERT INTO roles (organization_id, key_name, name) VALUES (NULL,'owner','Duplicate Owner')`, []);

  allGood &= await mustReject('inventory quantity going negative',
    `UPDATE inventory SET quantity = -1 WHERE id = (
       SELECT * FROM (SELECT MIN(id) AS id FROM inventory) x)`,
    []);

  // Clean up the probe rows, so a passing run leaves no residue.
  await query('DELETE FROM products WHERE sku = ?', [probeSku]).catch(() => {});
  await query(`DELETE FROM organizations WHERE slug = 'tenant-check'`).catch(() => {});

  console.log('');
  if (!allGood) {
    console.error('Some negative tests passed a write that should have been rejected.');
    await getPool().end();
    process.exit(1);
  }
  console.log('All negative tests behaved correctly — the database rejected each bad write.');
  await getPool().end();
})().catch(async (err) => {
  console.error('Constraint test errored:', err.message);
  try { await getPool().end(); } catch { /* pool never opened */ }
  process.exit(1);
});