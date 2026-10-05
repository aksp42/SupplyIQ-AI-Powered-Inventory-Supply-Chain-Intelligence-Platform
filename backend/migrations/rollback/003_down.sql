-- ============================================================================
-- 003 rollback — remove the tenant integrity constraints.
--
-- The composite foreign keys go first, because they depend on uq_store_org_store.
-- Dropping that key while the constraints still reference it fails.
-- ============================================================================

ALTER TABLE import_jobs         DROP FOREIGN KEY fk_import_tenant;
ALTER TABLE report_runs         DROP FOREIGN KEY fk_rprun_tenant;
ALTER TABLE replenishment_recommendation_items DROP FOREIGN KEY fk_recoitem_tenant;
ALTER TABLE replenishment_recommendations       DROP FOREIGN KEY fk_reco_tenant;
ALTER TABLE notification_preferences DROP FOREIGN KEY fk_notifpref_tenant;
ALTER TABLE alerts              DROP FOREIGN KEY fk_alert_tenant;
ALTER TABLE risk_records        DROP FOREIGN KEY fk_risk_tenant;
ALTER TABLE model_metrics       DROP FOREIGN KEY fk_metric_tenant;
ALTER TABLE forecast_results    DROP FOREIGN KEY fk_fr_tenant;
ALTER TABLE forecast_runs       DROP FOREIGN KEY fk_frun_tenant;
ALTER TABLE invitations         DROP FOREIGN KEY fk_invite_tenant;
ALTER TABLE store_members       DROP FOREIGN KEY fk_member_tenant;
ALTER TABLE deliveries          DROP FOREIGN KEY fk_del_tenant;
ALTER TABLE purchase_orders     DROP FOREIGN KEY fk_po_tenant;
ALTER TABLE customers           DROP FOREIGN KEY fk_customer_tenant;
ALTER TABLE sales_orders        DROP FOREIGN KEY fk_so_tenant;
ALTER TABLE sales               DROP FOREIGN KEY fk_sales_tenant;
ALTER TABLE stock_adjustments   DROP FOREIGN KEY fk_adj_tenant;
ALTER TABLE stock_movements     DROP FOREIGN KEY fk_sm_tenant;
ALTER TABLE inventory           DROP FOREIGN KEY fk_inv_tenant;

-- Restore the original roles uniqueness. Note this reinstates the weaker rule
-- described in 003: system templates are no longer protected against duplicates.
ALTER TABLE roles
  DROP INDEX uq_role_scope_key,
  DROP COLUMN org_scope,
  ADD UNIQUE KEY uq_role_key (organization_id, key_name);

ALTER TABLE stores DROP INDEX uq_store_org_store;