/**
 * Generate the single-file ledger template.
 *
 * The dashboard charts and KPI row are driven by sales dated in the recent past,
 * so a template full of stale fixed dates produces an empty dashboard for anyone
 * who downloads it later. This writes ledger.csv from a small spec with every
 * date computed relative to today, and the whole file ends "yesterday" so the
 * upload is never dated in the future.
 *
 * Run it with no argument to use today; pass YYYY-MM-DD to pin the anchor:
 *   node scripts/generate-ledger-template.js
 *   node scripts/generate-ledger-template.js 2026-10-03
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'csv', 'templates', 'ledger.csv');
const TODAY = process.argv[2] || new Date().toISOString().slice(0, 10);
const WINDOW_DAYS = 45;

const day = offset => {
  const [y, m, d] = TODAY.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + offset);
  return dt.toISOString().slice(0, 10);
};

// Six SKUs across four categories, with a supplier and a realistic cost/sell
// spread. demand drives the sales pattern: a higher value sells more per day.
const PRODUCTS = [
  { sku: 'GRC-001', name: 'Basmati Rice 5kg',      cat: 'Staples', unit: 'kg', cost: 540, sell: 665, demand: 9,  reorder: 40, safety: 15, max: 200, supplier: 'Sri Traders',        phone: '9845012345' },
  { sku: 'GRC-002', name: 'Sunflower Oil 1L',      cat: 'Oils',    unit: 'pc', cost: 128, sell: 158, demand: 6,  reorder: 30, safety: 10, max: 120, supplier: 'Agri Distributors',   phone: '9845098765' },
  { sku: 'GRC-003', name: 'Toor Dal 1kg',          cat: 'Staples', unit: 'kg', cost: 142, sell: 180, demand: 7,  reorder: 25, safety: 8,  max: 90,  supplier: 'Sri Traders',        phone: '9845012345' },
  { sku: 'GRC-004', name: 'Wheat Atta 10kg',       cat: 'Staples', unit: 'kg', cost: 38,  sell: 53,  demand: 14, reorder: 50, safety: 20, max: 250, supplier: 'Mysore Mills',       phone: '9845077881' },
  { sku: 'GRC-005', name: 'Sugar 1kg',             cat: 'Staples', unit: 'kg', cost: 44,  sell: 56,  demand: 8,  reorder: 35, safety: 12, max: 150, supplier: 'Agri Distributors',   phone: '9845098765' },
  { sku: 'GRC-006', name: 'Tea Powder 500g',       cat: 'Beverages', unit: 'pc', cost: 210, sell: 265, demand: 4, reorder: 20, safety: 6,  max: 80,  supplier: 'Chai Traders',       phone: '9845033221' },
];

const HEADER = [
  'date', 'sku', 'direction', 'quantity', 'product_name', 'category', 'unit',
  'supplier', 'supplier_phone', 'unit_cost', 'unit_price', 'discount',
  'channel', 'invoice_no', 'reason', 'note', 'reorder_pt', 'safety_stock', 'max_stock',
];

const rows = [];
let invoice = 1001;
let bill = 1001;

const push = cells => rows.push(cells.map(c => (c === null || c === undefined ? '0' : String(c))));

// Opening receipts, dated at the very start of the window so every later sale
// has stock behind it. The opening quantity has to cover the whole window with
// room to spare, otherwise the balance runs out mid-window, later sale rows get
// skipped, and the uploaded store looks permanently out of stock.
// Reorder/safety/max only need stating once per SKU.
const first = -WINDOW_DAYS + 2;
const opening = PRODUCTS.map(p => Math.ceil(p.demand * WINDOW_DAYS * 1.6));
for (const [i, p] of PRODUCTS.entries()) {
  push([day(first), p.sku, 'IN', opening[i], p.name, p.cat, p.unit, p.supplier, p.phone,
        p.cost, 0, 0, 'Purchase', `INV-${invoice++}`, 'purchase',
        'Opening stock', p.reorder, p.safety, p.max]);
}

// Restock part-way through, so the Stock Received KPI and the receipts list have
// more than one arrival to show.
for (const [i, p] of PRODUCTS.entries()) {
  const at = -Math.round(WINDOW_DAYS * 0.55) + i;
  push([day(at), p.sku, 'IN', Math.round(p.demand * 6), p.name, p.cat, p.unit, p.supplier, p.phone,
        p.cost + 4, 0, 0, 'Purchase', `INV-${invoice++}`, 'purchase', 'Mid-month restock', 0, 0, 0]);
}

// Sales, most recent day last. Every SKU sells on most days, which is what the
// sales chart needs to draw a continuous line rather than a scatter of points.
const balance = opening.slice();
for (let offset = -WINDOW_DAYS + 4; offset <= -1; offset++) {
  const date = day(offset);
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  const busy = weekday === 0 || weekday === 6 ? 1.25 : 1;      // weekends busier

  PRODUCTS.forEach((p, i) => {
    // Deterministic wobble instead of Math.random so re-running this script
    // produces a byte-identical file and diffs stay reviewable.
    const wobble = 1 + 0.18 * Math.sin(offset * 0.7 + i * 1.3);
    const qty = Math.max(1, Math.round(p.demand * busy * wobble));
    if (qty > balance[i]) return;
    balance[i] -= qty;

    const wholesale = weekday === 1 && i % 2 === 0;
    const discount = wholesale ? 15 : 0;
    push([date, p.sku, 'SALE', qty, p.name, p.cat, p.unit, '', '',
          0, p.sell, discount, wholesale ? 'Wholesale' : (offset % 4 === 0 ? 'Delivery' : 'POS'),
          String(bill++), 'sale', wholesale ? 'Wholesale bulk' : '', 0, 0, 0]);
  });
}

// CSV escaping: any cell containing a comma, quote or newline must be quoted.
const esc = cell => {
  const s = String(cell);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const body = [HEADER.join(','), ...rows.map(r => r.map(esc).join(','))];
fs.writeFileSync(FILE, body.join('\n') + '\n', 'utf8');

const firstSale = rows.findIndex(r => r[2] === 'SALE');
const lastDate = rows[rows.length - 1][0];
console.log(`ledger.csv written, anchored so it ends ${day(-1)}`);
console.log(`  rows=${rows.length}  salesRows=${rows.length - firstSale}  receipts=${firstSale}`);
console.log(`  window=${body[1].split(',')[0]} .. ${lastDate}  (WINDOW_DAYS=${WINDOW_DAYS})`);
console.log(`  skus=${PRODUCTS.length}  suppliers=${new Set(PRODUCTS.map(p => p.supplier)).size}`);