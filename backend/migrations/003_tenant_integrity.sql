-- ============================================================================
-- 003 — Tenant integrity constraints
--
-- 001 kept `organization_id` on every business table so reports could filter on
-- one column, and added a foreign key from that column to organizations. It also
-- added a foreign key from `store_id` to stores. But those two were checked
-- independently, which left a gap: a row could name organization A and store B.
-- Nothing in the database rejected that, so a bug in a query could insert or
-- leave behind a row that no single-tenant report would ever count, and no
-- isolation breach would raise an error either — it would just quietly lose data
-- from both tenants' views.
--
-- This migration closes the gap by pointing each table at the *pair*. A composite
-- foreign key on (organization_id, store_id) can only be satisfied when the store
-- actually belongs to that organization, so a cross-tenant row becomes impossible
-- to write rather than merely unlikely.
--
-- Two tables are deliberately left alone, and the reason matters:
--
--   users        has no organization_id. It reaches its organization through
--                stores (users.store_id -> stores.store_id). Adding a column
--                here would duplicate that relationship.
--
--   audit_logs   keeps ON DELETE SET NULL on organization_id and store_id so a
--                log survives its store being deleted. A composite foreign key
--                with SET NULL would try to null BOTH columns, which fails on
--                the NOT NULL side, and RESTRICT would make stores undeletable
--                once any log existed. audit_logs is therefore validated by the
--                repository layer instead of by a constraint.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- The composite foreign keys below need a unique key on the referenced pair.
-- store_id is already the primary key, so this only makes the pair itself a
-- valid target.
-- ---------------------------------------------------------------------------
ALTER TABLE stores
  ADD UNIQUE KEY uq_store_org_store (organization_id, store_id);

-- ---------------------------------------------------------------------------
-- One composite foreign key per table that carries both columns.
-- The ON DELETE rule matches each table's existing single-column FK on store_id,
-- so this adds a constraint without changing existing delete behaviour.
-- ---------------------------------------------------------------------------
ALTER TABLE inventory
  ADD CONSTRAINT fk_inv_tenant FOREIGN KEY (organization_id, store_id)
    REFERENCES stores (organization_id, store_id) ON DELETE NO ACTION;

ALTER TABLE stock_movements
  ADD CONSTRAINT fk_sm_tenant FOREIGN KEY (organization_id, store_id)
    REFERENCES stores (organization_id, store_id) ON DELETE NO ACTION;

ALTER TABLE stock_adjustments
  ADD CONSTRAINT fk_adj_tenant FOREIGN KEY (organization_id, store_id)
    REFERENCES stores (organization_id, store_id) ON DELETE NO ACTION;

ALTER TABLE sales
  ADD CONSTRAINT fk_sales_tenant FOREIGN KEY (organization_id, store_id)
    REFERENCES stores (organization_id, store_id) ON DELETE CASCADE;

ALTER TABLE sales_orders
  ADD CONSTRAINT fk_so_tenant FOREIGN KEY (organization_id, store_id)
    REFERENCES stores (organization_id, store_id) ON DELETE NO ACTION;

ALTER TABLE customers
  ADD CONSTRAINT fk_customer_tenant FOREIGN KEY (organization_id, store_id)
    REFERENCES stores (organization_id, store_id) ON DELETE NO ACTION;

ALTER TABLE purchase_orders
  ADD CONSTRAINT fk_po_tenant FOREIGN KEY (organization_id, store_id)
    REFERENCES stores (organization_id, store_id) ON DELETE NO ACTION;

ALTER TABLE deliveries
  ADD CONSTRAINT fk_del_tenant FOREIGN KEY (organization_id, store_id)
    REFERENCES stores (organization_id, store_id) ON DELETE NO ACTION;

ALTER TABLE store_members
  ADD CONSTRAINT fk_member_tenant FOREIGN KEY (organization_id, store_id)
    REFERENCES stores (organization_id, store_id) ON DELETE NO ACTION;

ALTER TABLE invitations
  ADD CONSTRAINT fk_invite_tenant FOREIGN KEY (organization_id, store_id)
    REFERENCES stores (organization_id, store_id) ON DELETE NO ACTION;

ALTER TABLE forecast_runs
  ADD CONSTRAINT fk_frun_tenant FOREIGN KEY (organization_id, store_id)
    REFERENCES stores (organization_id, store_id) ON DELETE CASCADE;

ALTER TABLE forecast_results
  ADD CONSTRAINT fk_fr_tenant FOREIGN KEY (organization_id, store_id)
    REFERENCES stores (organization_id, store_id) ON DELETE NO ACTION;

ALTER TABLE model_metrics
  ADD CONSTRAINT fk_metric_tenant FOREIGN KEY (organization_id, store_id)
    REFERENCES stores (organization_id, store_id) ON DELETE CASCADE;

ALTER TABLE risk_records
  ADD CONSTRAINT fk_risk_tenant FOREIGN KEY (organization_id, store_id)
    REFERENCES stores (organization_id, store_id) ON DELETE CASCADE;

ALTER TABLE alerts
  ADD CONSTRAINT fk_alert_tenant FOREIGN KEY (organization_id, store_id)
    REFERENCES stores (organization_id, store_id) ON DELETE CASCADE;

ALTER TABLE notification_preferences
  ADD CONSTRAINT fk_notifpref_tenant FOREIGN KEY (organization_id, store_id)
    REFERENCES stores (organization_id, store_id) ON DELETE CASCADE;

ALTER TABLE replenishment_recommendations
  ADD CONSTRAINT fk_reco_tenant FOREIGN KEY (organization_id, store_id)
    REFERENCES stores (organization_id, store_id) ON DELETE NO ACTION;

ALTER TABLE replenishment_recommendation_items
  ADD CONSTRAINT fk_recoitem_tenant FOREIGN KEY (organization_id, store_id)
    REFERENCES stores (organization_id, store_id) ON DELETE NO ACTION;

ALTER TABLE report_runs
  ADD CONSTRAINT fk_rprun_tenant FOREIGN KEY (organization_id, store_id)
    REFERENCES stores (organization_id, store_id) ON DELETE CASCADE;

ALTER TABLE import_jobs
  ADD CONSTRAINT fk_import_tenant FOREIGN KEY (organization_id, store_id)
    REFERENCES stores (organization_id, store_id) ON DELETE NO ACTION;

-- ---------------------------------------------------------------------------
-- roles: make system-role uniqueness actually work.
--
-- 001 declared UNIQUE (organization_id, key_name) and a comment claimed that
-- "multiple NULLs are allowed ... several system roles can share a key_name".
-- The first half is true of MySQL and the second half is the bug: it means the
-- four system templates could be inserted again and again without a duplicate
-- error, and 002's ON DUPLICATE KEY UPDATE would never fire for them, so a rerun
-- would quietly multiply roles — which in turn breaks the role_id that
-- store_members points at.
--
-- A stored generated column maps the NULL case to a real value (0), so the
-- uniqueness rule covers system templates as well.
-- ---------------------------------------------------------------------------
ALTER TABLE roles
  ADD COLUMN org_scope BIGINT UNSIGNED
    GENERATED ALWAYS AS (COALESCE(organization_id, 0)) STORED,
  DROP INDEX uq_role_key,
  ADD UNIQUE KEY uq_role_scope_key (org_scope, key_name);