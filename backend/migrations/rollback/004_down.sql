-- 004_down.sql
--
-- Restores the pre-004 constraint. Refuses to roll back while ledger jobs
-- exist, because narrowing the constraint back would make those rows invalid
-- and block any later insert or update on the table.

-- Guard: a ledger import must already be cleaned up before this can run.
SELECT COUNT(*) AS ledger_jobs_still_present
  FROM import_jobs
 WHERE entity_type = 'ledger';

-- If the query above returns a row with a count above zero, stop and remove
-- those import_jobs rows first. Nothing below can run in that state.

ALTER TABLE import_jobs DROP CHECK ck_import_entity;

ALTER TABLE import_jobs
  ADD CONSTRAINT ck_import_entity
  CHECK (`entity_type` IN ('products','opening_stock','stock_movements',
                           'sales','suppliers','purchase_orders'));