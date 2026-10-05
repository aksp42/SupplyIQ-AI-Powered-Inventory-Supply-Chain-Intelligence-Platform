-- ============================================================================
-- SupplyIQ — 002_reference_data.sql
-- Platform-wide reference rows. None of this is business data, so the same file
-- is safe to apply to every tenant environment. Idempotent: re-running it
-- refreshes names without duplicating rows.
-- ============================================================================
USE supplyiq;

-- ── Permissions ───────────────────────────────────────────────────────────────
INSERT INTO permissions (key_name, module, description) VALUES
  ('org.view',        'organization', 'View business settings and team'),
  ('org.edit',        'organization', 'Change business settings'),
  ('members.view',    'access',       'View team members and roles'),
  ('members.invite',  'access',       'Invite team members'),
  ('members.manage',  'access',       'Change roles, suspend or remove members'),
  ('inventory.view',  'inventory',    'View stock levels and ledger'),
  ('inventory.write', 'inventory',    'Receive stock, adjust stock, transfer stock'),
  ('products.view',   'catalog',      'View products and categories'),
  ('products.write',  'catalog',      'Create and edit products'),
  ('suppliers.view',  'suppliers',    'View suppliers and performance'),
  ('suppliers.write', 'suppliers',    'Create and edit suppliers'),
  ('po.view',         'purchasing',   'View purchase orders and deliveries'),
  ('po.write',        'purchasing',   'Create and edit purchase orders'),
  ('po.approve',      'purchasing',   'Approve purchase orders for sending'),
  ('replenishment.view',   'replenishment', 'View reorder recommendations'),
  ('replenishment.approve','replenishment', 'Approve reorder recommendations'),
  ('forecast.view',   'forecast',     'View demand forecasts'),
  ('forecast.run',    'forecast',     'Trigger a forecast run'),
  ('risk.view',       'risk',         'View risk register and alerts'),
  ('risk.resolve',    'risk',         'Acknowledge and resolve risks'),
  ('reports.view',    'reports',      'View and export reports'),
  ('imports.run',     'imports',      'Upload and commit CSV imports'),
  ('sales.view',      'sales',        'View sales history and customers'),
  ('sales.write',     'sales',        'Record sales'),
  ('settings.ai',     'settings',     'Configure AI and forecasting behaviour')
ON DUPLICATE KEY UPDATE
  module = VALUES(module), description = VALUES(description);

-- ── System role templates ────────────────────────────────────────────────────
-- organization_id NULL marks these as global templates; an org copies them.
INSERT INTO roles (organization_id, key_name, name, description, is_system) VALUES
  (NULL, 'owner',   'Owner',   'Full control including billing, team and approvals', 1),
  (NULL, 'manager', 'Manager', 'Runs daily operations, approves purchase orders',   1),
  (NULL, 'staff',   'Staff',   'Receives stock, records sales, no approvals',        1),
  (NULL, 'viewer',  'Viewer',  'Read-only access to dashboards and reports',          1)
ON DUPLICATE KEY UPDATE
  name = VALUES(name), description = VALUES(description);

-- owner: everything
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.organization_id IS NULL AND r.key_name = 'owner';

-- manager: operations + supplier + forecasting + risk, no member/admin management
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
WHERE r.organization_id IS NULL AND r.key_name = 'manager'
  AND p.key_name IN (
    'org.view','members.view','inventory.view','inventory.write','products.view',
    'products.write','suppliers.view','suppliers.write','po.view','po.write','po.approve',
    'replenishment.view','replenishment.approve','forecast.view','forecast.run',
    'risk.view','risk.resolve','reports.view','imports.run','sales.view','sales.write');

-- staff: day-to-day entry only
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
WHERE r.organization_id IS NULL AND r.key_name = 'staff'
  AND p.key_name IN ('inventory.view','inventory.write','products.view','po.view',
                     'sales.view','sales.write','risk.view');

-- viewer: read only
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
WHERE r.organization_id IS NULL AND r.key_name = 'viewer'
  AND p.key_name IN ('org.view','inventory.view','products.view','suppliers.view','po.view',
                     'replenishment.view','forecast.view','risk.view','reports.view','sales.view');

-- ── Report catalogue ─────────────────────────────────────────────────────────
INSERT INTO reports (report_key, name, category, description, default_format) VALUES
  ('stock_ledger',        'Stock Ledger',            'inventory', 'Every stock movement with running balance', 'xlsx'),
  ('stock_on_hand',       'Stock on Hand',           'inventory', 'Current quantity and value per SKU',        'xlsx'),
  ('stockout_risk',       'Stock-out Risk',          'inventory', 'Items below reorder point with days of cover','xlsx'),
  ('slow_moving',         'Slow Moving / Dead Stock','inventory', 'No sales in the last N days',               'xlsx'),
  ('sales_summary',       'Sales Summary',           'sales',     'Revenue, profit and margin by day',         'xlsx'),
  ('sales_by_product',    'Sales by Product',        'sales',     'Units and value per product',               'xlsx'),
  ('customer_statement',  'Customer Statement',      'sales',     'Outstanding balance per customer',          'xlsx'),
  ('purchase_orders',     'Purchase Order Register', 'purchasing','PO status, delivery and delay',             'xlsx'),
  ('supplier_performance','Supplier Performance',    'suppliers', 'On-time rate, lead time, fill rate',        'xlsx'),
  ('replenishment_plan',  'Replenishment Plan',      'replenishment','Suggested orders with quantities and cost','xlsx'),
  ('profit_loss',         'Estimated Profit & Loss', 'finance',   'Revenue, COGS, gross profit, stock value',  'xlsx'),
  ('gst_summary',         'GST Summary',             'finance',   'Tax collected by rate band',                'xlsx'),
  ('audit_trail',         'Audit Trail',             'admin',     'Who changed what and when',                  'xlsx')
ON DUPLICATE KEY UPDATE
  name = VALUES(name), category = VALUES(category),
  description = VALUES(description), default_format = VALUES(default_format);