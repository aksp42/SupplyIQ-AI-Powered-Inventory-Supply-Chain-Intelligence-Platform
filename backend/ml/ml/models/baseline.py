"""
Baseline forecasting models for SupplyIQ.

Simple, interpretable baselines that establish a performance floor.
All models must be time-series aware (no future leakage).
"""

import pandas as pd
import numpy as np
from typing import Optional, List, Dict, Any, Tuple
from abc import ABC, abstractmethod
from dataclasses import dataclass
from abc import ABC, abstractmethod
import warnings
warnings.filterwarnings("ignore")


@dataclass
class ForecastResult:
    """Container for forecast results."""
    sku: str
    forecast_date: pd.Timestamp
    p10: float  # Lower bound (10th percentile)
    p50: float  # Point forecast (median)
    p90: float  # Upper bound (90th percentile)
    model_name: str
    horizon: int


class BaselineModel(ABC):
    """Abstract base class for baseline forecasting models."""

    def __init__(self, name: str, seasonal_period: int = 7):
        self.name = name
        self.seasonal_period = seasonal_period
        self.is_fitted = False
        self.training_data = None
        self.fitted_params = {}

    @abstractmethod
    def fit(self, df: pd.DataFrame, sku_col: str = "sku", date_col: str = "date", qty_col: str = "quantity") -> "BaselineModel":
        """Fit the model on historical data."""
        pass

    @abstractmethod
    def predict(self, horizon: int, sku: Optional[str] = None) -> pd.DataFrame:
        """
        Generate forecasts.

        Returns:
            DataFrame with columns: sku, forecast_date, p10, p50, p90
        """
        pass

    def evaluate(
        self,
        y_true: np.ndarray,
        y_pred: np.ndarray,
        y_lower: Optional[np.ndarray] = None,
        y_upper: Optional[np.ndarray] = None,
    ) -> Dict[str, float]:
        """Evaluate model predictions."""
        from ..evaluation.metrics import calculate_metrics
        return calculate_metrics(y_true, y_pred, y_lower, y_upper)


class NaiveForecast(BaselineModel):
    """
    Naive forecast: next period = last observed value.

    Simple but surprisingly effective for stable demand.
    """

    def __init__(self, seasonal_period: int = 7):
        super().__init__("Naive", seasonal_period)
        self.last_values = {}

    def fit(self, df: pd.DataFrame, sku_col: str = "sku", date_col: str = "date", qty_col: str = "quantity") -> "NaiveForecast":
        """Store the last observed value for each SKU."""
        df = df.sort_values(["sku", "date"])
        self.last_values = df.groupby("sku")["quantity"].last().to_dict()
        self.is_fitted = True
        self.training_data = df.copy()
        return self

    def predict(self, horizon: int, sku: Optional[str] = None) -> pd.DataFrame:
        """Generate naive forecast: repeat last value."""
        if not self.is_fitted:
            raise ValueError("Model must be fitted before prediction")

        skus = [sku] if sku else list(self.last_values.keys())
        results = []

        for s in skus:
            last_val = self.last_values.get(s, 0)
            for h in range(1, horizon + 1):
                forecast_date = pd.Timestamp.now().normalize() + pd.Timedelta(days=h)
                results.append({
                    "sku": s,
                    "forecast_date": forecast_date,
                    "p10": float(last_val * 0.8),  # Simple uncertainty
                    "p50": float(last_val),
                    "p90": float(last_val * 1.2),
                })

        return pd.DataFrame(results)


class SeasonalNaiveForecast(BaselineModel):
    """
    Seasonal Naive forecast: next period = same period last season.

    For daily data with weekly seasonality (period=7), forecast = value from 7 days ago.
    """

    def __init__(self, seasonal_period: int = 7):
        super().__init__("SeasonalNaive", seasonal_period)
        self.history = {}

    def fit(self, df: pd.DataFrame, sku_col: str = "sku", date_col: str = "date", qty_col: str = "quantity") -> "SeasonalNaiveForecast":
        """Store historical values for seasonal lookup."""
        df = df.sort_values(["sku", "date"])
        # Store last seasonal_period values for each SKU
        self.history = {}
        for sku, group in df.groupby("sku"):
            group = group.sort_values("date")
            if len(group) >= self.seasonal_period:
                self.history[sku] = group.tail(self.seasonal_period)[["date", "quantity"]].copy()
            else:
                # Not enough history for seasonal naive
                self.history[sku] = group[["date", "quantity"]].copy()

        self.is_fitted = True
        self.training_data = df.copy()
        return self

    def predict(self, horizon: int, sku: Optional[str] = None) -> pd.DataFrame:
        """Generate seasonal naive forecast."""
        if not self.is_fitted:
            raise ValueError("Model must be fitted before prediction")

        skus = [sku] if sku else list(self.history.keys())
        results = []

        for s in skus:
            history = self.history.get(s)
            if history is None or history.empty:
                # Fallback to naive
                last_val = 0
            else:
                # Use seasonal pattern
                history = history.sort_values("date")
                last_date = history["date"].max()
                last_val = history["quantity"].iloc[-1]

            for h in range(1, horizon + 1):
                forecast_date = pd.Timestamp.now().normalize() + pd.Timedelta(days=h)

                # Find matching seasonal period
                target_dow = (pd.Timestamp.now().normalize() + pd.Timedelta(days=h)).dayofweek

                # Find historical values for same day of week
                seasonal_matches = history[history["date"].dt.dayofweek == target_dow]["quantity"]

                if len(seasonal_matches) > 0:
                    pred = seasonal_matches.mean()
                else:
                    pred = last_val if last_val > 0 else 0

                # Simple uncertainty bounds
                results.append({
                    "sku": s,
                    "forecast_date": pd.Timestamp.now().normalize() + pd.Timedelta(days=h),
                    "p10": float(pred * 0.8),
                    "p50": float(pred),
                    "p90": float(pred * 1.2),
                })

        return pd.DataFrame(results)


class MovingAverageForecast(BaselineModel):
    """
    Simple Moving Average forecast.
    """

    def __init__(self, window: int = 7, seasonal_period: int = 7):
        super().__init__(f"SMA_{window}", seasonal_period)
        self.window = window
        self.last_ma = {}

    def fit(self, df: pd.DataFrame, sku_col: str = "sku", date_col: str = "date", qty_col: str = "quantity") -> "MovingAverageForecast":
        df = df.sort_values(["sku", "date"])
        self.last_ma = df.groupby("sku")["quantity"].apply(
            lambda x: x.rolling(self.window, min_periods=1).mean().iloc[-1]
        ).to_dict()
        self.is_fitted = True
        self.training_data = df.copy()
        return self

    def predict(self, horizon: int, sku: Optional[str] = None) -> pd.DataFrame:
        if not self.is_fitted:
            raise ValueError("Model must be fitted before prediction")

        skus = [sku] if sku else list(self.last_ma.keys())
        results = []

        for s in skus:
            last_ma = self.last_ma.get(s, 0)
            for h in range(1, horizon + 1):
                forecast_date = pd.Timestamp.now().normalize() + pd.Timedelta(days=h)
                results.append({
                    "sku": s,
                    "forecast_date": pd.Timestamp.now().normalize() + pd.Timedelta(days=h),
                    "p10": float(last_ma * 0.85),
                    "p50": float(last_ma),
                    "p90": float(last_ma * 1.15),
                })

        return pd.DataFrame(results)


def evaluate_baselines(
    df: pd.DataFrame,
    sku_col: str = "sku",
    date_col: str = "date",
    qty_col: str = "quantity",
    horizon: int = 7,
    validation_days: int = 30,
    seasonal_period: int = 7,
) -> pd.DataFrame:
    """
    Evaluate all baseline models using time-based backtesting.

    Args:
        df: Sales panel with sku, date, quantity
        sku_col: SKU column
        date_col: Date column
        qty_col: Quantity column
        horizon: Forecast horizon
        validation_days: Days to use for validation
        seasonal_period: Seasonal period for seasonal models

    Returns:
        DataFrame with metrics per model per product
    """
    from ..evaluation.metrics import calculate_metrics
    from ..evaluation.backtest import time_series_split

    # Split data
    train_df, val_df = time_series_split(df, validation_days=validation_days)

    models = {
        "Naive": NaiveForecast(),
        "SeasonalNaive": SeasonalNaiveForecast(seasonal_period=seasonal_period),
        "SMA_7": MovingAverageForecast(window=7),
    }

    results = []

    for model_name, model in models.items():
        model.fit(df, "sku", "date", "quantity")

        for sku in df["sku"].unique():
            # Get validation data for this SKU
            val_sku = val_df[val_df["sku"] == sku].sort_values("date")
            if val_sku.empty:
                continue

            # Predict
            preds = model.predict(horizon, sku=sku)
            pred_vals = preds.set_index("forecast_date")["p50"]

            # Align with validation
            val_sku = val_sku.head(horizon)
            if len(val_sku) < horizon:
                continue

            y_true = val_sku["quantity"].values
            y_pred = pred_vals[:len(y_true)].values

            if len(y_true) != len(y_pred):
                continue

            metrics = model.evaluate(np.array(y_true), np.array(y_pred))
            metrics["model"] = model_name
            metrics["sku"] = sku
            results.append(metrics)

    return pd.DataFrame(results) if results else pd.DataFrame()