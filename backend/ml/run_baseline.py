"""
Run baseline evaluation on actual SupplyIQ data.

This script:
1. Connects to MySQL
2. Loads sales data for demo-store-01 (uses synthetic if insufficient)
3. Builds feature matrix
4. Runs baseline evaluation
5. Reports results
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pandas as pd
import numpy as np
from ml.config import settings
from ml.database import (
    get_sales_history,
    get_inventory_snapshot,
    get_organization_id_from_store,
    get_active_products,
)
from ml.features import build_feature_matrix, filter_sufficient_history, get_history_stats
from ml.models.baseline import evaluate_baselines
from ml.evaluation.metrics import calculate_metrics
from ml.data.synthetic_generator import generate_full_history

print("=" * 60)
print("SUPPLYIQ ML PHASE 1 - BASELINE EVALUATION")
print("=" * 60)

# 1. Load data
STORE_ID = "demo-store-01"

print(f"\n1. Loading data for store: {STORE_ID}")

org_id = get_organization_id_from_store(STORE_ID)
print(f"   Organization ID: {org_id}")

# First try to get real sales data
sales_df = get_sales_history(STORE_ID, days=90)
print(f"   Real sales records: {len(sales_df)}")

inv_df = get_inventory_snapshot(STORE_ID)
print(f"   Inventory items: {len(inv_df)}")

# Get products for synthetic generation
products = get_active_products(STORE_ID)
print(f"   Active products: {len(products)}")

# 2. Use synthetic data if real sales data is insufficient
if len(sales_df) < 14:
    print(f"\n2. Real sales data insufficient ({len(sales_df)} records), generating synthetic history...")
    sales_df = generate_full_history(
        products=products,
        store_id=STORE_ID,
        organization_id=org_id,
        days=90,
        seed=42,
    )
    print(f"   Generated {len(sales_df)} synthetic sales records")
else:
    print(f"\n2. Using real sales data ({len(sales_df)} records)")

inv_df = get_inventory_snapshot(STORE_ID)
print(f"   Inventory items: {len(inv_df)}")

# 3. Build feature matrix
print("\n3. Building feature matrix...")
feature_df = build_feature_matrix(
    sales_df=sales_df,
    sku_col="sku",
    date_col="date",
    qty_col="quantity",
)

print(f"   Feature matrix shape: {feature_df.shape}")
print(f"   Columns: {list(feature_df.columns)}")

# Check history stats
stats = get_history_stats(feature_df)
print(f"\n   Data stats: {stats}")

# 3. Filter sufficient history
print("\n3. Filtering products with sufficient history...")
filtered_df, info = filter_sufficient_history(
    feature_df,
    min_days=14,
)

print(f"   Products included: {info['included_products']}")
print(f"   Products excluded: {info['excluded_products']}")
print(f"   Excluded products: {info['insufficient_history_products']}")
print(f"   Rows after filtering: {len(filtered_df)}")

# 4. Run baseline evaluation
print("\n4. Running baseline evaluation...")
if not filtered_df.empty:
    eval_results = evaluate_baselines(
        filtered_df,
        horizon=7,
        validation_days=14,
        seasonal_period=7,
    )

    print(f"\n4. Baseline Model Comparison:")
    print("-" * 60)
    if not eval_results.empty:
        for model_name, group in eval_results.groupby("model"):
            metrics = group.iloc[0]
            print(f"\n   {model_name}:")
            print(f"     MAE:    {metrics.get('mae', 'N/A'):.2f}")
            print(f"     RMSE:   {metrics.get('rmse', 'N/A'):.2f}")
            print(f"     WAPE:   {metrics.get('wape', 'N/A'):.2f}%")
            print(f"     MAPE:   {metrics.get('mape', 'N/A'):.2f}%")
            print(f"     Bias:   {metrics.get('bias', 'N/A'):.2f}")
    else:
        print("   No evaluation results (insufficient data)")

# Also test per-product evaluation
print("\n5. Per-product baseline evaluation (Seasonal Naive):")
from ml.models.baseline import SeasonalNaiveForecast
from ml.evaluation.backtest import time_series_split, evaluate_forecast_model

if not filtered_df.empty:
    train_df, val_df = time_series_split(filtered_df, validation_days=14)

    model = SeasonalNaiveForecast(seasonal_period=7)
    model.fit(filtered_df, "sku", "date", "quantity")

    for sku in filtered_df["sku"].unique()[:5]:  # First 5 products
        val_sku = val_df[val_df["sku"] == sku]
        if len(val_sku) >= 7:
            result = evaluate_forecast_model(model, filtered_df, val_df, horizon=7)
            if "error" not in result:
                print(f"\n   {sku}:")
                print(f"     MAE:  {result['overall'].get('mae', 'N/A'):.2f}")
                print(f"     RMSE: {result['overall'].get('rmse', 'N/A'):.2f}")
                print(f"     WAPE: {result['overall'].get('wape', 'N/A'):.2f}%")

print("\n" + "=" * 60)
print("PHASE 1 BASELINE EVALUATION COMPLETE")
print("=" * 60)

print("=" * 60)
print("SUPPLYIQ ML PHASE 1 - BASELINE EVALUATION")
print("=" * 60)

# 1. Load data
STORE_ID = "demo-store-01"

print(f"\n1. Loading data for store: {STORE_ID}")

org_id = get_organization_id_from_store(STORE_ID)
print(f"   Organization ID: {org_id}")

sales_df = get_sales_history(STORE_ID, days=90)
print(f"   Sales records: {len(sales_df)}")

inv_df = get_inventory_snapshot(STORE_ID)
print(f"   Inventory items: {len(inv_df)}")

# 2. Build feature matrix
print("\n2. Building feature matrix...")
feature_df = build_feature_matrix(
    sales_df=sales_df,
    sku_col="sku",
    date_col="date",
    qty_col="quantity",
)

print(f"   Feature matrix shape: {feature_df.shape}")
print(f"   Columns: {list(feature_df.columns)}")

# Check history stats
stats = get_history_stats(feature_df)
print(f"\n   Data stats: {stats}")

# 3. Filter sufficient history
print("\n3. Filtering products with sufficient history...")
filtered_df, info = filter_sufficient_history(
    feature_df,
    min_days=14,
)

print(f"   Products included: {info['included_products']}")
print(f"   Products excluded: {info['excluded_products']}")
print(f"   Excluded products: {info['insufficient_history_products']}")
print(f"   Rows after filtering: {len(filtered_df)}")

# 4. Run baseline evaluation
print("\n4. Running baseline evaluation...")
if not filtered_df.empty:
    eval_results = evaluate_baselines(
        filtered_df,
        horizon=7,
        validation_days=14,
        seasonal_period=7,
    )

    print(f"\n5. Baseline Model Comparison:")
    print("-" * 60)
    if not eval_results.empty:
        for model_name, group in eval_results.groupby("model"):
            metrics = group.iloc[0]
            print(f"\n   {model_name}:")
            print(f"     MAE:    {metrics.get('mae', 'N/A'):.2f}")
            print(f"     RMSE:   {metrics.get('rmse', 'N/A'):.2f}")
            print(f"     WAPE:   {metrics.get('wape', 'N/A'):.2f}%")
            print(f"     MAPE:   {metrics.get('mape', 'N/A'):.2f}%")
            print(f"     Bias:   {metrics.get('bias', 'N/A'):.2f}")
    else:
        print("   No evaluation results (insufficient data)")

# Also test per-product evaluation
print("\n6. Per-product baseline evaluation (Seasonal Naive):")
from ml.models.baseline import SeasonalNaiveForecast
from ml.evaluation.backtest import time_series_split, evaluate_forecast_model

if not filtered_df.empty:
    train_df, val_df = time_series_split(filtered_df, validation_days=14)
    
    model = SeasonalNaiveForecast(seasonal_period=7)
    model.fit(filtered_df, "sku", "date", "quantity")

    for sku in filtered_df["sku"].unique()[:5]:  # First 5 products
        val_sku = val_df[val_df["sku"] == sku]
        if len(val_sku) >= 7:
            result = evaluate_forecast_model(model, filtered_df, val_df, horizon=7)
            if "error" not in result:
                print(f"\n   {sku}:")
                print(f"     MAE:  {result['overall'].get('mae', 'N/A'):.2f}")
                print(f"     RMSE: {result['overall'].get('rmse', 'N/A'):.2f}")
                print(f"     WAPE: {result['overall'].get('wape', 'N/A'):.2f}%")

print("\n" + "=" * 60)
print("PHASE 1 BASELINE EVALUATION COMPLETE")
print("=" * 60)