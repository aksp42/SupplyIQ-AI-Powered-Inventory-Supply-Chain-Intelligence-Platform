/**
 * catalog.js — business-type-aware starter data.
 *
 * A store's whole workspace is shaped by what it sells. A grocery shop and a
 * stationery shop must not open on the same rows, so every profile carries its
 * own products, suppliers, project themes, expense heads and customer types.
 * Nothing here touches the database; server.js and the seed script read it.
 */

const money = (n) => Math.round(n * 100) / 100;

// ── Profiles ──────────────────────────────────────────────────────────────────
// key        : matched against the businessType chosen at signup
// items      : seeded into inventory at store creation
// suppliers  : written into stores.suppliers (JSON array)
// projects   : project-management themes used by the seed script
// expenses   : operating-expense heads for that trade
// customers  : customer archetypes + names for sales orders

const GROCERY = {
  key: 'grocery',
  label: 'Grocery',
  suppliers: ['Krishna Wholesale', 'FreshFarm Co.', 'AgriLink Suppliers', 'Daily Needs Dist.'],
  items: [
    { sku: 'GRC-001', name: 'Basmati Rice 5kg',        category: 'Staples',  unit_cost: 620,  price: 780,  reorder_pt: 25, monthly_demand: 180, opening_qty: 60 },
    { sku: 'GRC-002', name: 'Sunflower Oil 1L',        category: 'Oils',     unit_cost: 165,  price: 205,  reorder_pt: 20, monthly_demand: 140, opening_qty: 42 },
    { sku: 'GRC-003', name: 'Wheat Atta 10kg',         category: 'Staples',  unit_cost: 260,  price: 330,  reorder_pt: 20, monthly_demand: 120, opening_qty: 55 },
    { sku: 'GRC-004', name: 'Sugar 1kg',               category: 'Staples',  unit_cost: 48,   price: 62,   reorder_pt: 30, monthly_demand: 160, opening_qty: 70 },
    { sku: 'GRC-005', name: 'Tea Powder 500g',         category: 'Beverages',unit_cost: 280,  price: 350,  reorder_pt: 15, monthly_demand: 110, opening_qty: 28 },
    { sku: 'GRC-006', name: 'Toor Dal 1kg',            category: 'Pulses',   unit_cost: 160,  price: 198,  reorder_pt: 20, monthly_demand: 130, opening_qty: 48 },
    { sku: 'GRC-007', name: 'Salt 1kg',                category: 'Staples',  unit_cost: 20,   price: 28,   reorder_pt: 25, monthly_demand: 150, opening_qty: 90 },
    { sku: 'GRC-008', name: 'Chilli Powder 200g',      category: 'Spices',   unit_cost: 95,   price: 122,  reorder_pt: 15, monthly_demand: 90,  opening_qty: 30 },
    { sku: 'GRC-009', name: 'Turmeric Powder 200g',     category: 'Spices',   unit_cost: 85,   price: 110,  reorder_pt: 12, monthly_demand: 70,  opening_qty: 24 },
    { sku: 'GRC-010', name: 'Mustard Oil 1L',          category: 'Oils',     unit_cost: 180,  price: 225,  reorder_pt: 15, monthly_demand: 100, opening_qty: 26 },
  ],
  projects: [
    { name: 'Cold Storage Expansion',    code: 'CSE', priority: 'High',   budget: 180000, theme: 'capex' },
    { name: 'Festive Stock-Up Campaign',  code: 'FSC', priority: 'High',   budget: 95000,  theme: 'growth' },
    { name: 'Supplier Contract Renewal', code: 'SCR', priority: 'Medium', budget: 22000,  theme: 'ops' },
    { name: 'Shelf Display Redesign',     code: 'SDR', priority: 'Low',    budget: 35000,  theme: 'ops' },
  ],
  expenses: ['Rent', 'Electricity', 'Staff Wages', 'Local Delivery', 'Packaging', 'Maintenance', 'Licences & Fees'],
  customers: ['Neighbourhood Store', 'Apartment Society', 'Office Canteen', 'Wedding Hall', 'Small Eatery'],
};

const STATIONERY = {
  key: 'stationery',
  label: 'Stationery',
  suppliers: ['PaperWorld Suppliers', 'EduMart India', 'WriteRight Co.', 'BookDepot Ltd.'],
  items: [
    { sku: 'ST-001', name: 'Classmate Notebook 200pp', category: 'Notebooks', unit_cost: 85,  price: 120, reorder_pt: 60, monthly_demand: 240, opening_qty: 140 },
    { sku: 'ST-002', name: 'Reynolds Ball Pen Blue',  category: 'Pens',      unit_cost: 12,  price: 20,  reorder_pt: 120, monthly_demand: 520, opening_qty: 300 },
    { sku: 'ST-003', name: 'Pencil HB Box of 10',      category: 'Pencils',   unit_cost: 35,  price: 55,  reorder_pt: 50, monthly_demand: 200, opening_qty: 120 },
    { sku: 'ST-004', name: 'A4 Paper Ream 500sheets',  category: 'Paper',     unit_cost: 280, price: 350, reorder_pt: 25, monthly_demand: 130, opening_qty: 60 },
    { sku: 'ST-005', name: 'Stapler Standard',         category: 'Office',    unit_cost: 150, price: 220, reorder_pt: 12, monthly_demand: 40,  opening_qty: 26 },
    { sku: 'ST-006', name: 'Camlin Geometry Box',      category: 'Math',      unit_cost: 120, price: 175, reorder_pt: 30, monthly_demand: 110, opening_qty: 55 },
    { sku: 'ST-007', name: 'Highlighter Set 5pk',      category: 'Highlighters',unit_cost: 55, price: 85, reorder_pt: 90, monthly_demand: 300, opening_qty: 200 },
    { sku: 'ST-008', name: 'Eraser Natraj',            category: 'Erasers',   unit_cost: 8,   price: 15,  reorder_pt: 100, monthly_demand: 400, opening_qty: 260 },
    { sku: 'ST-009', name: 'Scientific Calculator',    category: 'Electronics',unit_cost: 350, price: 499, reorder_pt: 12, monthly_demand: 45,  opening_qty: 20 },
    { sku: 'ST-010', name: 'File Folder Plastic',      category: 'Office',    unit_cost: 40,  price: 65,  reorder_pt: 40, monthly_demand: 140, opening_qty: 90 },
  ],
  projects: [
    { name: 'Academic Session Restock',   code: 'ASR', priority: 'High',   budget: 65000,  theme: 'growth' },
    { name: 'College Bulk Tie-Up',       code: 'CBT', priority: 'High',   budget: 48000,  theme: 'growth' },
    { name: 'New Shop Interior Fitout',  code: 'SIF', priority: 'Medium', budget: 120000, theme: 'capex' },
    { name: 'Stationery Range Audit',    code: 'SRA', priority: 'Low',    budget: 12000,  theme: 'ops' },
  ],
  expenses: ['Rent', 'Electricity', 'Staff Wages', 'Courier & Postage', 'Print & Packaging', 'Maintenance', 'Licences & Fees'],
  customers: ['School Office', 'Coaching Centre', 'College Canteen', 'Corporate Office', 'Local Retail Walk-in'],
};

const HARDWARE = {
  key: 'hardware',
  label: 'Hardware & Tools',
  suppliers: ['SteelMart India', 'PowerTools Direct', 'BuildRight Supplies', 'MetalWorks Co.'],
  items: [
    { sku: 'HW-001', name: 'Cement OPC 53 50kg',    category: 'Construction', unit_cost: 380,  price: 450,  reorder_pt: 80, monthly_demand: 300, opening_qty: 220 },
    { sku: 'HW-002', name: 'Steel Rod 10mm',        category: 'Steel',        unit_cost: 5200, price: 5750, reorder_pt: 20, monthly_demand: 60,  opening_qty: 14 },
    { sku: 'HW-003', name: 'PVC Pipe 1 inch',       category: 'Plumbing',     unit_cost: 120,  price: 165,  reorder_pt: 40, monthly_demand: 120, opening_qty: 90 },
    { sku: 'HW-004', name: 'Drill Machine 550W',    category: 'Power Tools',  unit_cost: 3200, price: 3900, reorder_pt: 6,  monthly_demand: 14,  opening_qty: 7 },
    { sku: 'HW-005', name: 'Exterior Paint 5L',     category: 'Paints',       unit_cost: 480,  price: 620,  reorder_pt: 25, monthly_demand: 70,  opening_qty: 38 },
    { sku: 'HW-006', name: 'Screws Assorted Box',   category: 'Fasteners',    unit_cost: 85,   price: 130,  reorder_pt: 70, monthly_demand: 220, opening_qty: 160 },
    { sku: 'HW-007', name: 'Angle Grinder',         category: 'Power Tools',  unit_cost: 2800, price: 3450, reorder_pt: 5,  monthly_demand: 10,  opening_qty: 4 },
    { sku: 'HW-008', name: 'Wire 1.5mm 90m',        category: 'Electrical',   unit_cost: 220,  price: 295,  reorder_pt: 30, monthly_demand: 130, opening_qty: 70 },
    { sku: 'HW-009', name: 'Adhesive Fevicol 1kg',  category: 'Adhesives',   unit_cost: 150,  price: 205,  reorder_pt: 25, monthly_demand: 95,  opening_qty: 48 },
    { sku: 'HW-010', name: 'Plywood Sheet 18mm',    category: 'Wood',         unit_cost: 1800, price: 2250, reorder_pt: 10, monthly_demand: 32,  opening_qty: 18 },
  ],
  projects: [
    { name: 'Godown Expansion',          code: 'GEX', priority: 'High',   budget: 240000, theme: 'capex' },
    { name: 'Contractor Credit Scheme',  code: 'CCS', priority: 'Medium', budget: 85000,  theme: 'growth' },
    { name: 'Tool Demo Van',             code: 'TDV', priority: 'Medium', budget: 140000, theme: 'growth' },
    { name: 'Site Safety Stocking',      code: 'SSS', priority: 'Low',    budget: 30000,  theme: 'ops' },
  ],
  expenses: ['Rent', 'Electricity', 'Staff Wages', 'Site Delivery Van', 'Safety Gear', 'Maintenance', 'Licences & Fees'],
  customers: ['Site Contractor', 'Builder Firm', 'Home Owner', 'Municipal Contractor', 'Retail Walk-in'],
};

const ECOMMERCE = {
  key: 'ecommerce',
  label: 'E-commerce Brand',
  suppliers: ['Shenzhen Direct', 'India Warehouse Co.', 'Accessory Mart', 'Bulk Deals India'],
  items: [
    { sku: 'EC-001', name: 'TWS Earbuds Pro',        category: 'Audio',     unit_cost: 640,  price: 1299, reorder_pt: 40, monthly_demand: 220, opening_qty: 150 },
    { sku: 'EC-002', name: '65W Fast Charger',       category: 'Charging',  unit_cost: 420,  price: 899,  reorder_pt: 50, monthly_demand: 300, opening_qty: 210 },
    { sku: 'EC-003', name: 'Silicone Phone Cover',   category: 'Covers',    unit_cost: 85,   price: 249,  reorder_pt: 80, monthly_demand: 420, opening_qty: 320 },
    { sku: 'EC-004', name: '20000mAh Power Bank',    category: 'Power',     unit_cost: 1150, price: 1999, reorder_pt: 30, monthly_demand: 160, opening_qty: 95 },
    { sku: 'EC-005', name: 'USB-C Cable 1m',         category: 'Cables',    unit_cost: 120,  price: 349,  reorder_pt: 90, monthly_demand: 380, opening_qty: 260 },
    { sku: 'EC-006', name: 'Bluetooth Speaker 10W',  category: 'Audio',     unit_cost: 980,  price: 1799, reorder_pt: 25, monthly_demand: 120, opening_qty: 70 },
    { sku: 'EC-007', name: 'Wireless Mouse',         category: 'Computer',  unit_cost: 320,  price: 599,  reorder_pt: 35, monthly_demand: 150, opening_qty: 95 },
    { sku: 'EC-008', name: 'LED Bulb 9W',            category: 'Lighting',  unit_cost: 110,  price: 249,  reorder_pt: 70, monthly_demand: 260, opening_qty: 180 },
    { sku: 'EC-009', name: 'Extension Board 4 Socket',category: 'Electrical',unit_cost: 480, price: 799,  reorder_pt: 30, monthly_demand: 140, opening_qty: 80 },
    { sku: 'EC-010', name: 'Laptop Stand Aluminium', category: 'Computer',  unit_cost: 540,  price: 999,  reorder_pt: 20, monthly_demand: 90,  opening_qty: 55 },
  ],
  projects: [
    { name: 'Festive Dussehra Sale',   code: 'FDS', priority: 'High',   budget: 120000, theme: 'growth' },
    { name: 'Marketplace Onboarding',  code: 'MKO', priority: 'High',   budget: 65000,  theme: 'growth' },
    { name: 'Packaging Brand Refresh', code: 'PBR', priority: 'Medium', budget: 90000,  theme: 'capex' },
    { name: 'Returns Policy Overhaul', code: 'RPO', priority: 'Low',    budget: 15000,  theme: 'ops' },
  ],
  expenses: ['Warehouse Rent', 'Electricity', 'Packaging Material', 'Courier & Shipping', 'Payment Gateway Fees', 'Marketplace Commission', 'Software Subscriptions'],
  customers: ['Retail Customer', 'Gift Buyer', 'Corporate Bulk Order', 'Reseller', 'Returning Customer'],
};

const GENERAL = {
  key: 'general',
  label: 'General Store',
  suppliers: ['Local Distributor', 'Wholesale Hub', 'City Supplier', 'Regional Trader'],
  items: [
    { sku: 'GN-001', name: 'Steel Water Bottle 1L', category: 'Drinkware', unit_cost: 220, price: 349, reorder_pt: 30, monthly_demand: 120, opening_qty: 70 },
    { sku: 'GN-002', name: 'College Notebook',      category: 'Stationery',unit_cost: 65,  price: 95,  reorder_pt: 50, monthly_demand: 180, opening_qty: 110 },
    { sku: 'GN-003', name: 'Foldable Umbrella',     category: 'Accessories',unit_cost: 320, price: 499, reorder_pt: 25, monthly_demand: 90,  opening_qty: 48 },
    { sku: 'GN-004', name: 'Laptop Backpack',       category: 'Bags',      unit_cost: 540, price: 849,  reorder_pt: 18, monthly_demand: 65,  opening_qty: 34 },
    { sku: 'GN-005', name: 'Hand Sanitizer 500ml',  category: 'Care',      unit_cost: 85,  price: 140,  reorder_pt: 60, monthly_demand: 220, opening_qty: 160 },
    { sku: 'GN-006', name: 'First Aid Kit',         category: 'Care',      unit_cost: 240, price: 399,  reorder_pt: 20, monthly_demand: 60,  opening_qty: 30 },
    { sku: 'GN-007', name: 'LED Torch',             category: 'Tools',     unit_cost: 175, price: 299,  reorder_pt: 25, monthly_demand: 85,  opening_qty: 50 },
    { sku: 'GN-008', name: 'AA Battery 4-pack',     category: 'Electrical',unit_cost: 110, price: 199,  reorder_pt: 45, monthly_demand: 160, opening_qty: 120 },
    { sku: 'GN-009', name: 'Nylon Rope 10m',        category: 'Hardware',  unit_cost: 290, price: 449,  reorder_pt: 15, monthly_demand: 50,  opening_qty: 26 },
    { sku: 'GN-010', name: 'Padlock 40mm',          category: 'Security',  unit_cost: 195, price: 329,  reorder_pt: 22, monthly_demand: 75,  opening_qty: 44 },
  ],
  projects: [
    { name: 'Evening Footfall Boost',  code: 'EFB', priority: 'Medium', budget: 40000,  theme: 'growth' },
    { name: 'Shop Signage Upgrade',    code: 'SSU', priority: 'Low',    budget: 28000,  theme: 'capex' },
    { name: 'Festival Gifting Range',   code: 'FGR', priority: 'High',   budget: 55000,  theme: 'growth' },
    { name: 'Monthly Stock Audit',     code: 'MSA', priority: 'Low',    budget: 6000,   theme: 'ops' },
  ],
  expenses: ['Rent', 'Electricity', 'Staff Wages', 'Local Delivery', 'Packaging', 'Maintenance', 'Licences & Fees'],
  customers: ['Walk-in Customer', 'Nearby Resident', 'School Student', 'Office Staff', 'Event Organiser'],
};

const PROFILES = { grocery: GROCERY, stationery: STATIONERY, hardware: HARDWARE, ecommerce: ECOMMERCE, general: GENERAL };

/**
 * Resolve a signup businessType (free text from the dropdown) onto a profile.
 * Order matters: "E-commerce brand" must not fall through to "general" just
 * because it does not contain the word "store".
 */
function resolveProfile(businessType) {
  const t = String(businessType || '').toLowerCase();
  if (!t) return GENERAL;
  if (/e-?commerce|online|retail brand|brand/.test(t)) return ECOMMERCE;
  if (/grocery|grocer|supermarket|kirana|food|fresh|provision/.test(t)) return GROCERY;
  if (/stationery|stationar|book|school|office supply|academic/.test(t)) return STATIONERY;
  if (/hardware|tool|construction|steel|building|material/.test(t)) return HARDWARE;
  if (/wholesale|distribut|manufacturer/.test(t)) return GENERAL;
  if (/retail|general|shop|store/.test(t)) return GENERAL;
  return GENERAL;
}

module.exports = { PROFILES, resolveProfile, money };