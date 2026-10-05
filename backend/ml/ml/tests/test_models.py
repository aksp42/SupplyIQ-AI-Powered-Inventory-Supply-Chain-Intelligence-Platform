"""
Tests for baseline forecasting models.
"""

import pytest
import pandas as pd
import numpy as np
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from ml.models.baseline import (
    NaiveForecast,
    SeasonalNaiveForecast,
    MovingAverageForecast,
    evaluate_baselines,
)
from ml.evaluation.metrics import calculate_metrics


def create_test_data():
    """Create test sales data with known patterns."""
    np.random.seed(42)
    dates = pd.date_range("2026-01-01", periods=60, freq="D")
    skus = ["GRC-001", "GRC-002"]

    rows = []
    for sku in skus:
        base = 10 if sku == "GRC-001" else 20
        for date in dates:
            dow = date.dayofweek
            seasonal = 1.5 if date.dayofweek >= 5 else 1.0
            qty = int(np.random.poisson(base_demand * seasonal))
            if date.dayofweek == 6:
                qty = 0
            rows.append({"sku": sku, "date": date, "quantity": qty})
    return pd.DataFrame(rows)


def test_naive_forecast():
    """Test Naive forecast model."""
    df = create_test_data()
    model = NaiveForecast()

    model.fit(df, "sku", "date", "quantity")

    preds = model.predict(horizon=7, sku="GRC-001")

    assert len(preds) == 7
    assert all(col in preds.columns for col in ["sku", "forecast_date", "p10", "p50", "p90"])
    assert (preds["p10"] <= preds["p50"]).all()
    assert (preds["p50"] <= preds["p90"]).all()

    # Naive forecast should use last value
    last_val = df[df["sku"] == "GRC-001"]["quantity"].iloc[-1]
    assert all(preds["p50"] == preds.iloc[0]["p50"])


def test_seasonal_naive_forecast():
    """Test Seasonal Naive forecast model."""
    df = create_test_data()
    model = SeasonalNaiveForecast(seasonal_period=7)

    model.fit(df, "sku", "date", "quantity")

    preds = model.predict(horizon=7, sku="GRC-001")

    assert len(preds) == 7
    assert all(col in preds.columns for col in ["sku", "forecast_date", "p10", "p50", "p90"])


def test_moving_average_forecast():
    """Test Moving Average forecast model."""
    df = create_test_data()
    model = MovingAverageForecast(window=7)

    model.fit(df, "sku", "date", "quantity")

    preds = model.predict(horizon=7, sku="GRC-001")

    assert len(preds) == 7
    assert all(col in preds.columns for col in ["sku", "forecast_date", "p10", "p50", "p90"])


def test_evaluate_baselines():
    """Test baseline evaluation."""
    df = create_test_data()

    results = evaluate_baselines(
        df,
        horizon=7,
        validation_days=14,
        seasonal_period=7,
    )

    assert not results.empty
    assert "model" in results.columns
    assert "sku" in results.columns
    assert "mae" in results.columns


def test_calculate_metrics():
    """Test metric calculations."""
    y_true = np.array([10, 20, 30, 40, 50])
    y_pred = np.array([11, 19, 31, 39, 51])

    metrics = calculate_metrics(y_true, y_pred)

    assert "mae" in metrics
    assert "rmse" in metrics
    assert "mape" in metrics
    assert "wape" in metrics
    assert "bias" in metrics
    assert metrics["n_obs"] == 5

    # Check values
    assert metrics["mae"] == 1.0  # All errors are 1
    assert metrics["rmse"] == 1.0
    assert metrics["bias"] == 0.0  # Errors sum to 0


def test_metrics_with_zero_demand():
    """Test metrics with zero actual demand."""
    y_true = np.array([10, 0, 20, 0, 30])
    y_pred = np.array([11, 1, 21, 1, 31])

    metrics = calculate_metrics(y_true, y_pred)

    # MAPE should be NaN or handle zeros appropriately
    # WAPE should still work
    assert not np.isnan(metrics["wape"])
    assert not np.isnan(metrics["mae"])
    assert not np.isnan(metrics["rmse"])


def test_metrics_with_bounds():
    """Test metrics with prediction intervals."""
    y_true = np.array([10, 20, 30])
    y_pred = np.array([11, 19, 31])
    y_lower = np.array([9, 18, 28])
    y_upper = np.array([13, 22, 34])

    metrics = calculate_metrics(y_true, y_pred, y_lower, y_upper)

    assert "coverage" in metrics
    assert metrics["coverage"] == 100.0  # All within bounds
    assert "avg_interval_width" in metrics


def test_forecast_validity():
    """Test forecast validity checking."""
    from ml.evaluation.metrics import check_forecast_validity

    # Valid forecast
    y_pred = np.array([10, 20, 30])
    y_lower = np.array([8, 15, 25])
    y_upper = np.array([12, 25, 35])

    result = check_forecast_validity(y_pred, y_lower, y_upper)
    assert result["valid"] == True

    # Invalid: lower > point
    y_lower_bad = np.array([12, 15, 25])
    result = check_forecast_validity(y_pred, y_lower_bad, None)
    assert result["valid"] == False
    assert any("Lower bound > point" in issue for issue in result["issues"])

    # Invalid: upper < point
    y_upper_bad = np.array([8, 15, 25])
    result = check_forecast_validity(y_pred, None, y_upper_bad)
    assert result["valid"] == False
    assert any("Upper bound < point" in issue for issue in result["issues"])

    # Invalid: negative forecast
    y_pred_bad = np.array([-1, 20, 30])
    result = check_forecast_validity(y_pred_bad, None, None)
    assert result["valid"] == False
    assert any("Negative forecasts" in issue for issue in result["issues"])


if __name__ == "__main__":
    pytest.main([__file__, "-v"])