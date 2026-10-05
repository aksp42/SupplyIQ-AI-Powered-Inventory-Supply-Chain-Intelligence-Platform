-- 006_down.sql
--
-- Removes the invoice column added by 006.
--
-- This is lossy and the runner will NOT stop it: the `down` guard only refuses to
-- roll back while one of its BUSINESS_TABLES still holds rows, and
-- stock_movements is a ledger rather than one of those, so it can be non-empty
-- and this still runs. Back up first.
--
-- What is lost: an invoice recorded against an OUT movement written by hand since
-- 006 exists only in this column. Rows written by the CSV ledger import still have
-- "Invoice <no>" in the note text, so those can be recovered by hand; a row
-- entered on the Stock Out screen cannot.

ALTER TABLE stock_movements DROP COLUMN invoice_no;
