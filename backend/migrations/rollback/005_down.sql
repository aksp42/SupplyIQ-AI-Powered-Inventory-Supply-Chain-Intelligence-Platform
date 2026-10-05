-- 005_down.sql
--
-- Removes the order-identity column added by 005. orders_count is left as it
-- stands: dropping order_refs does not make the previous per-line counts any
-- less wrong, and the values already written are the only record that exists.

ALTER TABLE sales DROP COLUMN order_refs;