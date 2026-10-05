const { query, queryOne } = require('./mysql');
require('dotenv').config({ path: './.env', quiet: true });

(async () => {
  // Check products
  const prods = await query('SELECT id, sku, name, default_unit_cost, default_sell_price FROM products WHERE organization_id = (SELECT organization_id FROM stores WHERE store_id = ?) LIMIT 10', ['demo-store-01']);
  console.log('Products:', JSON.stringify(prods, null, 2));
  
  // Check supplier performance
  const sp = await query('SELECT * FROM supplier_performance');
  console.log('Supplier performance:', JSON.stringify(sp, null, 2));
  
  // Check supplier lead times
  const slt = await query('SELECT * FROM supplier_lead_times');
  console.log('Supplier lead times:', JSON.stringify(slt, null, 2));
  
  // Check purchase orders with items
  const po = await query('SELECT po.po_no, po.status, po.order_date, po.expected_date, s.name as supplier, SUM(pi.quantity) as total_qty, SUM(pi.received_qty) as received_qty FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id LEFT JOIN purchase_order_items pi ON pi.purchase_order_id = po.id WHERE po.store_id = ? GROUP BY po.id ORDER BY po.order_date DESC LIMIT 10', ['demo-store-01']);
  console.log('POs:', JSON.stringify(po, null, 2));
  
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });