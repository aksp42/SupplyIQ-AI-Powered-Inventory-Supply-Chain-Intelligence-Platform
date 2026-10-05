-- 004_ledger_import.sql
--
-- Adds the single-file ledger import type.
--
-- import_jobs.entity_type carries a CHECK constraint listing every import type
-- the app understands. A new type therefore cannot be added in application code
-- alone: the row insert is rejected by the constraint before any of the
-- validator runs. Widening the constraint is the whole migration.

ALTER TABLE import_jobs DROP CHECK ck_import_entity;

ALTER TABLE import_jobs
  ADD CONSTRAINT ck_import_entity
  CHECK (`entity_type` IN ('products','suppliers','opening_stock',
                           'stock_movements','sales','purchase_orders',
                           'ledger'));