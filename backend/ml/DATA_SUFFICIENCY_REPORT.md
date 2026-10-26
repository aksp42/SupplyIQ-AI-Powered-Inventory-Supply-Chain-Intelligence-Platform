# SupplyIQ ML Phase 1 - Data Sufficiency Report

## Actual Available History

| Data Source | Records | Granularity | SKU-Level | Date Range |
|-------------|---------|-------------|-----------|------------|
| `sales` (daily rollup) | 30 days | Daily per store | ❌ No (store-level only) | 2026-09-03 to 2026-10-02 |
| `stock_movements` | 12 records | Per movement | ✅ Yes (product_id) | 2026-10-02 only |
| `sales_orders` | 0 | - | - | - |
| `sales_order_items` | 0 | - | - | - |
| `stock_movements` (sales) | 0 | - | - | - |

## Why Insufficient for Baseline

1. **No SKU-level sales history**: The only sales data is the `sales` table which is aggregated at store-day level (no SKU breakdown)
2. **No OUT movements**: `stock_movements` only has 12 `opening` records (direction=IN), zero `sale` movements
3. **No order history**: `sales_orders` and `sales_order_items` are empty
3. **Cannot compute SKU-level features**: Lag features, rolling statistics, trend features all require SKU-level time series

## What Synthetic Data Is Needed

For baseline evaluation, we need:
- **SKU-level daily sales** for at least 60 days (minimum for seasonal naive baseline)
- **Realistic patterns**: Weekly seasonality, weekend effects, intermittent demand
- **Per-SKU variation**: Different demand patterns per product
- **Realistic zero-sales days**: Sundays closed, intermittent products

## Proposed Synthetic Data Generator

Generate 90 days of SKU-level daily sales for all 12 demo products:
- Use inventory `monthly_demand` as mean demand
- Apply weekly seasonality (weekends 1.5x, Sundays 0)
- Add noise (Poisson/negative binomial)
- Distribute daily aggregate sales proportionally to product demand
- Ensure aggregate matches `sales` table daily totals

**Generated data will be clearly labeled** `source = 'synthetic'` and stored in a separate table or clearly marked in-memory only.