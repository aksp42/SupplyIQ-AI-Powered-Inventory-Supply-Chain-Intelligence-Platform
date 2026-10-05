-- ============================================================================
-- 001_core_schema — rollback
--
-- Drops the SupplyIQ schema in reverse dependency order.
--
-- The runner (backend/scripts/migrate.js) checks BUSINESS_TABLES for live rows
-- BEFORE it executes this file and refuses to run while business data exists,
-- so no data can be lost by an accidental rollback.
--
-- schema_migrations is intentionally NOT dropped here — the runner deletes this
-- migration's own row from it immediately afterwards.
--
-- Back up first:  mysqldump -u root -p supplyiq > supplyiq-backup.sql
-- ============================================================================
USE supplyiq;

-- Cross-links that span the dependency order.
ALTER TABLE supplier_lead_times DROP FOREIGN KEY fk_lt_po;
ALTER TABLE users            DROP FOREIGN KEY fk_users_store;
ALTER TABLE organizations    DROP FOREIGN KEY fk_org_owner;

-- AI config, settings, audit
DROP TABLE IF EXISTS ai_configurations;
DROP TABLE IF EXISTS organization_settings;
DROP TABLE IF EXISTS audit_logs;

-- Data import
DROP TABLE IF EXISTS import_row_errors;
DROP TABLE IF EXISTS import_files;
DROP TABLE IF EXISTS import_jobs;

-- Reports
DROP TABLE IF EXISTS report_exports;
DROP TABLE IF EXISTS report_runs;
DROP TABLE IF EXISTS reports;

-- Replenishment
DROP TABLE IF EXISTS replenishment_approvals;
DROP TABLE IF EXISTS replenishment_recommendation_items;
DROP TABLE IF EXISTS replenishment_recommendations;

-- Risk & alerts
DROP TABLE IF EXISTS alert_resolutions;
DROP TABLE IF EXISTS alerts;
DROP TABLE IF EXISTS risk_assessments;
DROP TABLE IF EXISTS risk_records;
DROP TABLE IF EXISTS notification_preferences;

-- Forecasting
DROP TABLE IF EXISTS model_metrics;
DROP TABLE IF EXISTS forecast_results;
DROP TABLE IF EXISTS forecast_runs;

-- Purchasing
DROP TABLE IF EXISTS delivery_items;
DROP TABLE IF EXISTS deliveries;
DROP TABLE IF EXISTS purchase_order_status_history;
DROP TABLE IF EXISTS purchase_order_items;
DROP TABLE IF EXISTS purchase_orders;

-- Sales
DROP TABLE IF EXISTS sales;
DROP TABLE IF EXISTS sales_order_items;
DROP TABLE IF EXISTS sales_orders;
DROP TABLE IF EXISTS customers;

-- Suppliers
DROP TABLE IF EXISTS supplier_performance;
DROP TABLE IF EXISTS supplier_lead_times;
DROP TABLE IF EXISTS supplier_products;
DROP TABLE IF EXISTS suppliers;

-- Inventory
DROP TABLE IF EXISTS stock_adjustment_items;
DROP TABLE IF EXISTS stock_adjustments;
DROP TABLE IF EXISTS stock_movements;
DROP TABLE IF EXISTS inventory;
DROP TABLE IF EXISTS warehouses;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS categories;

-- Access control
DROP TABLE IF EXISTS invitations;
DROP TABLE IF EXISTS store_members;
DROP TABLE IF EXISTS role_permissions;
DROP TABLE IF EXISTS permissions;
DROP TABLE IF EXISTS roles;

-- Tenancy
DROP TABLE IF EXISTS stores;
DROP TABLE IF EXISTS organizations;

-- Identity
DROP TABLE IF EXISTS auth_identities;
DROP TABLE IF EXISTS otp_codes;
DROP TABLE IF EXISTS users;