"""
Tests for backtesting utilities.
"""

import pytest
import pandas as pd
import numpy as np
from ml.evaluation.backtest import (
    time_series_split,
    rolling_time_series_split,
    evaluate_forecast_model,
    backtest_model,
    compare_models,
    generate_backtest_report,
)
from ml.models.baseline import NaiveForecast, SeasonalNaiveForecast


def create_test_sales_data():
    """Create test sales data."""
    dates = pd.date_range("2026-01-01", periods=90, freq="D")
    skus = ["GRC-001", "GRC-002"]

    rows = []
    for sku in skus:
        base = 10 if sku == "GRC-001" else 20
        for date in dates:
            dow = date.dayofweek
            seasonal = 1.5 if date.dayofweek >= 5 else 1.0
            qty = int(np.random.poisson(10 * (1.5 if date.dayofweek >= 5 else 1.0)))
            if date.dayofweek == 6:
                qty = 0
            rows.append({"sku": sku, "date": date, "quantity": qty})
    return pd.DataFrame(rows)


def test_time_series_split():
    """Test time series split function."""
    df = pd.DataFrame({
        "date": pd.date_range("2026-01-01", periods=60, freq="D"),
        "sku": ["GRC-001"] * 60,
        "quantity": np.random.poisson(10, 60),
    })

    train, val = time_series_split(df, validation_days=14)

    assert len(val) == 14
    assert len(train) == 46
    assert train["date"].max() < val["date"].min()


def test_rolling_time_series_split():
    """Test rolling time series splits."""
    df = pd.DataFrame({
        "date": pd.date_range("2026-01-01", periods=90, freq="D"),
        "sku": ["GRC-001"] * 90,
        "quantity": np.random.poisson(10, 90),
    })

    splits = rolling_time_series_split(
        df,
        train_days=30,
        validation_days=14,
        step_days=7,
        min_train_days=14,
        max_splits=5,
    )

    assert len(splits) <= 5
    for train, val in splits:
        assert len(train) > 0
        assert len(val) > 0
        assert train["date"].max() < val["date"].min()


class MockModel:
    """Simple mock model for testing."""

    def __init__(self):
        self.fitted = False

    def fit(self, df, sku_col, date_col, qty_col):
        self.train_data = df
        self.fitted = True
        return self

    def predict(self, horizon, sku=None):
        skus = [sku] if sku else ["GRC-001", "GRC-002"]
        results = []
        for s in skus:
            for h in range(1, horizon + 1):
                results.append({
                    "sku": s,
                    "forecast_date": pd.Timestamp.now().normalize() + pd.Timedelta(days=h),
                    "p10": 8,
                    "p50": 10,
                    "p90": 12,
                })
        return pd.DataFrame(results)


def test_evaluate_forecast_model():
    """Test forecast model evaluation."""
    df = pd.DataFrame({
        "date": pd.date_range("2026-01-01", periods=60, freq="D"),
        "sku": ["GRC-001"] * 60,
        "quantity": np.random.poisson(10, 60),
    })

    train, val = time_series_split(df, validation_days=14)

    model = NaiveForecast()
    model.fit(train, "sku", "date", "quantity")

    result = evaluate_forecast_model(model, train, val, horizon=7)

    assert "overall" in result
    assert "mae" in result["overall"]


def test_compare_models():
    """Test model comparison."""
    df = pd.DataFrame({
        "date": pd.date_range("2026-01-01", periods=60, freq="D"),
        "sku": ["GRC-001"] * 60,
        "quantity": np.random.poisson(10, 60),
    })

    models = {
        "Naive": NaiveForecast,
        "SeasonalNaive": lambda: SeasonalNaiveForecast(seasonal_period=7),
    }

    results = compare_models(df, models, horizon=7, validation_days=14)

    assert len(results) == 2
    assert set(results["model"].tolist()) == {"Naive", "SeasonalNaive"}


def test_generate_backtest_report():
    """Test backtest report generation."""
    df = pd.DataFrame({
        "model": ["Naive", "SeasonalNaive"],
        "mae": [2.5, 2.1],
        "rmse": [3.2, 2.8],
        "wape": [15.2, 13.5],
        "mape": [18.0, 16.2],
        "bias": [0.1, -0.2],
    })

    report = generate_backtest_report(pd.DataFrame(df))
    assert "BACKTEST REPORT" in report
    assert "Naive" in report
    assert "SeasonalNaive" in report


if __name__ == "__main__":
    pytest.main([__file__, "-v"])