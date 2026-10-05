-- 006_stock_out_invoice.sql
--
-- Gives a stock movement somewhere to keep the invoice it belongs to.
--
-- The Stock Out screen has to answer "on which date did which product leave, how
-- many, and against which invoice". Date, product, quantity and reason were all
-- already in stock_movements; the invoice was not, and could not be:
--
--   * reference_id is BIGINT UNSIGNED, so "INV-102" cannot go there.
--   * note is free text, and the CSV ledger import already writes
--     "Invoice INV-102 · <supplier> · <note>" into it. Reading an invoice back out
--     of that means parsing prose, which is how a column like this gets trusted
--     for the wrong value.
--
-- One nullable column is the smallest change that stores the invoice as data
-- instead of as prose. It is additive: no existing row is rewritten, no existing
-- reader changes meaning, and a row with no invoice is simply NULL.

ALTER TABLE stock_movements
  ADD COLUMN invoice_no VARCHAR(60) NULL AFTER reason;
