-- ============================================================================
-- SupplyIQ — 001_core_schema.sql
-- Canonical schema. This file is the single source of truth for structure.
-- Apply with:  node backend/scripts/migrate.js   (do not pipe this into `mysql`
-- by hand — the runner records it in schema_migrations and can roll it back.)
-- Target: MySQL 8.0.16+ (enforced CHECK constraints), InnoDB, utf8mb4.
-- ============================================================================

CREATE DATABASE IF NOT EXISTS supplyiq
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE supplyiq;

-- Migration bookkeeping -------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     VARCHAR(64)  NOT NULL PRIMARY KEY,
  checksum    CHAR(64)     NOT NULL,
  applied_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  duration_ms INT          NOT NULL DEFAULT 0
) ENGINE=InnoDB;

-- ============================================================================
-- 1. IDENTITY — one unified user table for every sign-in method
-- ============================================================================
-- `users` is deliberately kept column-for-column compatible with the existing
-- auth code (users.password, users.store_id, users.provider, users.firebase_uid),
-- so login / signup / session handling keep working untouched. The normalised
-- multi-provider picture lives in auth_identities; the three identity columns
-- here are kept only as a denormalised fast path for the current session.
CREATE TABLE IF NOT EXISTS users (
  id                INT UNSIGNED    NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email             VARCHAR(255)    NOT NULL,
  password          VARCHAR(255)    NULL,          -- bcrypt; NULL = social-only account
  name              VARCHAR(120)    NOT NULL DEFAULT '',
  phone             VARCHAR(20)     NULL,
  store_id          VARCHAR(60)     NOT NULL,      -- home store, set at signup
  business_type     VARCHAR(80)     NULL,
  firebase_uid      VARCHAR(128)    NULL,          -- fast path for Google/Microsoft
  provider          VARCHAR(20)     NOT NULL DEFAULT 'email',
  status            VARCHAR(20)     NOT NULL DEFAULT 'active',
  email_verified_at DATETIME        NULL,
  last_login_at     DATETIME        NULL,
  created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_store (store_id),
  KEY idx_users_status (status),
  CONSTRAINT ck_users_provider CHECK (provider IN ('email','google','microsoft')),
  CONSTRAINT ck_users_status   CHECK (status   IN ('active','suspended','pending'))
) ENGINE=InnoDB;

-- One row per external identity. This is what lets the same person link Google
-- AND Microsoft AND a password to a single user_id without duplicate accounts.
-- `provider_uid` is the Firebase UID — unique per provider, never reused.
CREATE TABLE IF NOT EXISTS auth_identities (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id          INT UNSIGNED    NOT NULL,
  provider         VARCHAR(20)     NOT NULL,      -- google | microsoft
  provider_uid     VARCHAR(128)    NOT NULL,      -- Firebase localId
  email_at_provider VARCHAR(255)   NULL,          -- snapshot, NOT an account key
  email_verified   TINYINT(1)      NOT NULL DEFAULT 0,
  linked_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at     DATETIME        NULL,
  UNIQUE KEY uq_identity_provider_uid (provider, provider_uid),
  UNIQUE KEY uq_identity_user_provider (user_id, provider),
  KEY idx_identity_user (user_id),
  CONSTRAINT fk_identity_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT ck_identity_provider CHECK (provider IN ('google','microsoft'))
) ENGINE=InnoDB;

-- Email OTP for signup verification and password reset.
-- code_hash is an HMAC digest, never the code. Row is deleted on use → no replay.
CREATE TABLE IF NOT EXISTS otp_codes (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email      VARCHAR(255)    NOT NULL,
  purpose    VARCHAR(20)     NOT NULL,            -- signup | reset
  code_hash  CHAR(64)        NOT NULL,
  expires_at DATETIME        NOT NULL,
  attempts   INT             NOT NULL DEFAULT 0,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_otp_email_purpose (email, purpose),
  CONSTRAINT ck_otp_purpose CHECK (purpose IN ('signup','reset'))
) ENGINE=InnoDB;

-- ============================================================================
-- 2. ORGANISATION & ACCESS — the tenant boundary
-- ============================================================================
-- organizations is the root of isolation. Every business table below carries
-- organization_id, and every query the backend runs is scoped by it.
CREATE TABLE IF NOT EXISTS organizations (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  slug           VARCHAR(64)     NOT NULL,
  name           VARCHAR(150)    NOT NULL,
  legal_name     VARCHAR(190)    NULL,
  business_type  VARCHAR(80)     NOT NULL DEFAULT 'general',
  gstin          VARCHAR(20)     NULL,
  phone          VARCHAR(20)     NULL,
  email          VARCHAR(255)    NULL,
  address_line   VARCHAR(255)    NULL,
  city           VARCHAR(80)     NULL,
  state          VARCHAR(80)     NULL,
  pincode        VARCHAR(10)     NULL,
  currency       CHAR(3)         NOT NULL DEFAULT 'INR',
  timezone       VARCHAR(64)     NOT NULL DEFAULT 'Asia/Kolkata',
  fiscal_year_start_month TINYINT UNSIGNED NOT NULL DEFAULT 4,
  owner_user_id  INT UNSIGNED    NULL,             -- FK added after users+stores exist
  is_active      TINYINT(1)      NOT NULL DEFAULT 1,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_org_slug (slug),
  KEY idx_org_owner (owner_user_id),
  CONSTRAINT ck_org_business_type CHECK (
    business_type IN ('grocery','stationery','hardware','ecommerce','general')),
  CONSTRAINT ck_org_fy_month CHECK (fiscal_year_start_month BETWEEN 1 AND 12)
) ENGINE=InnoDB;

-- A shop / branch of an organization. Existing UI columns are preserved.
CREATE TABLE IF NOT EXISTS stores (
  store_id       VARCHAR(60)     NOT NULL PRIMARY KEY,   -- text slug, kept for API compat
  organization_id BIGINT UNSIGNED NOT NULL,
  name           VARCHAR(120)    NOT NULL,
  code           VARCHAR(30)     NOT NULL,                -- short code for PO numbering
  owner_name     VARCHAR(120)    NULL,
  owner_initials VARCHAR(6)      NULL,
  email          VARCHAR(255)    NULL,
  type           VARCHAR(60)     NULL,                   -- legacy display label
  address_line   VARCHAR(255)    NULL,
  city           VARCHAR(80)     NULL,
  state          VARCHAR(80)     NULL,
  pincode        VARCHAR(10)     NULL,
  phone          VARCHAR(20)     NULL,
  currency       CHAR(3)         NOT NULL DEFAULT 'INR',
  timezone       VARCHAR(64)     NOT NULL DEFAULT 'Asia/Kolkata',
  theme          VARCHAR(30)     NOT NULL DEFAULT 'green',
  tagline        VARCHAR(255)    NULL,
  is_active      TINYINT(1)      NOT NULL DEFAULT 1,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_store_org_code (organization_id, code),
  KEY idx_store_org (organization_id),
  CONSTRAINT fk_store_org FOREIGN KEY (organization_id) REFERENCES organizations(id)
) ENGINE=InnoDB;

-- Now the two cross links that needed both tables to exist.
-- MySQL has no "ADD FOREIGN KEY IF NOT EXISTS", so each one is applied through a
-- guarded PREPARE: re-running this migration after a partial failure stays safe
-- instead of dying on ER_FK_DUP_NAME.
SET @ddl := IF(EXISTS (
      SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
       WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
         AND CONSTRAINT_NAME = 'fk_users_store'),
    'DO 0',
    'ALTER TABLE users ADD CONSTRAINT fk_users_store
       FOREIGN KEY (store_id) REFERENCES stores(store_id)');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(EXISTS (
      SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
       WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'organizations'
         AND CONSTRAINT_NAME = 'fk_org_owner'),
    'DO 0',
    'ALTER TABLE organizations ADD CONSTRAINT fk_org_owner
       FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- RBAC: roles → permissions. store_members binds a user to a store with a role,
-- so one person can be owner of shop A and a clerk in shop B.
CREATE TABLE IF NOT EXISTS roles (
  id             SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id BIGINT UNSIGNED NULL,                  -- NULL = system role template
  key_name       VARCHAR(40)     NOT NULL,              -- owner | manager | staff | viewer
  name           VARCHAR(80)     NOT NULL,
  description    VARCHAR(255)    NULL,
  is_system      TINYINT(1)      NOT NULL DEFAULT 0,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Multiple NULLs are allowed by a MySQL UNIQUE index, which is exactly the
  -- behaviour we want: several system roles (organization_id NULL) can share a
  -- key_name, but an org may define that key_name only once.
  UNIQUE KEY uq_role_key (organization_id, key_name),
  KEY idx_role_org (organization_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS permissions (
  id         SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  key_name   VARCHAR(60)      NOT NULL,                -- inventory.write, po.approve …
  module     VARCHAR(40)      NOT NULL,
  description VARCHAR(200)     NULL,
  UNIQUE KEY uq_permission_key (key_name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id       SMALLINT UNSIGNED NOT NULL,
  permission_id SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (role_id, permission_id),
  KEY idx_rp_permission (permission_id),
  CONSTRAINT fk_rp_role  FOREIGN KEY (role_id)       REFERENCES roles(id) ON DELETE CASCADE,
  CONSTRAINT fk_rp_perm  FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS store_members (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id BIGINT UNSIGNED NOT NULL,
  store_id        VARCHAR(60)     NOT NULL,
  user_id         INT UNSIGNED    NOT NULL,
  role_id         SMALLINT UNSIGNED NOT NULL,
  is_active       TINYINT(1)      NOT NULL DEFAULT 1,
  joined_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_member_store_user (store_id, user_id),
  KEY idx_member_org (organization_id),
  KEY idx_member_user (user_id),
  CONSTRAINT fk_member_org  FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_member_store FOREIGN KEY (store_id) REFERENCES stores(store_id),
  CONSTRAINT fk_member_user  FOREIGN KEY (user_id)  REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_member_role  FOREIGN KEY (role_id)  REFERENCES roles(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS invitations (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id BIGINT UNSIGNED NOT NULL,
  store_id        VARCHAR(60)     NOT NULL,
  email           VARCHAR(255)    NOT NULL,
  role_id         SMALLINT UNSIGNED NOT NULL,
  token_hash      CHAR(64)        NOT NULL,
  invited_by      INT UNSIGNED    NULL,
  status          VARCHAR(20)     NOT NULL DEFAULT 'pending',
  expires_at      DATETIME        NOT NULL,
  accepted_at     DATETIME        NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_invite_token (token_hash),
  UNIQUE KEY uq_invite_store_email (store_id, email),
  KEY idx_invite_org (organization_id),
  KEY idx_invite_status (organization_id, status),
  CONSTRAINT fk_invite_org   FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_invite_store FOREIGN KEY (store_id) REFERENCES stores(store_id),
  CONSTRAINT fk_invite_role  FOREIGN KEY (role_id) REFERENCES roles(id),
  CONSTRAINT fk_invite_by    FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT ck_invite_status CHECK (status IN ('pending','accepted','revoked','expired'))
) ENGINE=InnoDB;

-- ============================================================================
-- 3. CATALOGUE — products, categories, storage locations
-- ============================================================================
CREATE TABLE IF NOT EXISTS categories (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id BIGINT UNSIGNED NOT NULL,
  name            VARCHAR(100)    NOT NULL,
  parent_id       BIGINT UNSIGNED NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_category_org_name (organization_id, name),
  KEY idx_category_parent (parent_id),
  CONSTRAINT fk_category_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_category_parent FOREIGN KEY (parent_id) REFERENCES categories(id)
) ENGINE=InnoDB;

-- products is the organisation-wide master record. SKU is unique per org, so
-- the same SKU may exist in two different businesses without colliding.
CREATE TABLE IF NOT EXISTS products (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id BIGINT UNSIGNED NOT NULL,
  category_id     BIGINT UNSIGNED NULL,
  sku             VARCHAR(60)     NOT NULL,
  barcode         VARCHAR(64)     NULL,
  name            VARCHAR(160)    NOT NULL,
  description     TEXT            NULL,
  unit            VARCHAR(20)     NOT NULL DEFAULT 'pc',
  pack_size       VARCHAR(60)     NULL,
  tax_rate        DECIMAL(5,2)    NOT NULL DEFAULT 0,
  default_unit_cost DECIMAL(12,2) NOT NULL DEFAULT 0,   -- moving average, maintained on receipt
  default_sell_price DECIMAL(12,2) NOT NULL DEFAULT 0,
  shelf_life_days INT             NULL,
  is_active       TINYINT(1)      NOT NULL DEFAULT 1,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_product_org_sku (organization_id, sku),
  KEY idx_product_org_active (organization_id, is_active),
  KEY idx_product_category (category_id),
  KEY idx_product_name (organization_id, name),
  CONSTRAINT fk_product_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_product_category FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
  CONSTRAINT ck_product_cost CHECK (default_unit_cost >= 0 AND default_sell_price >= 0),
  CONSTRAINT ck_product_tax  CHECK (tax_rate >= 0)
) ENGINE=InnoDB;

-- Warehouses / godowns. Stock can sit in the shop or in a godown.
CREATE TABLE IF NOT EXISTS warehouses (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id BIGINT UNSIGNED NOT NULL,
  code            VARCHAR(30)     NOT NULL,
  name            VARCHAR(120)    NOT NULL,
  warehouse_type  VARCHAR(20)     NOT NULL DEFAULT 'warehouse',
  address_line    VARCHAR(255)    NULL,
  city            VARCHAR(80)     NULL,
  state           VARCHAR(80)     NULL,
  pincode         VARCHAR(10)     NULL,
  in_use          TINYINT(1)      NOT NULL DEFAULT 1,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_wh_org_code (organization_id, code),
  KEY idx_wh_org (organization_id),
  CONSTRAINT fk_wh_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT ck_wh_type CHECK (warehouse_type IN ('warehouse','godown','cold_storage','returns'))
) ENGINE=InnoDB;

-- Current stock per (store, product). This is a deliberate denormalised
-- projection of stock_movements: it exists so the dashboard can show 5,000 SKUs
-- in one cheap query instead of aggregating the whole ledger every request.
-- It is written inside the same transaction as the ledger rows that cause it,
-- and quantity >= 0 is enforced here as the final guard against negative stock.
CREATE TABLE IF NOT EXISTS inventory (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id BIGINT UNSIGNED NOT NULL,
  store_id        VARCHAR(60)     NOT NULL,
  product_id      BIGINT UNSIGNED NOT NULL,
  warehouse_id    BIGINT UNSIGNED NULL,
  sku             VARCHAR(60)     NOT NULL,          -- denormalised for the existing API
  name            VARCHAR(160)    NOT NULL,          -- denormalised for the existing API
  category        VARCHAR(60)     NULL,              -- denormalised for the existing API
  quantity        DECIMAL(12,3)   NOT NULL DEFAULT 0,
  reserved_qty    DECIMAL(12,3)   NOT NULL DEFAULT 0,
  unit_cost       DECIMAL(12,2)   NOT NULL DEFAULT 0,
  reorder_pt      DECIMAL(12,3)   NOT NULL DEFAULT 0,
  safety_stock    DECIMAL(12,3)   NOT NULL DEFAULT 0,
  monthly_demand  DECIMAL(12,3)   NOT NULL DEFAULT 0, -- denormalised, refreshed by forecast
  max_stock       DECIMAL(12,3)   NOT NULL DEFAULT 0,
  supplier        VARCHAR(120)    NULL,              -- denormalised, see supplier_products
  status          VARCHAR(20)     NOT NULL DEFAULT 'OK',
  last_counted_at DATETIME        NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_inv_store_product (store_id, product_id),
  KEY idx_inv_store_status (store_id, status),
  KEY idx_inv_org (organization_id),
  KEY idx_inv_sku (store_id, sku),
  KEY idx_inv_reorder (store_id, quantity, reorder_pt),
  KEY idx_inv_warehouse (warehouse_id),
  CONSTRAINT fk_inv_org  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_inv_store FOREIGN KEY (store_id) REFERENCES stores(store_id),
  CONSTRAINT fk_inv_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_inv_wh    FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE SET NULL,
  CONSTRAINT ck_inv_qty   CHECK (quantity >= 0 AND reserved_qty >= 0),
  CONSTRAINT ck_inv_reorder CHECK (reorder_pt >= 0 AND safety_stock >= 0),
  CONSTRAINT ck_inv_status CHECK (status IN ('OK','Low','Critical','Overstock'))
) ENGINE=InnoDB;

-- ============================================================================
-- 4. STOCK LEDGER — append-only. Every quantity change is one row.
-- ============================================================================
-- stock_movements is the audit trail of truth for "what arrived, what was sold,
-- what remains". inventory.quantity is derived from it. Rows are never updated
-- or deleted; a mistake is corrected by posting an offsetting movement.
CREATE TABLE IF NOT EXISTS stock_movements (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id BIGINT UNSIGNED NOT NULL,
  store_id        VARCHAR(60)     NOT NULL,
  product_id      BIGINT UNSIGNED NOT NULL,
  warehouse_id    BIGINT UNSIGNED NULL,
  direction       VARCHAR(4)      NOT NULL,           -- IN | OUT
  quantity        DECIMAL(12,3)   NOT NULL,
  balance_after   DECIMAL(12,3)   NULL,               -- running balance, for reconciliation
  unit_cost       DECIMAL(12,2)   NOT NULL DEFAULT 0,
  reason          VARCHAR(30)     NOT NULL,           -- sale | purchase | adjustment | damage | return | opening
  reference_type  VARCHAR(30)     NULL,               -- sales_order | purchase_order | adjustment | import
  reference_id    BIGINT UNSIGNED NULL,
  occurred_at     DATETIME        NOT NULL,           -- business timestamp (store timezone)
  note            VARCHAR(255)    NULL,
  created_by      INT UNSIGNED    NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_sm_store_time (store_id, occurred_at),
  KEY idx_sm_product_time (store_id, product_id, occurred_at),
  KEY idx_sm_org_time (organization_id, occurred_at),
  KEY idx_sm_ref (reference_type, reference_id),
  KEY idx_sm_created_by (created_by),
  CONSTRAINT fk_sm_org  FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_sm_store FOREIGN KEY (store_id) REFERENCES stores(store_id),
  CONSTRAINT fk_sm_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_sm_wh   FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE SET NULL,
  CONSTRAINT fk_sm_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT ck_sm_direction CHECK (direction IN ('IN','OUT')),
  CONSTRAINT ck_sm_quantity CHECK (quantity > 0),
  CONSTRAINT ck_sm_reason CHECK (reason IN
    ('opening','sale','purchase','adjustment','damage','expiry','return','transfer','import'))
) ENGINE=InnoDB;

-- Manual corrections (physical count, damage, expiry). Header + lines so one
-- count sheet covering 30 SKUs is a single auditable document.
CREATE TABLE IF NOT EXISTS stock_adjustments (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  adjustment_no   VARCHAR(40)     NOT NULL,
  organization_id BIGINT UNSIGNED NOT NULL,
  store_id        VARCHAR(60)     NOT NULL,
  warehouse_id    BIGINT UNSIGNED NULL,
  adjustment_type VARCHAR(20)     NOT NULL DEFAULT 'correction',
  status          VARCHAR(20)     NOT NULL DEFAULT 'draft',
  reason          VARCHAR(255)    NULL,
  counted_on      DATE            NOT NULL,
  posted_by       INT UNSIGNED    NULL,
  posted_at       DATETIME        NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_adj_org_no (organization_id, adjustment_no),
  KEY idx_adj_store_date (store_id, counted_on),
  KEY idx_adj_status (organization_id, status),
  CONSTRAINT fk_adj_org  FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_adj_store FOREIGN KEY (store_id) REFERENCES stores(store_id),
  CONSTRAINT fk_adj_wh   FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE SET NULL,
  CONSTRAINT fk_adj_user FOREIGN KEY (posted_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT ck_adj_type CHECK (adjustment_type IN ('correction','damage','expiry','return','opening')),
  CONSTRAINT ck_adj_status CHECK (status IN ('draft','posted','cancelled'))
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS stock_adjustment_items (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  adjustment_id  BIGINT UNSIGNED NOT NULL,
  organization_id BIGINT UNSIGNED NOT NULL,
  product_id     BIGINT UNSIGNED NOT NULL,
  expected_qty   DECIMAL(12,3)   NOT NULL,
  counted_qty    DECIMAL(12,3)   NOT NULL,
  variance_qty   DECIMAL(12,3)   NOT NULL,
  unit_cost      DECIMAL(12,2)   NOT NULL DEFAULT 0,
  note           VARCHAR(255)    NULL,
  UNIQUE KEY uq_adj_item (adjustment_id, product_id),
  KEY idx_adjitem_product (product_id),
  CONSTRAINT fk_adjitem_adj FOREIGN KEY (adjustment_id) REFERENCES stock_adjustments(id) ON DELETE CASCADE,
  CONSTRAINT fk_adjitem_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_adjitem_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT ck_adjitem_qty CHECK (counted_qty >= 0)
) ENGINE=InnoDB;

-- ============================================================================
-- 5. SUPPLIERS
-- ============================================================================
CREATE TABLE IF NOT EXISTS suppliers (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id BIGINT UNSIGNED NOT NULL,
  name            VARCHAR(150)    NOT NULL,
  contact_person  VARCHAR(120)    NULL,
  phone           VARCHAR(20)     NULL,
  email           VARCHAR(255)    NULL,
  gstin           VARCHAR(20)     NULL,
  address_line    VARCHAR(255)    NULL,
  city            VARCHAR(80)     NULL,
  state           VARCHAR(80)     NULL,
  pincode         VARCHAR(10)     NULL,
  payment_terms   VARCHAR(60)     NULL,
  rating          DECIMAL(3,2)    NULL,
  is_active       TINYINT(1)      NOT NULL DEFAULT 1,
  notes           TEXT            NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_supplier_org_name (organization_id, name),
  KEY idx_supplier_active (organization_id, is_active),
  CONSTRAINT fk_supplier_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT ck_supplier_rating CHECK (rating IS NULL OR (rating >= 0 AND rating <= 5))
) ENGINE=InnoDB;

-- Which supplier supplies which product, at what price and pack size.
CREATE TABLE IF NOT EXISTS supplier_products (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id BIGINT UNSIGNED NOT NULL,
  supplier_id     BIGINT UNSIGNED NOT NULL,
  product_id      BIGINT UNSIGNED NOT NULL,
  supplier_sku    VARCHAR(60)     NULL,
  unit_cost       DECIMAL(12,2)   NOT NULL,
  min_order_qty   DECIMAL(12,3)   NOT NULL DEFAULT 0,
  pack_size       VARCHAR(60)     NULL,
  is_preferred    TINYINT(1)      NOT NULL DEFAULT 0,
  is_active       TINYINT(1)      NOT NULL DEFAULT 1,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_supplier_product (supplier_id, product_id),
  KEY idx_sp_product (product_id),
  KEY idx_sp_org_pref (organization_id, is_preferred),
  CONSTRAINT fk_sp_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_sp_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE,
  CONSTRAINT fk_sp_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT ck_sp_cost CHECK (unit_cost >= 0),
  CONSTRAINT ck_sp_min_qty CHECK (min_order_qty >= 0)
) ENGINE=InnoDB;

-- One row per purchase order delivery date. The forecasting model learns the
-- mean/standard deviation of actual lead time from here.
CREATE TABLE IF NOT EXISTS supplier_lead_times (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id BIGINT UNSIGNED NOT NULL,
  supplier_id     BIGINT UNSIGNED NOT NULL,
  product_id      BIGINT UNSIGNED NULL,             -- NULL = supplier-level default
  purchase_order_id BIGINT UNSIGNED NULL,            -- NULL = manual entry
  ordered_on      DATE            NOT NULL,
  received_on     DATE            NULL,
  promised_days   INT             NULL,
  actual_days     INT             NULL,
  is_late         TINYINT(1)      NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_lt_supplier_date (supplier_id, ordered_on),
  KEY idx_lt_product_date (product_id, ordered_on),
  KEY idx_lt_org (organization_id),
  CONSTRAINT fk_lt_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_lt_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE,
  CONSTRAINT fk_lt_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT ck_lt_days CHECK ((actual_days IS NULL OR actual_days >= 0)
                           AND (promised_days IS NULL OR promised_days >= 0))
) ENGINE=InnoDB;

-- purchase_orders is created further down; its FK is attached after that table
-- exists (see the ALTER at the end of section 7).

-- Materialised performance snapshot so the risk screen does not aggregate the
-- whole PO history on every page load. Refreshed by a scheduled job.
CREATE TABLE IF NOT EXISTS supplier_performance (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id    BIGINT UNSIGNED NOT NULL,
  supplier_id        BIGINT UNSIGNED NOT NULL,
  period_start       DATE            NOT NULL,
  period_end         DATE            NOT NULL,
  orders_total       INT             NOT NULL DEFAULT 0,
  orders_delivered   INT             NOT NULL DEFAULT 0,
  orders_late        INT             NOT NULL DEFAULT 0,
  orders_cancelled   INT             NOT NULL DEFAULT 0,
  avg_lead_time_days DECIMAL(6,2)    NULL,
  on_time_rate       DECIMAL(5,2)    NULL,
  fill_rate          DECIMAL(5,2)    NULL,
  quality_score      DECIMAL(5,2)    NULL,
  risk_score         DECIMAL(5,2)    NULL,
  computed_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_perf_supplier_period (supplier_id, period_start, period_end),
  KEY idx_perf_org (organization_id),
  CONSTRAINT fk_perf_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_perf_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================================
-- 6. CUSTOMERS & SALES
-- ============================================================================
CREATE TABLE IF NOT EXISTS customers (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id BIGINT UNSIGNED NOT NULL,
  store_id        VARCHAR(60)     NOT NULL,
  name            VARCHAR(150)    NOT NULL,
  customer_type   VARCHAR(30)     NOT NULL DEFAULT 'retail',
  contact_person  VARCHAR(120)    NULL,
  phone           VARCHAR(20)     NULL,
  email           VARCHAR(255)    NULL,
  city            VARCHAR(80)     NULL,
  gstin           VARCHAR(20)     NULL,
  credit_limit    DECIMAL(12,2)   NOT NULL DEFAULT 0,
  outstanding     DECIMAL(12,2)   NOT NULL DEFAULT 0,
  is_active       TINYINT(1)      NOT NULL DEFAULT 1,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_customer_store_name (store_id, name),
  KEY idx_customer_org (organization_id),
  CONSTRAINT fk_customer_org  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_customer_store FOREIGN KEY (store_id) REFERENCES stores(store_id),
  CONSTRAINT ck_customer_type CHECK (customer_type IN
    ('retail','wholesale','contract','online','institutional')),
  CONSTRAINT ck_customer_credit CHECK (credit_limit >= 0 AND outstanding >= 0)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sales_orders (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id BIGINT UNSIGNED NOT NULL,
  store_id        VARCHAR(60)     NOT NULL,
  order_no        VARCHAR(60)     NOT NULL,
  customer_id     BIGINT UNSIGNED NULL,             -- NULL = walk-in / counter sale
  order_date      DATE            NOT NULL,         -- business date in store timezone
  channel         VARCHAR(20)     NOT NULL DEFAULT 'counter',
  status          VARCHAR(20)     NOT NULL DEFAULT 'completed',
  payment_mode    VARCHAR(20)     NOT NULL DEFAULT 'cash',
  subtotal        DECIMAL(12,2)   NOT NULL DEFAULT 0,
  discount_total  DECIMAL(12,2)   NOT NULL DEFAULT 0,
  tax_total       DECIMAL(12,2)   NOT NULL DEFAULT 0,
  total_amount    DECIMAL(12,2)   NOT NULL DEFAULT 0,
  cost_total      DECIMAL(12,2)   NOT NULL DEFAULT 0, -- COGS snapshot, profit is derived
  note            VARCHAR(255)    NULL,
  created_by      INT UNSIGNED    NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_salesorder_store_no (store_id, order_no),
  KEY idx_so_store_date (store_id, order_date),
  KEY idx_so_org_date (organization_id, order_date),
  KEY idx_so_customer (customer_id),
  KEY idx_so_status (store_id, status),
  CONSTRAINT fk_so_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_so_store FOREIGN KEY (store_id) REFERENCES stores(store_id),
  CONSTRAINT fk_so_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
  CONSTRAINT fk_so_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT ck_so_channel CHECK (channel IN
    ('counter','phone','whatsapp','website','marketplace','bulk')),
  CONSTRAINT ck_so_status CHECK (status IN ('draft','completed','cancelled','returned')),
  CONSTRAINT ck_so_payment CHECK (payment_mode IN
    ('cash','upi','card','credit','bank_transfer')),
  CONSTRAINT ck_so_money CHECK (subtotal >= 0 AND total_amount >= 0 AND discount_total >= 0)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sales_order_items (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id BIGINT UNSIGNED NOT NULL,
  sales_order_id  BIGINT UNSIGNED NOT NULL,
  product_id      BIGINT UNSIGNED NOT NULL,
  quantity        DECIMAL(12,3)   NOT NULL,
  unit_price      DECIMAL(12,2)   NOT NULL,
  unit_cost       DECIMAL(12,2)   NOT NULL DEFAULT 0,  -- COGS at time of sale
  discount_amount DECIMAL(12,2)   NOT NULL DEFAULT 0,
  tax_rate        DECIMAL(5,2)    NOT NULL DEFAULT 0,
  line_total      DECIMAL(12,2)   NOT NULL DEFAULT 0,
  UNIQUE KEY uq_soi_order_product (sales_order_id, product_id),
  KEY idx_soi_product (product_id),
  KEY idx_soi_order (sales_order_id),
  CONSTRAINT fk_soi_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_soi_order FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_soi_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT ck_soi_qty CHECK (quantity > 0),
  CONSTRAINT ck_soi_money CHECK (unit_price >= 0 AND unit_cost >= 0 AND discount_amount >= 0)
) ENGINE=InnoDB;

-- Daily rollup kept ONLY because the existing dashboard reads it. It is derived
-- data: maintained in the same transaction that writes sales_order_items, and
-- rebuildable at any time from those lines. Never the source of truth.
CREATE TABLE IF NOT EXISTS sales (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id BIGINT UNSIGNED NOT NULL,
  store_id        VARCHAR(60)     NOT NULL,
  date            DATE            NOT NULL,
  sales           DECIMAL(12,2)   NOT NULL DEFAULT 0,
  profit          DECIMAL(12,2)   NOT NULL DEFAULT 0,
  units_sold      DECIMAL(12,3)   NOT NULL DEFAULT 0,
  orders_count    INT             NOT NULL DEFAULT 0,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sales_store_date (store_id, date),
  KEY idx_sales_org_date (organization_id, date),
  CONSTRAINT fk_sales_org  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_sales_store FOREIGN KEY (store_id) REFERENCES stores(store_id) ON DELETE CASCADE,
  CONSTRAINT ck_sales_amounts CHECK (sales >= 0)
) ENGINE=InnoDB;

-- ============================================================================
-- 7. PURCHASING
-- ============================================================================
CREATE TABLE IF NOT EXISTS purchase_orders (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id BIGINT UNSIGNED NOT NULL,
  store_id        VARCHAR(60)     NOT NULL,
  po_no           VARCHAR(40)     NOT NULL,
  supplier_id     BIGINT UNSIGNED NOT NULL,
  order_date      DATE            NOT NULL,
  expected_date   DATE            NULL,
  status          VARCHAR(20)     NOT NULL DEFAULT 'draft',
  payment_terms   VARCHAR(60)     NULL,
  subtotal        DECIMAL(12,2)   NOT NULL DEFAULT 0,
  tax_total       DECIMAL(12,2)   NOT NULL DEFAULT 0,
  total_amount    DECIMAL(12,2)   NOT NULL DEFAULT 0,
  delivered_qty   DECIMAL(12,3)   NOT NULL DEFAULT 0,
  note            VARCHAR(255)    NULL,
  source          VARCHAR(20)     NOT NULL DEFAULT 'manual',  -- manual | replenishment | import
  recommendation_id BIGINT UNSIGNED NULL,
  created_by      INT UNSIGNED    NULL,
  approved_by     INT UNSIGNED    NULL,
  approved_at     DATETIME        NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_po_store_no (store_id, po_no),
  KEY idx_po_store_date (store_id, order_date),
  KEY idx_po_supplier_status (supplier_id, status),
  KEY idx_po_expected (store_id, expected_date, status),
  KEY idx_po_org (organization_id),
  CONSTRAINT fk_po_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_po_store FOREIGN KEY (store_id) REFERENCES stores(store_id),
  CONSTRAINT fk_po_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  CONSTRAINT fk_po_user_created FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_po_user_approved FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT ck_po_status CHECK (status IN
    ('draft','pending_approval','approved','ordered','part_received','received','cancelled')),
  CONSTRAINT ck_po_source CHECK (source IN ('manual','replenishment','import')),
  CONSTRAINT ck_po_money CHECK (subtotal >= 0 AND total_amount >= 0)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id BIGINT UNSIGNED NOT NULL,
  purchase_order_id BIGINT UNSIGNED NOT NULL,
  product_id      BIGINT UNSIGNED NOT NULL,
  quantity        DECIMAL(12,3)   NOT NULL,
  received_qty    DECIMAL(12,3)   NOT NULL DEFAULT 0,
  unit_cost       DECIMAL(12,2)   NOT NULL,
  tax_rate        DECIMAL(5,2)    NOT NULL DEFAULT 0,
  line_total      DECIMAL(12,2)   NOT NULL DEFAULT 0,
  UNIQUE KEY uq_poi_order_product (purchase_order_id, product_id),
  KEY idx_poi_product (product_id),
  CONSTRAINT fk_poi_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_poi_order FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_poi_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT ck_poi_qty CHECK (quantity > 0 AND received_qty >= 0),
  CONSTRAINT ck_poi_cost CHECK (unit_cost >= 0)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS purchase_order_status_history (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id BIGINT UNSIGNED NOT NULL,
  purchase_order_id BIGINT UNSIGNED NOT NULL,
  from_status     VARCHAR(20)     NULL,
  to_status       VARCHAR(20)     NOT NULL,
  remark          VARCHAR(255)    NULL,
  changed_by      INT UNSIGNED    NULL,
  changed_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_posh_order_time (purchase_order_id, changed_at),
  KEY idx_posh_org (organization_id),
  CONSTRAINT fk_posh_order FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_posh_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_posh_user FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- A delivery is a physical receipt against a PO (may be partial, may be split
-- across several trips). Receiving posts stock_movements + updates inventory.
CREATE TABLE IF NOT EXISTS deliveries (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id BIGINT UNSIGNED NOT NULL,
  store_id        VARCHAR(60)     NOT NULL,
  purchase_order_id BIGINT UNSIGNED NOT NULL,
  delivery_no     VARCHAR(40)     NOT NULL,
  supplier_id     BIGINT UNSIGNED NOT NULL,
  received_on     DATE            NOT NULL,
  invoice_no      VARCHAR(60)     NULL,
  invoice_amount  DECIMAL(12,2)   NULL,
  transport_mode  VARCHAR(30)     NULL,
  status          VARCHAR(20)     NOT NULL DEFAULT 'received',
  received_by     INT UNSIGNED    NULL,
  note            VARCHAR(255)    NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_delivery_store_no (store_id, delivery_no),
  KEY idx_delivery_po (purchase_order_id),
  KEY idx_delivery_supplier_date (supplier_id, received_on),
  CONSTRAINT fk_del_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_del_store FOREIGN KEY (store_id) REFERENCES stores(store_id),
  CONSTRAINT fk_del_po FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_del_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  CONSTRAINT fk_del_user FOREIGN KEY (received_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT ck_del_status CHECK (status IN ('received','partial','returned')),
  CONSTRAINT ck_del_transport CHECK (transport_mode IS NULL OR transport_mode IN
    ('own_vehicle','courier','transporters','supporter','handcart','other'))
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS delivery_items (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id BIGINT UNSIGNED NOT NULL,
  delivery_id  BIGINT UNSIGNED NOT NULL,
  product_id   BIGINT UNSIGNED NOT NULL,
  quantity     DECIMAL(12,3)   NOT NULL,
  unit_cost    DECIMAL(12,2)   NOT NULL DEFAULT 0,
  accepted     TINYINT(1)      NOT NULL DEFAULT 1,   -- 0 = rejected at the gate
  damage_note  VARCHAR(255)    NULL,
  UNIQUE KEY uq_delitem_delivery_product (delivery_id, product_id),
  KEY idx_delitem_product (product_id),
  CONSTRAINT fk_delitem_del FOREIGN KEY (delivery_id) REFERENCES deliveries(id) ON DELETE CASCADE,
  CONSTRAINT fk_delitem_org  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_delitem_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT ck_delitem_qty CHECK (quantity > 0)
) ENGINE=InnoDB;

-- Close the one cycle in the dependency graph: supplier_lead_times (section 5)
-- references purchase_orders, which only exists now. Guarded so a re-run is safe.
SET @ddl := IF(EXISTS (
      SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
       WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'supplier_lead_times'
         AND CONSTRAINT_NAME = 'fk_lt_po'),
    'DO 0',
    'ALTER TABLE supplier_lead_times ADD CONSTRAINT fk_lt_po
       FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id) ON DELETE SET NULL');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ============================================================================
-- 8. FORECASTING (analytical — never used to compute profit or stock)
-- ============================================================================
CREATE TABLE IF NOT EXISTS forecast_runs (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id BIGINT UNSIGNED NOT NULL,
  store_id        VARCHAR(60)     NOT NULL,
  run_key         VARCHAR(64)     NOT NULL,
  model_name      VARCHAR(60)     NOT NULL DEFAULT 'auto',
  horizon_days    INT             NOT NULL DEFAULT 30,
  bucket          VARCHAR(10)     NOT NULL DEFAULT 'day',
  window_start    DATE            NOT NULL,
  window_end      DATE            NOT NULL,
  status          VARCHAR(20)     NOT NULL DEFAULT 'queued',
  products_count  INT             NOT NULL DEFAULT 0,
  metrics         JSON            NULL,               -- MAPE/WAPE/MAE/RMSE for the run
  error_message   VARCHAR(500)    NULL,
  started_at      DATETIME        NULL,
  finished_at     DATETIME        NULL,
  created_by      INT UNSIGNED    NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_frun_org_key (organization_id, run_key),
  KEY idx_frun_store_time (store_id, created_at),
  KEY idx_frun_status (organization_id, status),
  CONSTRAINT fk_frun_org  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_frun_store FOREIGN KEY (store_id) REFERENCES stores(store_id) ON DELETE CASCADE,
  CONSTRAINT fk_frun_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT ck_frun_status CHECK (status IN ('queued','running','succeeded','failed')),
  CONSTRAINT ck_frun_horizon CHECK (horizon_days > 0),
  CONSTRAINT ck_frun_window CHECK (window_end >= window_start)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS forecast_results (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  forecast_run_id BIGINT UNSIGNED NOT NULL,
  organization_id BIGINT UNSIGNED NOT NULL,
  store_id        VARCHAR(60)     NOT NULL,
  product_id      BIGINT UNSIGNED NOT NULL,
  forecast_date   DATE            NOT NULL,
  p10_qty         DECIMAL(12,3)   NOT NULL DEFAULT 0,  -- lower bound (safety)
  p50_qty         DECIMAL(12,3)   NOT NULL DEFAULT 0,  -- point estimate
  p90_qty         DECIMAL(12,3)   NOT NULL DEFAULT 0,  -- upper bound
  stockout_risk   DECIMAL(5,2)    NOT NULL DEFAULT 0,  -- 0..100
  UNIQUE KEY uq_fr_result (forecast_run_id, product_id, forecast_date),
  KEY idx_fr_store_date (store_id, forecast_date),
  KEY idx_fr_product_date (product_id, forecast_date),
  KEY idx_fr_org_date (organization_id, forecast_date),
  CONSTRAINT fk_fr_run FOREIGN KEY (forecast_run_id) REFERENCES forecast_runs(id) ON DELETE CASCADE,
  CONSTRAINT fk_fr_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_fr_store FOREIGN KEY (store_id) REFERENCES stores(store_id),
  CONSTRAINT fk_fr_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT ck_fr_nonneg CHECK (p10_qty >= 0 AND p50_qty >= 0 AND p90_qty >= 0),
  CONSTRAINT ck_fr_risk CHECK (stockout_risk >= 0 AND stockout_risk <= 100)
) ENGINE=InnoDB;

-- Per-product error metrics, so a weak product can be excluded from the
-- replenishment engine instead of being confidently wrong.
CREATE TABLE IF NOT EXISTS model_metrics (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  forecast_run_id BIGINT UNSIGNED NOT NULL,
  organization_id BIGINT UNSIGNED NOT NULL,
  store_id        VARCHAR(60)     NOT NULL,
  product_id      BIGINT UNSIGNED NOT NULL,
  model_name      VARCHAR(60)     NOT NULL,
  mape            DECIMAL(8,4)    NULL,
  wape            DECIMAL(8,4)    NULL,
  mae             DECIMAL(12,4)   NULL,
  rmse            DECIMAL(12,4)   NULL,
  bias            DECIMAL(12,4)   NULL,
  observations    INT             NOT NULL DEFAULT 0,
  is_reliable     TINYINT(1)      NOT NULL DEFAULT 1,
  computed_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_metric (forecast_run_id, product_id, model_name),
  KEY idx_metric_product (product_id),
  CONSTRAINT fk_metric_run FOREIGN KEY (forecast_run_id) REFERENCES forecast_runs(id) ON DELETE CASCADE,
  CONSTRAINT fk_metric_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_metric_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT ck_metric_obs CHECK (observations >= 0)
) ENGINE=InnoDB;

-- ============================================================================
-- 9. RISK, ALERTS & NOTIFICATIONS
-- ============================================================================
-- risk_records = the current known risk per subject (one live row per subject).
-- risk_assessments = an append-only history of every scoring pass, so a score
-- change can always be explained.
CREATE TABLE IF NOT EXISTS risk_records (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id BIGINT UNSIGNED NOT NULL,
  store_id        VARCHAR(60)     NOT NULL,
  risk_type       VARCHAR(40)     NOT NULL,
  subject_type    VARCHAR(30)     NOT NULL,           -- supplier | product | purchase_order
  subject_id      BIGINT UNSIGNED NOT NULL,
  severity        VARCHAR(20)     NOT NULL DEFAULT 'low',
  likelihood      DECIMAL(5,2)    NULL,
  risk_score      DECIMAL(5,2)    NOT NULL DEFAULT 0,
  title           VARCHAR(180)    NOT NULL,
  detail          TEXT            NULL,
  detected_on     DATE            NOT NULL,
  status          VARCHAR(20)     NOT NULL DEFAULT 'open',
  is_open         TINYINT(1)      NOT NULL DEFAULT 1,
  detected_by     INT UNSIGNED    NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_risk_subject (store_id, risk_type, subject_type, subject_id, is_open),
  KEY idx_risk_store_status (store_id, status),
  KEY idx_risk_severity (organization_id, severity, is_open),
  KEY idx_risk_type (risk_type),
  CONSTRAINT fk_risk_org  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_risk_store FOREIGN KEY (store_id) REFERENCES stores(store_id) ON DELETE CASCADE,
  CONSTRAINT fk_risk_user FOREIGN KEY (detected_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT ck_risk_type CHECK (risk_type IN
    ('stockout','overstock','slow_moving','supplier_delay','supplier_quality',
     'price_spike','expiry','demand_spike','data_quality')),
  CONSTRAINT ck_risk_subject_type CHECK (subject_type IN ('supplier','product','purchase_order')),
  CONSTRAINT ck_risk_severity CHECK (severity IN ('low','medium','high','critical')),
  CONSTRAINT ck_risk_status CHECK (status IN ('open','acknowledged','in_progress','resolved','ignored'))
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS risk_assessments (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  risk_record_id BIGINT UNSIGNED NOT NULL,
  organization_id BIGINT UNSIGNED NOT NULL,
  assessed_by  INT UNSIGNED    NULL,                 -- NULL = automated job
  method       VARCHAR(60)     NOT NULL DEFAULT 'rule', -- rule | model
  score        DECIMAL(5,2)    NOT NULL,
  severity     VARCHAR(20)     NOT NULL,
  factors      JSON            NULL,                 -- which inputs moved the score
  note         VARCHAR(500)    NULL,
  assessed_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ra_risk_time (risk_record_id, assessed_at),
  KEY idx_ra_org_time (organization_id, assessed_at),
  CONSTRAINT fk_ra_risk FOREIGN KEY (risk_record_id) REFERENCES risk_records(id) ON DELETE CASCADE,
  CONSTRAINT fk_ra_org  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_ra_user FOREIGN KEY (assessed_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT ck_ra_severity CHECK (severity IN ('low','medium','high','critical')),
  CONSTRAINT ck_ra_score CHECK (score >= 0 AND score <= 100)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS alerts (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id BIGINT UNSIGNED NOT NULL,
  store_id        VARCHAR(60)     NOT NULL,
  risk_record_id  BIGINT UNSIGNED NULL,
  alert_type      VARCHAR(40)     NOT NULL,
  severity        VARCHAR(20)     NOT NULL DEFAULT 'info',
  title           VARCHAR(180)    NOT NULL,
  message         VARCHAR(500)    NOT NULL,
  payload         JSON            NULL,              -- deep-link context for the UI
  action_url      VARCHAR(255)    NULL,
  status          VARCHAR(20)     NOT NULL DEFAULT 'unread',
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at         DATETIME        NULL,
  KEY idx_alert_store_status (store_id, status, created_at),
  KEY idx_alert_org_severity (organization_id, severity),
  KEY idx_alert_risk (risk_record_id),
  CONSTRAINT fk_alert_org  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_alert_store FOREIGN KEY (store_id) REFERENCES stores(store_id) ON DELETE CASCADE,
  CONSTRAINT fk_alert_risk FOREIGN KEY (risk_record_id) REFERENCES risk_records(id) ON DELETE SET NULL,
  CONSTRAINT ck_alert_severity CHECK (severity IN ('info','low','medium','high','critical')),
  CONSTRAINT ck_alert_status CHECK (status IN ('unread','read','acknowledged','resolved','dismissed'))
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS alert_resolutions (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  alert_id   BIGINT UNSIGNED NOT NULL,
  organization_id BIGINT UNSIGNED NOT NULL,
  action_taken VARCHAR(120) NOT NULL,
  note       VARCHAR(500)    NULL,
  resolved_by INT UNSIGNED   NULL,
  resolved_at DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_alertres_alert (alert_id),
  CONSTRAINT fk_alertres_alert FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE,
  CONSTRAINT fk_alertres_org  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_alertres_user FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS notification_preferences (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id         INT UNSIGNED    NOT NULL,
  organization_id BIGINT UNSIGNED NULL,
  store_id        VARCHAR(60)     NULL,
  channel         VARCHAR(20)     NOT NULL DEFAULT 'in_app',
  alert_type      VARCHAR(40)     NOT NULL DEFAULT 'all',
  is_enabled      TINYINT(1)      NOT NULL DEFAULT 1,
  min_severity    VARCHAR(20)     NOT NULL DEFAULT 'medium',
  quiet_hours_from TIME          NULL,
  quiet_hours_to   TIME          NULL,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_notifpref (user_id, organization_id, store_id, channel, alert_type),
  KEY idx_notifpref_user (user_id),
  CONSTRAINT fk_notifpref_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_notifpref_org  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_notifpref_store FOREIGN KEY (store_id) REFERENCES stores(store_id) ON DELETE CASCADE,
  CONSTRAINT ck_notifpref_channel CHECK (channel IN ('in_app','email','sms','whatsapp')),
  CONSTRAINT ck_notifpref_severity CHECK (min_severity IN ('info','low','medium','high','critical'))
) ENGINE=InnoDB;

-- ============================================================================
-- 10. REPLENISHMENT — "what to order tomorrow, how much, from whom"
-- ============================================================================
CREATE TABLE IF NOT EXISTS replenishment_recommendations (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id BIGINT UNSIGNED NOT NULL,
  store_id        VARCHAR(60)     NOT NULL,
  recommendation_no VARCHAR(40)   NOT NULL,
  recommendation_date DATE        NOT NULL,
  status          VARCHAR(20)     NOT NULL DEFAULT 'draft',
  strategy        VARCHAR(30)     NOT NULL DEFAULT 'forecast',  -- forecast | rule | manual
  total_items     INT             NOT NULL DEFAULT 0,
  estimated_value DECIMAL(12,2)   NOT NULL DEFAULT 0,
  forecast_run_id BIGINT UNSIGNED NULL,
  generated_by    INT UNSIGNED    NULL,
  generated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_by     INT UNSIGNED    NULL,
  approved_at     DATETIME        NULL,
  purchase_order_id BIGINT UNSIGNED NULL,
  note            VARCHAR(255)    NULL,
  UNIQUE KEY uq_reco_org_no (organization_id, recommendation_no),
  KEY idx_reco_store_date (store_id, recommendation_date),
  KEY idx_reco_status (store_id, status),
  KEY idx_reco_org (organization_id),
  CONSTRAINT fk_reco_org  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_reco_store FOREIGN KEY (store_id) REFERENCES stores(store_id),
  CONSTRAINT fk_reco_run FOREIGN KEY (forecast_run_id) REFERENCES forecast_runs(id) ON DELETE SET NULL,
  CONSTRAINT fk_reco_user_gen FOREIGN KEY (generated_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_reco_user_appr FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_reco_po FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id) ON DELETE SET NULL,
  CONSTRAINT ck_reco_status CHECK (status IN ('draft','pending_approval','approved','rejected','ordered')),
  CONSTRAINT ck_reco_strategy CHECK (strategy IN ('forecast','rule','manual')),
  CONSTRAINT ck_reco_items CHECK (total_items >= 0 AND estimated_value >= 0)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS replenishment_recommendation_items (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  recommendation_id    BIGINT UNSIGNED NOT NULL,
  organization_id      BIGINT UNSIGNED NOT NULL,
  store_id             VARCHAR(60)     NOT NULL,
  product_id           BIGINT UNSIGNED NOT NULL,
  suggested_supplier_id BIGINT UNSIGNED NULL,
  current_qty          DECIMAL(12,3)   NOT NULL DEFAULT 0,
  demand_horizon_qty   DECIMAL(12,3)   NOT NULL DEFAULT 0,
  safety_stock_qty     DECIMAL(12,3)   NOT NULL DEFAULT 0,
  suggested_qty        DECIMAL(12,3)   NOT NULL DEFAULT 0,
  unit_cost            DECIMAL(12,2)   NOT NULL DEFAULT 0,
  line_value           DECIMAL(12,2)   NOT NULL DEFAULT 0,
  stockout_risk        DECIMAL(5,2)    NOT NULL DEFAULT 0,
  priority             VARCHAR(20)     NOT NULL DEFAULT 'medium',
  rationale            VARCHAR(255)    NULL,
  approved_qty         DECIMAL(12,3)   NULL,
  is_approved          TINYINT(1)      NOT NULL DEFAULT 0,
  UNIQUE KEY uq_recoitem (recommendation_id, product_id),
  KEY idx_recoitem_store (store_id, priority),
  KEY idx_recoitem_product (product_id),
  CONSTRAINT fk_recoitem_reco FOREIGN KEY (recommendation_id)
    REFERENCES replenishment_recommendations(id) ON DELETE CASCADE,
  CONSTRAINT fk_recoitem_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_recoitem_store FOREIGN KEY (store_id) REFERENCES stores(store_id),
  CONSTRAINT fk_recoitem_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_recoitem_supplier FOREIGN KEY (suggested_supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL,
  CONSTRAINT ck_recoitem_qty CHECK (suggested_qty >= 0 AND current_qty >= 0),
  CONSTRAINT ck_recoitem_priority CHECK (priority IN ('low','medium','high','urgent'))
) ENGINE=InnoDB;

-- Multi-step approval trail. Small Indian businesses often need owner sign-off
-- above a spend threshold, which is exactly what this table records.
CREATE TABLE IF NOT EXISTS replenishment_approvals (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id   BIGINT UNSIGNED NOT NULL,
  recommendation_id BIGINT UNSIGNED NOT NULL,
  step_no           INT             NOT NULL,
  required_role     VARCHAR(40)     NOT NULL DEFAULT 'manager',
  approver_user_id  INT UNSIGNED    NULL,
  status            VARCHAR(20)     NOT NULL DEFAULT 'pending',
  threshold_amount  DECIMAL(12,2)   NULL,
  comment           VARCHAR(255)    NULL,
  decided_at        DATETIME        NULL,
  created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_approval_step (recommendation_id, step_no),
  KEY idx_approval_pending (organization_id, status),
  CONSTRAINT fk_approval_reco FOREIGN KEY (recommendation_id)
    REFERENCES replenishment_recommendations(id) ON DELETE CASCADE,
  CONSTRAINT fk_approval_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_approval_user FOREIGN KEY (approver_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT ck_approval_status CHECK (status IN ('pending','approved','rejected','skipped'))
) ENGINE=InnoDB;

-- ============================================================================
-- 11. REPORTS
-- ============================================================================
CREATE TABLE IF NOT EXISTS reports (
  id           SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  report_key   VARCHAR(60)      NOT NULL,
  name         VARCHAR(120)     NOT NULL,
  category     VARCHAR(40)      NOT NULL DEFAULT 'operations',
  description  VARCHAR(255)     NULL,
  default_format VARCHAR(20)    NOT NULL DEFAULT 'xlsx',
  is_active    TINYINT(1)       NOT NULL DEFAULT 1,
  created_at   DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_report_key (report_key),
  CONSTRAINT ck_report_format CHECK (default_format IN ('xlsx','csv','pdf','json'))
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS report_runs (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id BIGINT UNSIGNED NOT NULL,
  store_id        VARCHAR(60)     NULL,              -- NULL = org-wide
  report_id       SMALLINT UNSIGNED NOT NULL,
  period_start    DATE            NOT NULL,
  period_end      DATE            NOT NULL,
  status          VARCHAR(20)     NOT NULL DEFAULT 'queued',
  parameters      JSON            NULL,              -- filters chosen by the user
  row_count       INT             NULL,
  error_message   VARCHAR(500)    NULL,
  requested_by    INT UNSIGNED    NULL,
  started_at      DATETIME        NULL,
  finished_at     DATETIME        NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_rprun_store_time (store_id, created_at),
  KEY idx_rprun_report (report_id),
  KEY idx_rprun_status (organization_id, status),
  CONSTRAINT fk_rprun_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_rprun_store FOREIGN KEY (store_id) REFERENCES stores(store_id) ON DELETE CASCADE,
  CONSTRAINT fk_rprun_report FOREIGN KEY (report_id) REFERENCES reports(id),
  CONSTRAINT fk_rprun_user FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT ck_rprun_status CHECK (status IN ('queued','running','succeeded','failed')),
  CONSTRAINT ck_rprun_period CHECK (period_end >= period_start)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS report_exports (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  report_run_id BIGINT UNSIGNED NOT NULL,
  organization_id BIGINT UNSIGNED NOT NULL,
  file_name    VARCHAR(255)    NOT NULL,
  file_path    VARCHAR(500)    NULL,
  format       VARCHAR(20)     NOT NULL,
  size_bytes   BIGINT UNSIGNED NULL,
  row_count    INT             NULL,
  downloaded_by INT UNSIGNED   NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_export_run (report_run_id),
  CONSTRAINT fk_export_run FOREIGN KEY (report_run_id) REFERENCES report_runs(id) ON DELETE CASCADE,
  CONSTRAINT fk_export_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_export_user FOREIGN KEY (downloaded_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT ck_export_format CHECK (format IN ('xlsx','csv','pdf','json'))
) ENGINE=InnoDB;

-- ============================================================================
-- 12. DATA IMPORT — upload → validate → preview → confirm → commit
-- ============================================================================
CREATE TABLE IF NOT EXISTS import_jobs (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  job_key         VARCHAR(64)     NOT NULL,
  organization_id BIGINT UNSIGNED NOT NULL,
  store_id        VARCHAR(60)     NOT NULL,
  entity_type     VARCHAR(30)     NOT NULL,           -- products | opening_stock | sales | suppliers | purchase_orders
  file_name       VARCHAR(255)    NOT NULL,
  file_size_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  file_checksum   CHAR(64)        NULL,              -- SHA-256; blocks re-uploading the same file
  status          VARCHAR(20)     NOT NULL DEFAULT 'uploaded',
  total_rows      INT             NOT NULL DEFAULT 0,
  valid_rows      INT             NOT NULL DEFAULT 0,
  error_rows      INT             NOT NULL DEFAULT 0,
  created_rows    INT             NOT NULL DEFAULT 0,
  updated_rows    INT             NOT NULL DEFAULT 0,
  skipped_rows    INT             NOT NULL DEFAULT 0,
  preview_data    MEDIUMTEXT      NULL,              -- JSON preview, discarded after commit
  error_message   VARCHAR(500)    NULL,
  started_by      INT UNSIGNED    NULL,
  validated_at    DATETIME        NULL,
  committed_at    DATETIME        NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_import_job_key (organization_id, job_key),
  KEY idx_import_store_status (store_id, status),
  KEY idx_import_checksum (organization_id, file_checksum),
  CONSTRAINT fk_import_org  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_import_store FOREIGN KEY (store_id) REFERENCES stores(store_id),
  CONSTRAINT fk_import_user FOREIGN KEY (started_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT ck_import_status CHECK (status IN
    ('uploaded','validating','invalid','ready','committing','completed','failed','cancelled')),
  CONSTRAINT ck_import_entity CHECK (entity_type IN
    ('products','opening_stock','stock_movements','sales','suppliers','purchase_orders')),
  CONSTRAINT ck_import_counts CHECK (total_rows >= 0 AND valid_rows >= 0 AND error_rows >= 0)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS import_files (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  import_job_id BIGINT UNSIGNED NOT NULL,
  organization_id BIGINT UNSIGNED NOT NULL,
  stored_name  VARCHAR(255)    NOT NULL,              -- never expose the on-disk path to the client
  storage_path VARCHAR(500)    NULL,
  mime_type    VARCHAR(100)    NULL,
  size_bytes   BIGINT UNSIGNED NOT NULL DEFAULT 0,
  uploaded_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_importfile_stored (stored_name),
  KEY idx_importfile_job (import_job_id),
  CONSTRAINT fk_importfile_job FOREIGN KEY (import_job_id) REFERENCES import_jobs(id) ON DELETE CASCADE,
  CONSTRAINT fk_importfile_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- One row per rejected CSV line, with the exact column and message the shop
-- owner needs to fix it.
CREATE TABLE IF NOT EXISTS import_row_errors (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  import_job_id BIGINT UNSIGNED NOT NULL,
  organization_id BIGINT UNSIGNED NOT NULL,
  row_no        INT             NOT NULL,             -- 1-based line number in the CSV
  column_name   VARCHAR(60)     NULL,
  raw_value     VARCHAR(255)    NULL,
  error_code    VARCHAR(40)     NOT NULL,
  error_message VARCHAR(300)    NOT NULL,
  raw_row       JSON            NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rowerr (import_job_id, row_no, column_name),
  KEY idx_rowerr_job (import_job_id),
  CONSTRAINT fk_rowerr_job FOREIGN KEY (import_job_id) REFERENCES import_jobs(id) ON DELETE CASCADE,
  CONSTRAINT fk_rowerr_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT ck_rowerr_row CHECK (row_no > 0)
) ENGINE=InnoDB;

-- ============================================================================
-- 13. AUDIT, SETTINGS & AI CONFIG
-- ============================================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id BIGINT UNSIGNED NULL,
  store_id        VARCHAR(60)     NULL,
  user_id         INT UNSIGNED    NULL,
  actor_email     VARCHAR(255)    NULL,
  action          VARCHAR(50)     NOT NULL,           -- create | update | delete | login | export | import
  entity_type     VARCHAR(50)     NOT NULL,
  entity_id       VARCHAR(60)     NULL,
  before_value    JSON            NULL,
  after_value     JSON            NULL,
  ip_address      VARCHAR(45)     NULL,
  user_agent      VARCHAR(255)    NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_org_time (organization_id, created_at),
  KEY idx_audit_user_time (user_id, created_at),
  KEY idx_audit_entity (entity_type, entity_id),
  KEY idx_audit_store_time (store_id, created_at),
  CONSTRAINT fk_audit_org  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL,
  CONSTRAINT fk_audit_store FOREIGN KEY (store_id) REFERENCES stores(store_id) ON DELETE SET NULL,
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS organization_settings (
  organization_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  settings        JSON            NOT NULL,
  updated_by      INT UNSIGNED    NULL,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_orgset_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_orgset_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ai_configurations (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id BIGINT UNSIGNED NOT NULL,
  module          VARCHAR(40)     NOT NULL,           -- forecast | risk | replenishment | chat
  is_enabled      TINYINT(1)      NOT NULL DEFAULT 1,
  provider        VARCHAR(40)     NOT NULL DEFAULT 'builtin',
  model_name      VARCHAR(80)     NULL,
  config          JSON            NULL,               -- thresholds, horizons, temperature
  updated_by      INT UNSIGNED    NULL,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_aiconfig_org_module (organization_id, module),
  CONSTRAINT fk_aiconfig_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_aiconfig_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT ck_aiconfig_module CHECK (module IN ('forecast','risk','replenishment','chat','anomaly'))
) ENGINE=InnoDB;