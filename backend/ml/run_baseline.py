"""
Run baseline evaluation on actual SupplyIQ data.

Usage:
    python run_baseline.py [store_id]

Defaults to SUPPLYIQ_STORE_ID or demo-store-01. The script loads real sales,
falls back to synthetic history when fewer than 14 sale rows exist, builds the
feature matrix, and prints baseline model metrics.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pandas as pd

from ml.database import (
    get_active_products,
    get_inventory_snapshot,
    get_organization_id_from_store,
    get_sales_history,
)
from ml.data.synthetic_generator import generate_full_history
from ml.evaluation.backtest import evaluate_forecast_model, time_series_split
from ml.features import build_feature_matrix, filter_sufficient_history, get_history_stats
from ml.models.baseline import SeasonalNaiveForecast, evaluate_baselines


def main() -> int:
    store_id = sys.argv[1] if len(sys.argv) > 1 else os.getenv("SUPPLYIQ_STORE_ID", "demo-store-01")

    print("=" * 60)
    print("SUPPLYIQ ML PHASE 1 - BASELINE EVALUATION")
    print("=" * 60)
    print(f"\n1. Loading data for store: {store_id}")

    org_id = get_organization_id_from_store(store_id)
    if not org_id:
        print(f"   Store '{store_id}' not found.")
        return 1
    print(f"   Organization ID: {org_id}")

    products = get_active_products(store_id)
    print(f"   Active products: {len(products)}")
    if not products:
        print("   No active products for this store. Choose a store with imported inventory,")
        print("   for example: python run_baseline.py akanksha-singh")
        return 1

    inventory = get_inventory_snapshot(store_id)
    print(f"   Inventory items: {len(inventory)}")

    sales_df = pd.DataFrame(get_sales_history(store_id, days=90))
    print(f"   Real sales records: {len(sales_df)}")

    if len(sales_df) < 14:
        print(f"\n2. Real sales data insufficient ({len(sales_df)} records), generating synthetic history...")
        sales_df = generate_full_history(
            products=products,
            store_id=store_id,
            organization_id=org_id,
            days=90,
            seed=42,
        )
        print(f"   Generated {len(sales_df)} synthetic sales records")
    else:
        print(f"\n2. Using real sales data ({len(sales_df)} records)")

    print("\n3. Building feature matrix...")
    feature_df = build_feature_matrix(
        sales_df=sales_df,
        sku_col="sku",
        date_col="date",
        qty_col="quantity",
    )
    print(f"   Feature matrix shape: {feature_df.shape}")
    print(f"   Columns: {list(feature_df.columns)}")
    print(f"   Data stats: {get_history_stats(feature_df)}")

    print("\n4. Filtering products with sufficient history...")
    filtered_df, info = filter_sufficient_history(feature_df, min_days=14)
    print(f"   Products included: {info['included_products']}")
    print(f"   Products excluded: {info['excluded_products']}")
    print(f"   Excluded products: {info['insufficient_history_products']}")
    print(f"   Rows after filtering: {len(filtered_df)}")

    if filtered_df.empty:
        print("\nNo product has enough history; stopping.")
        return 1

    print("\n5. Running baseline evaluation...")
    eval_results = evaluate_baselines(
        filtered_df,
        horizon=7,
        validation_days=14,
        seasonal_period=7,
    )

    print("\n6. Baseline Model Comparison:")
    print("-" * 60)
    if eval_results.empty:
        print("   No evaluation results (insufficient validation data)")
    else:
        for model_name, group in eval_results.groupby("model"):
            metrics = group.iloc[0]
            print(f"\n   {model_name}:")
            print(f"     MAE:    {metrics.get('mae', 'N/A'):.2f}")
            print(f"     RMSE:   {metrics.get('rmse', 'N/A'):.2f}")
            print(f"     WAPE:   {metrics.get('wape', 'N/A'):.2f}%")
            print(f"     MAPE:   {metrics.get('mape', 'N/A'):.2f}%")
            print(f"     Bias:   {metrics.get('bias', 'N/A'):.2f}")

    print("\n7. Per-product evaluation (Seasonal Naive, first 5 products):")
    train_df, val_df = time_series_split(filtered_df, validation_days=14)
    model = SeasonalNaiveForecast(seasonal_period=7)
    model.fit(filtered_df, "sku", "date", "quantity")
    result = evaluate_forecast_model(model, train_df, val_df, horizon=7)
    if "error" in result:
        print(f"   {result['error']}")
    else:
        for row in result["per_product"][:5]:
            print(f"\n   {row['sku']}:")
            print(f"     MAE:  {row.get('mae', 'N/A'):.2f}")
            print(f"     RMSE: {row.get('rmse', 'N/A'):.2f}")
            print(f"     WAPE: {row.get('wape', 'N/A'):.2f}%")

    print("\n" + "=" * 60)
    print("PHASE 1 BASELINE EVALUATION COMPLETE")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
