"""
Evaluation metrics for SupplyIQ forecasting models.
"""

import numpy as np
import pandas as pd
from typing import Optional, Dict, List, Tuple
import warnings
warnings.filterwarnings("ignore")


def calculate_metrics(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    y_lower: Optional[np.ndarray] = None,
    y_upper: Optional[np.ndarray] = None,
) -> Dict[str, float]:
    """
    Calculate standard forecasting metrics.

    Args:
        y_true: Actual values
        y_pred: Predicted values (point forecasts)
        y_lower: Lower prediction bound (optional)
        y_upper: Upper prediction bound (optional)

    Returns:
        Dictionary of metrics
    """
    y_true = np.asarray(y_true, dtype=float)
    y_pred = np.asarray(y_pred, dtype=float)

    # Remove NaN values
    mask = ~(np.isnan(y_true) | np.isnan(y_pred))
    if not mask.any():
        return {k: np.nan for k in ["mae", "rmse", "mape", "wape", "bias", "n_obs"]}

    y_true = y_true[mask]
    y_pred = y_pred[mask]

    # Basic errors
    errors = y_pred - y_true
    abs_errors = np.abs(errors)

    # MAE
    mae = float(np.mean(abs_errors))

    # RMSE
    rmse = float(np.sqrt(np.mean(errors ** 2)))

    # MAPE - handle zeros appropriately
    # For zero actuals, MAPE is undefined. We exclude those from MAPE calculation.
    non_zero_mask = y_true != 0
    if non_zero_mask.any():
        mape = float(np.mean(np.abs(errors[non_zero_mask] / y_true[non_zero_mask])) * 100)
    else:
        mape = np.nan

    # WAPE (Weighted Absolute Percentage Error) - handles zeros better
    # WAPE = sum(|e|) / sum(|y|)
    total_abs_actual = np.sum(np.abs(y_true))
    if total_abs_actual > 0:
        wape = float(np.sum(abs_errors) / total_abs_actual * 100)
    else:
        wape = np.nan

    # Bias (mean error)
    bias = float(np.mean(errors))

    # Additional metrics
    mse = float(np.mean((y_pred - y_true) ** 2))

    # Symmetric MAPE (sMAPE) - handles zeros better
    denom = (np.abs(y_true) + np.abs(y_pred)) / 2
    smape_mask = denom > 0
    if smape_mask.any():
        smape = float(np.mean(2 * np.abs(y_pred[smape_mask] - y_true[smape_mask]) /
                              (np.abs(y_pred[smape_mask]) + np.abs(y_true[smape_mask]))) * 100)
    else:
        smape = np.nan

    # Prediction interval coverage (if bounds provided)
    coverage = np.nan
    if y_lower is not None and y_upper is not None:
        y_lower = np.asarray(y_lower)[mask]
        y_upper = np.asarray(y_upper)[mask]
        coverage = float(np.mean((y_true >= y_lower) & (y_true <= y_upper)) * 100)

    # Average interval width
    avg_width = np.nan
    if y_lower is not None and y_upper is not None:
        y_lower = np.asarray(y_lower)[mask]
        y_upper = np.asarray(y_upper)[mask]
        avg_width = float(np.mean(y_upper - y_lower))

    return {
        "mae": mae,
        "rmse": rmse,
        "mape": mape,
        "wape": wape,
        "bias": bias,
        "mse": mse,
        "smape": smape,
        "coverage": coverage,
        "avg_interval_width": avg_width,
        "n_obs": int(mask.sum()),
    }


def calculate_metrics_per_product(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    skus: np.ndarray,
) -> pd.DataFrame:
    """
    Calculate metrics grouped by product.

    Args:
        y_true: Actual values
        y_pred: Predicted values
        skus: SKU identifiers for each observation

    Returns:
        DataFrame with metrics per product
    """
    results = []
    df = pd.DataFrame({"y_true": y_true, "y_pred": y_pred, "sku": skus})

    for sku, group in df.groupby("sku"):
        metrics = calculate_metrics(group["y_true"].values, group["y_pred"].values)
        metrics["sku"] = sku
        results.append(metrics)

    return pd.DataFrame(results) if results else pd.DataFrame()


def aggregate_metrics(metrics_list: List[Dict[str, float]]) -> Dict[str, float]:
    """
    Aggregate metrics across multiple products/runs.

    Args:
        metrics_list: List of metric dictionaries

    Returns:
        Aggregated metrics (weighted by n_obs where appropriate)
    """
    if not metrics_list:
        return {}

    df = pd.DataFrame(metrics_list)

    # Weight by n_obs for MAE, RMSE, WAPE
    weights = df["n_obs"].fillna(0)

    agg = {}
    # Weighted metrics
    for metric in ["mae", "rmse", "wape", "mse", "bias"]:
        if metric in df.columns:
            valid = df[metric].notna()
            if valid.any():
                agg[metric] = float(np.average(df.loc[valid, metric], weights=weights[valid]))

    # Simple average for MAPE (not weighted)
    if "mape" in df.columns:
        valid = df["mape"].notna()
        if valid.any():
            agg["mape"] = float(df.loc[valid, "mape"].mean())

    if "smape" in df.columns:
        valid = df["smape"].notna()
        if valid.any():
            agg["smape"] = float(df.loc[valid, "smape"].mean())

    if "coverage" in df.columns:
        valid = df["coverage"].notna()
        if valid.any():
            agg["coverage"] = float(df.loc[valid, "coverage"].mean())

    if "avg_interval_width" in df.columns:
        valid = df["avg_interval_width"].notna()
        if valid.any():
            agg["avg_interval_width"] = float(df.loc[valid, "avg_interval_width"].mean())

    agg["n_obs"] = int(weights.sum())
    agg["n_products"] = len(metrics_list)

    return agg


def check_forecast_validity(
    y_pred: np.ndarray,
    y_lower: Optional[np.ndarray] = None,
    y_upper: Optional[np.ndarray] = None,
) -> Dict[str, any]:
    """
    Validate forecast outputs.

    Checks:
    - No NaN in point forecasts
    - p10 <= p50 <= p90
    - No negative forecasts (for non-negative quantities)
    - Interval ordering (p10 <= p50 <= p90)
    """
    issues = []

    if np.any(np.isnan(y_pred)):
        issues.append("Point forecasts contain NaN")

    if np.any(y_pred < 0):
        issues.append("Negative forecasts detected")

    if y_lower is not None and y_upper is not None:
        if np.any(y_lower > y_pred):
            issues.append("Lower bound > point forecast")
        if np.any(y_upper < y_pred):
            issues.append("Upper bound < point forecast")
        if np.any(y_lower > y_upper):
            issues.append("Lower bound > upper bound")

    return {
        "valid": len(issues) == 0,
        "issues": issues,
    }