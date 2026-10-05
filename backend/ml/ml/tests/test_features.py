"""
Tests for feature engineering.
"""

import pytest
import pandas as pd
import numpy as np
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from ml.features import (
    build_sales_panel,
    add_lag_features,
    add_rolling_features,
    add_trend_features,
    add_demand_features,
    build_feature_matrix,
    filter_sufficient_history,
    compute_velocity,
)
from ml.features.calendar import add_calendar_features


def create_sample_sales_data():
    """Create sample sales data for testing."""
    dates = pd.date_range("2026-01-01", periods=30, freq="D")
    skus = ["GRC-001", "GRC-002", "GRC-003"]

    rows = []
    for sku in skus:
        for i, date in enumerate(dates):
            # Simulate some sales pattern
            qty = np.random.poisson(10) if i % 7 != 0 else 0  # Zero on Sundays
            rows.append({
                "sku": sku,
                "date": date,
                "quantity": qty,
            })
    return pd.DataFrame(rows)


def test_build_sales_panel():
    """Test building complete sales panel with zero-filling."""
    df = create_sample_sales_data()
    panel = build_sales_panel(df)

    # Should have all SKU x Date combinations
    assert len(panel) == 3 * 30  # 3 SKUs × 30 days

    # Check zero-filling for Sundays
    sundays = panel[panel["date"].dt.dayofweek == 6]
    assert (sundays["quantity"] == 0).all()

    # Check all SKUs present
    assert set(panel["sku"].unique()) == {"GRC-001", "GRC-002", "GRC-003"}


def test_add_lag_features():
    """Test lag feature generation."""
    df = create_sample_sales_data()
    panel = build_sales_panel(df)

    panel_with_lags = add_lag_features(panel, lags=[1, 7])

    # Check lag columns exist
    assert "lag_1" in panel_with_lags.columns
    assert "lag_7" in panel_with_lags.columns

    # Check lag values
    sku_data = panel_with_lags[panel_with_lags["sku"] == "GRC-001"].sort_values("date")
    # lag_1 should be previous day's quantity
    for i in range(1, len(sku_data)):
        assert sku_data.iloc[i]["lag_1"] == sku_data.iloc[i-1]["quantity"]


def test_add_rolling_features():
    """Test rolling window features."""
    df = create_sample_sales_data()
    panel = build_sales_panel(df)

    panel_rolling = add_rolling_features(panel, windows=[7], stats=["mean", "std"])

    assert "rolling_7_mean" in panel_with_lags.columns
    assert "rolling_7_std" in panel_with_lags.columns

    # Rolling mean should be <= max quantity
    assert panel_with_lags["rolling_7_mean"].max() <= 30  # reasonable max


def test_add_trend_features():
    """Test trend feature generation."""
    df = create_sample_sales_data()
    panel = build_sales_panel(df)

    panel_trend = add_trend_features(df, windows=[7])

    assert "trend_ratio_7" in panel.columns
    assert "trend_diff_7" in panel.columns


def test_add_demand_features():
    """Test demand-specific features."""
    df = create_sample_sales_data()
    panel = build_sales_panel(df)

    panel_demand = add_demand_features(df)

    assert "zero_streak" in panel.columns
    assert "days_since_sale" in panel.columns
    assert "velocity_ratio" in panel.columns
    assert "demand_cv" in panel.columns
    assert "is_intermittent" in panel.columns


def test_build_feature_matrix():
    """Test end-to-end feature matrix construction."""
    df = create_sample_sales_data()
    feature_df = build_feature_matrix(df)

    # Check all expected columns exist
    expected_cols = [
        "sku", "date", "quantity",
        "day_of_week", "month", "is_weekend", "is_holiday",
        "lag_1", "lag_7", "lag_14",
        "rolling_7_mean", "rolling_7_std",
        "trend_ratio_7", "trend_ratio_14",
        "zero_streak", "days_since_sale", "velocity_ratio"
    ]

    for col in expected_cols:
        assert col in df.columns, f"Missing column: {col}"

    # Check shape
    assert len(df) == 3 * 30  # 3 SKUs × 30 days


def test_filter_sufficient_history():
    """Test filtering products with insufficient history."""
    # Create data with one product having only 5 days of data
    df = create_sample_sales_data()
    # Remove most of GRC-003 data
    df = df[df["sku"] != "GRC-003"]
    df = df[df["sku"] != "GRC-002"]
    # Add only 5 days for GRC-002
    gcr002 = df[df["sku"] == "GRC-002"].head(5)
    df = pd.concat([df[df["sku"] == "GRC-001"], gcr002])

    filtered, info = filter_sufficient_history(df, min_days=14)

    assert info["excluded_products"] == 1  # GRC-002 has only 5 days
    assert "GRC-002" in info["insufficient_history_products"]
    assert info["included_products"] == 1


def test_calendar_features():
    """Test calendar feature generation."""
    dates = pd.date_range("2026-01-01", periods=14, freq="D")
    df = pd.DataFrame({"date": dates})

    df_cal = add_calendar_features(df)

    assert "day_of_week" in df.columns
    assert "month" in df.columns
    assert "is_weekend" in df.columns
    assert "is_holiday" in df.columns
    assert "day_of_week_sin" in df.columns
    assert "day_of_week_cos" in df.columns


def test_no_future_leakage():
    """Test that lag features don't leak future data."""
    df = create_sample_sales_data()
    panel = build_sales_panel(df)
    panel = add_lag_features(panel, lags=[1, 7])

    # For each SKU, lag_1 should equal previous day's quantity
    for sku in ["GRC-001", "GRC-002", "GRC-003"]:
        sku_data = panel[panel["sku"] == sku].sort_values("date")
        for i in range(1, len(sku_data)):
            assert panel.iloc[sku_data.index[i]]["lag_1"] == sku_data.iloc[i-1]["quantity"]


def test_rolling_features_no_future_leakage():
    """Test that rolling features don't use future data."""
    df = create_sample_sales_data()
    panel = build_sales_panel(df)
    panel = add_rolling_features(df, windows=[7], stats=["mean"])

    # Rolling mean at day i should only use data up to day i
    sku_data = panel[panel["sku"] == "GRC-001"].sort_values("date")
    for i in range(1, min(10, len(sku_data))):
        # Rolling 7-mean at index i should be mean of [i-6:i+1] (7 days including current)
        expected = sku_data.iloc[max(0, i-6):i+1]["quantity"].mean()
        actual = sku_data.iloc[i]["rolling_7_mean"]
        assert abs(actual - expected) < 0.01, f"Mismatch at index {i}: expected {expected}, got {actual}"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])