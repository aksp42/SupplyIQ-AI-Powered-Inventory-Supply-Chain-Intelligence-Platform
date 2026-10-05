"""
Time-series backtesting utilities for SupplyIQ ML.

Provides time-series aware splitting and rolling evaluation.
"""

import pandas as pd
import numpy as np
from typing import List, Tuple, Optional, Dict, Callable
import warnings
warnings.filterwarnings("ignore")


def time_series_split(
    df: pd.DataFrame,
    date_col: str = "date",
    validation_days: int = 30,
    gap_days: int = 0,
) -> Tuple[pd.DataFrame, pd.DataFrame]:
    """
    Split time-series data into train and validation sets.

    Args:
        df: DataFrame with date column
        date_col: Date column name
        validation_days: Number of days for validation set
        gap_days: Gap days between train and validation (to prevent leakage)

    Returns:
        (train_df, val_df) tuple
    """
    df = df.copy()
    df = df.sort_values(date_col)

    max_date = df[date_col].max()
    val_start = max_date - pd.Timedelta(days=validation_days - 1)
    train_end = val_start - pd.Timedelta(days=gap_days + 1)

    train_df = df[df[date_col] <= train_end].copy()
    val_df = df[(df[date_col] >= val_start) & (df[date_col] <= max_date)].copy()

    return train_df, val_df


def rolling_time_series_split(
    df: pd.DataFrame,
    date_col: str = "date",
    train_days: int = 90,
    validation_days: int = 30,
    step_days: int = 7,
    min_train_days: int = 30,
    max_splits: int = 10,
) -> List[Tuple[pd.DataFrame, pd.DataFrame]]:
    """
    Generate rolling time-series splits for backtesting.

    Each split uses a fixed-size training window and validation window,
    rolling forward by step_days each iteration.

    Args:
        df: DataFrame with date column
        date_col: Date column name
        train_days: Training window size in days
        validation_days: Validation window size in days
        step_days: Days to roll forward each iteration
        min_train_days: Minimum training days required
        max_splits: Maximum number of splits

    Returns:
        List of (train_df, val_df) tuples
    """
    df = df.copy()
    df = df.sort_values("date")

    min_date = df["date"].min()
    max_date = df["date"].max()

    splits = []
    current_start = min_date

    for i in range(max_splits):
        train_start = current_start
        train_end = current_start + pd.Timedelta(days=train_days - 1)
        val_start = train_end + pd.Timedelta(days=1)
        val_end = val_start + pd.Timedelta(days=validation_days - 1)

        # Check bounds
        if val_end > df["date"].max():
            break

        train_days_actual = (train_end - train_start).days + 1
        if train_days_actual < min_train_days:
            break

        train_df = df[(df["date"] >= train_start) & (df["date"] <= train_end)].copy()
        val_df = df[(df["date"] >= val_start) & (df["date"] <= val_end)].copy()

        if len(train_df) == 0 or len(val_df) == 0:
            break

        splits.append((train_df, val_df))

        # Roll forward
        current_start += pd.Timedelta(days=step_days)

    return splits


def evaluate_forecast_model(
    model: object,
    train_df: pd.DataFrame,
    val_df: pd.DataFrame,
    horizon: int,
    sku_col: str = "sku",
    date_col: str = "date",
    qty_col: str = "quantity",
) -> dict:
    """
    Evaluate a fitted model on validation data.

    Args:
        model: Fitted model with predict(horizon, sku) method
        train_df: Training data
        val_df: Validation data
        horizon: Forecast horizon
        sku_col: SKU column name
        date_col: Date column
        qty_col: Quantity column

    Returns:
        Dictionary with evaluation metrics
    """
    from ..evaluation.metrics import calculate_metrics, calculate_metrics_per_product

    skus = train_df["sku"].unique()
    all_y_true = []
    all_y_pred = []
    all_skus = []

    for sku in train_df["sku"].unique():
        val_sku = val_df[val_df["sku"] == sku].sort_values("date")
        if val_sku.empty:
            continue

        # Get predictions for this SKU
        try:
            preds = model.predict(horizon, sku=sku)
            if preds.empty:
                continue

            pred_vals = preds.set_index("forecast_date")["p50"]
            val_sku = val_sku.head(len(preds))

            if len(val_sku) == 0:
                continue

            # Align predictions with validation
            min_len = min(len(val_sku), len(pred_vals))
            if min_len == 0:
                continue

            y_true = val_sku["quantity"].values[:min_len]
            y_pred = pred_vals[:min_len].values

            all_y_true.extend(y_true)
            all_y_pred.extend(y_pred)
            all_skus.extend([val_df["sku"].iloc[0]] * min_len)

        except Exception as e:
            continue

    if not all_y_true:
        return {"error": "No valid predictions"}

    # Calculate overall metrics
    metrics = calculate_metrics(
        np.array(all_y_true),
        np.array(all_y_pred),
    )

    # Per-product metrics
    sku_metrics = calculate_metrics_per_product(
        np.array(all_y_true),
        np.array(all_y_pred),
        np.array(all_skus),
    )

    return {
        "overall": {"n_obs": len(all_y_true), **{k: float(v) for k, v in metrics.items()}},
        "per_product": sku_metrics.to_dict("records") if not sku_metrics.empty else [],
    }


def backtest_model(
    model_factory: Callable,
    df: pd.DataFrame,
    horizon: int = 7,
    validation_days: int = 30,
    train_days: int = 90,
    step_days: int = 7,
    min_train_days: int = 30,
    max_splits: int = 10,
    model_params: dict = None,
) -> pd.DataFrame:
    """
    Run full backtest with rolling windows.

    Args:
        model_factory: Callable that returns a new model instance
        df: Full sales panel
        horizon: Forecast horizon
        validation_days: Validation window size
        train_days: Training window size
        step_days: Step size for rolling
        min_train_days: Minimum training days
        max_splits: Maximum splits
        model_params: Parameters to pass to model_factory

    Returns:
        DataFrame with per-split metrics
    """
    splits = rolling_time_series_split(
        df,
        train_days=train_days,
        validation_days=validation_days,
        step_days=step_days,
        min_train_days=min_train_days,
        max_splits=max_splits,
    )

    if model_params is None:
        model_params = {}

    all_results = []

    for i, (train_df, val_df) in enumerate(splits):
        # Create fresh model for each split
        model = model_factory()
        model.fit(train_df, "sku", "date", "quantity")

        # Evaluate on validation
        result = evaluate_forecast_model(model, train_df, val_df, horizon)

        if "error" not in result:
            result["split"] = i
            result["train_start"] = train_df["date"].min()
            result["train_end"] = train_df["date"].max()
            result["val_start"] = val_df["date"].min()
            result["val_end"] = val_df["date"].max()
            all_results.append(result)

    if not all_results:
        return pd.DataFrame()

    df_results = pd.DataFrame(all_results)
    return df_results


def compare_models(
    df: pd.DataFrame,
    models: dict,
    horizon: int = 7,
    validation_days: int = 30,
) -> pd.DataFrame:
    """
    Compare multiple models on the same validation set.

    Args:
        df: Sales panel
        models: Dict of {name: model_factory}
        horizon: Forecast horizon
        validation_days: Validation window

    Returns:
        DataFrame with model comparison
    """
    train_df, val_df = time_series_split(df, validation_days=validation_days)

    results = []
    for name, factory in models.items():
        model = factory()
        model.fit(df, "sku", "date", "quantity")  # Fit on full data

        result = evaluate_forecast_model(model, train_df, val_df, horizon)
        if "error" not in result:
            result["model"] = name
            results.append(result)

    if not results:
        return pd.DataFrame()

    return pd.DataFrame(results)


def generate_backtest_report(results: pd.DataFrame) -> str:
    """
    Generate a human-readable backtest report.

    Args:
        results: DataFrame from backtest_model or compare_models

    Returns:
        Formatted report string
    """
    if results.empty:
        return "No results to report."

    lines = ["=" * 60]
    lines.append("BACKTEST REPORT")
    lines.append("=" * 60)

    if "model" in results.columns:
        # Model comparison
        for model_name, group in results.groupby("model"):
            lines.append(f"\nModel: {model_name}")
            lines.append("-" * 40)
            metrics = group.iloc[0]
            lines.append(f"  MAE:     {metrics.get('mae', 'N/A'):.2f}")
            lines.append(f"  RMSE:    {metrics.get('rmse', 'N/A'):.2f}")
            lines.append(f"  WAPE:    {metrics.get('wape', 'N/A'):.2f}%")
            lines.append(f"  MAPE:    {metrics.get('mape', 'N/A'):.2f}%")
            lines.append(f"  Bias:    {metrics.get('bias', 'N/A'):.2f}")
            lines.append(f"  Coverage: {metrics.get('coverage', 'N/A'):.1f}%")
    else:
        # Single model backtest
        lines.append(f"Splits: {len(results)}")
        overall = results.iloc[0].get("overall", {})
        lines.append(f"\nOverall Metrics:")
        lines.append(f"  MAE:     {overall.get('mae', 'N/A'):.2f}")
        lines.append(f"  RMSE:    {overall.get('rmse', 'N/A'):.2f}")
        lines.append(f"  WAPE:    {overall.get('wape', 'N/A'):.2f}%")
        lines.append(f"  MAPE:    {overall.get('mape', 'N/A'):.2f}%")
        lines.append(f"  Bias:    {overall.get('bias', 'N/A'):.2f}")

    lines.append("\n" + "=" * 60)
    return "\n".join(lines)