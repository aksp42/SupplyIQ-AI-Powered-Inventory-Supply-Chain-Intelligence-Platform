const { query } = require('./mysql');
require('dotenv').config({ path: './.env', quiet: true });

(async () => {
  try {
    const result = await query(`
      SELECT DATE(sm.occurred_at) as date, p.sku, p.name, SUM(sm.quantity) as quantity
      FROM stock_movements sm
      JOIN products p ON p.id = sm.product_id
      WHERE sm.store_id = ? AND sm.direction = 'OUT' AND sm.reason = 'sale'
      GROUP BY DATE(sm.occurred_at), p.sku, p.name
      ORDER BY date ASC
    `, ['demo-store-01']);
    console.log('Sales records:', result.length);
    if (result.length > 0) console.log(result.slice(0,5));
  } catch(e) { console.error(e); }
  process.exit(0);
})();