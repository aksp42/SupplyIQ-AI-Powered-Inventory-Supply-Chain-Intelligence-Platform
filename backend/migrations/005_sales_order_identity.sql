-- 005_sales_order_identity.sql
--
-- Counts distinct orders instead of distinct sales lines.
--
-- `sales` is a per-store, per-day rollup (UNIQUE (store_id, date)) with no
-- product_id, which is why it cannot answer "how many orders were there". Its
-- orders_count column was being incremented once per imported row, so a file of
-- 246 sale lines across 41 days reported 246 orders, and re-importing the same
-- day doubled it again.
--
-- `order_refs` stores the distinct order identities (invoice/bill numbers) seen
-- for that store-day. orders_count is then derived from the set, so the same
-- invoice appearing on several lines counts once, and a re-import of an already
-- committed file cannot inflate it.
--
-- Existing rows keep their stored orders_count: history is not rewritten, because
-- the original invoice identities were never persisted and re-deriving them would
-- mean guessing. New rows start at 0 and are built from real identities only.

ALTER TABLE sales
  ADD COLUMN order_refs TEXT NULL AFTER orders_count;