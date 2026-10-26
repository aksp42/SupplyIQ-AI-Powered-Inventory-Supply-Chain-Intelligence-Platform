#!/usr/bin/env node
/**
 * verify-schema.js — structural smoke test for the applied schema.
 *
 *   node backend/scripts/verify-schema.js
 *
 * This checks SHAPE, not business data: that every expected table exists, that
 * the tables the running backend depends on have the columns it reads, that
 * foreign keys and CHECK constraints are actually in place, and that no business
 * table is missing its organization_id (the tenant boundary).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const { query, queryOne } = require('../mysql');

let failures = 0;
const ok  = (m) => console.log(`  \x1b[32m✔\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31m✖\x1b[0m ${m}`); };

// Tables grouped by the module they belong to.
const EXPECTED = {
  'identity':  ['users','auth_identities','otp_codes','schema_migrations'],
  'tenancy':   ['organizations','stores','roles','permissions','role_permissions',
                'store_members','invitations'],
  'catalogue': ['categories','products','warehouses'],
  'inventory': ['inventory','stock_movements','stock_adjustments','stock_adjustment_items'],
  'suppliers': ['suppliers','supplier_products','supplier_lead_times','supplier_performance'],
  'sales':     ['customers','sales_orders','sales_order_items','sales'],
  'purchasing':['purchase_orders','purchase_order_items','purchase_order_status_history',
                'deliveries','delivery_items'],
  'forecast':  ['forecast_runs','forecast_results','model_metrics'],
  'risk':      ['risk_records','risk_assessments','alerts','alert_resolutions',
                'notification_preferences'],
  'replenish': ['replenishment_recommendations','replenishment_recommendation_items',
                'replenishment_approvals'],
  'reports':   ['reports','report_runs','report_exports'],
  'imports':   ['import_jobs','import_files','import_row_errors'],
  'platform':  ['audit_logs','organization_settings','ai_configurations'],
};

// Columns the existing backend code reads by name. If one of these disappears,
// a working feature breaks — that is what this list protects.
const BACKEND_CONTRACT = {
  users:      ['id','email','password','name','phone','store_id','business_type',
               'firebase_uid','provider','created_at','updated_at'],
  stores:     ['store_id','name','owner_name','owner_initials','email','type','currency',
               'theme','tagline','organization_id'],
  inventory:  ['store_id','sku','name','category','quantity','unit_cost','reorder_pt',
               'monthly_demand','supplier','status','updated_at','product_id'],
  sales:      ['store_id','date','sales','profit','units_sold'],
  auth_identities: ['user_id','provider','provider_uid','email_at_provider'],
  otp_codes:  ['email','purpose','code_hash','expires_at','attempts'],
};

// Every business table must be tenant-scoped.
const TENANT_TABLES = [
  'stores','store_members','invitations','categories','products','warehouses','inventory',
  'stock_movements','stock_adjustments','stock_adjustment_items','suppliers',
  'supplier_products','supplier_lead_times','supplier_performance','customers',
  'sales_orders','sales_order_items','sales','purchase_orders','purchase_order_items',
  'purchase_order_status_history','deliveries','delivery_items','forecast_runs',
  'forecast_results','model_metrics','risk_records','risk_assessments','alerts',
  'alert_resolutions','notification_preferences','replenishment_recommendations',
  'replenishment_recommendation_items','replenishment_approvals','report_runs',
  'report_exports','import_jobs','import_files','import_row_errors','audit_logs',
  'organization_settings','ai_configurations',
];

// Business rules that must be enforced by the database, not just by JavaScript.
const REQUIRED_CHECKS = {
  inventory:       ['quantity >= 0'],
  stock_movements: ['quantity > 0'],
  sales_order_items: ['quantity > 0'],
  purchase_order_items: ['quantity > 0'],
};

async function main() {
  console.log(`\nSupplyIQ schema verification — ${process.env.DB_NAME || 'supplyiq'}\n`);

  // 1. tables exist
  console.log('Tables');
  const rows = await query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'`);
  const present = new Set(rows.map(r => r.TABLE_NAME || r.table_name));
  const missing = [];
  for (const [group, list] of Object.entries(EXPECTED)) {
    const gone = list.filter(t => !present.has(t));
    if (gone.length) { bad(`${group}: missing ${gone.join(', ')}`); missing.push(...gone); }
    else ok(`${group}: ${list.length} tables`);
  }

  // 2. backend column contract
  console.log('\nBackend column contract (columns the running API reads)');
  for (const [table, cols] of Object.entries(BACKEND_CONTRACT)) {
    if (!present.has(table)) { bad(`${table}: table missing`); continue; }
    const r = await query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = ?`, [table]);
    const have = new Set(r.map(x => x.COLUMN_NAME || x.column_name));
    const gone = cols.filter(c => !have.has(c));
    if (gone.length) bad(`${table}: missing column(s) ${gone.join(', ')}`);
    else ok(`${table}: all ${cols.length} columns present`);
  }

  // 3. tenant isolation
  console.log('\nTenant isolation (organization_id on every business table)');
  const lacking = [];
  for (const t of TENANT_TABLES) {
    if (!present.has(t)) { lacking.push(`${t} (table missing)`); continue; }
    const r = await query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = ? AND column_name = 'organization_id'`, [t]);
    if (!r.length) lacking.push(t);
  }
  if (lacking.length) bad(`missing organization_id: ${lacking.join(', ')}`);
  else ok(`all ${TENANT_TABLES.length} business tables are organization-scoped`);

  // 4. constraints
  console.log('\nConstraints');
  const fk = await queryOne(
    `SELECT COUNT(*) AS n FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_TYPE = 'FOREIGN KEY'`);
  ok(`${fk.n} foreign keys`);

  const uq = await queryOne(
    `SELECT COUNT(*) AS n FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_TYPE = 'UNIQUE'`);
  ok(`${uq.n} unique constraints`);

  for (const [table, needles] of Object.entries(REQUIRED_CHECKS)) {
    const r = await query(
      `SELECT cc.check_clause AS clause FROM information_schema.CHECK_CONSTRAINTS cc
        JOIN information_schema.TABLE_CONSTRAINTS tc
          ON tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME AND tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA
       WHERE tc.TABLE_SCHEMA = DATABASE() AND tc.TABLE_NAME = ?`, [table]);
    // MySQL renders clauses with backticks and character-set prefixes
    // (`quantity` >= 0, `status` in (_utf8mb4'OK',...)), so normalise before matching.
    const text = r.map(x => x.clause || x.CLAUSE).join(' | ')
      .replace(/`/g, '')
      .replace(/_utf8mb4/g, '')
      .replace(/\\'/g, "'")
      .replace(/\s+/g, ' ')
      .toLowerCase();
    const gone = needles.filter(n => !text.includes(n.toLowerCase()));
    if (gone.length) bad(`${table}: CHECK not enforced for ${gone.join(', ')}`);
    else ok(`${table}: ${needles.join(', ')} enforced by CHECK`);
  }

  // 5. reference data
  console.log('\nReference data');
  for (const [label, sql] of [
    ['permissions',     'SELECT COUNT(*) AS n FROM permissions'],
    ['roles',           "SELECT COUNT(*) AS n FROM roles WHERE organization_id IS NULL"],
    ['role grants',     'SELECT COUNT(*) AS n FROM role_permissions'],
    ['report catalogue','SELECT COUNT(*) AS n FROM reports'],
  ]) {
    const r = await queryOne(sql);
    if (!r || r.n === 0) bad(`${label}: empty`);
    else ok(`${label}: ${r.n} rows`);
  }

  // 6. auth link safety
  console.log('\nAuth identity linking');
  const ai = await query(
    `SELECT CONSTRAINT_NAME, COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auth_identities'
        AND CONSTRAINT_NAME IN ('uq_identity_provider_uid','uq_identity_user_provider')`);
  const names = ai.map(a => a.CONSTRAINT_NAME || a.constraint_name);
  const need = ['uq_identity_provider_uid', 'uq_identity_user_provider'];
  const gone = need.filter(n => !names.includes(n));
  if (gone.length) bad(`missing unique key(s): ${gone.join(', ')}`);
  else ok('Firebase UID is unique per provider; one identity per provider per user');

  console.log(failures === 0
    ? '\n\x1b[1;32m✔ schema verified — no problems found\x1b[0m\n'
    : `\n\x1b[1;31m✖ ${failures} problem(s) found\x1b[0m\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(`\x1b[31m${err.message}\x1b[0m`); process.exit(1); });