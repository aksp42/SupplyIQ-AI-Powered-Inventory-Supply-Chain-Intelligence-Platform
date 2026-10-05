"""
Calendar features for time series forecasting.
"""

import pandas as pd
import numpy as np
from datetime import datetime, date
from typing import List, Optional

# Indian holidays 2024-2026 (major ones affecting retail)
INDIAN_HOLIDAYS = {
    # 2024
    "2024-01-26", "2024-03-08", "2024-03-25", "2024-04-11", "2024-04-17",
    "2024-05-23", "2024-06-17", "2024-07-17", "2024-08-15", "2024-08-19",
    "2024-09-07", "2024-10-02", "2024-10-12", "2024-10-31", "2024-11-15",
    "2024-12-25",
    # 2025
    "2025-01-26", "2025-02-26", "2025-03-14", "2025-03-30", "2025-04-10",
    "2025-04-14", "2025-04-18", "2025-05-12", "2025-06-07", "2025-07-06",
    "2025-08-15", "2025-08-27", "2025-09-05", "2025-09-27", "2025-10-02",
    "2025-10-21", "2025-10-22", "2025-11-05", "2025-12-25",
    # 2026
    "2026-01-26", "2026-02-17", "2026-03-03", "2026-04-03", "2026-04-14",
    "2026-04-20", "2026-05-22", "2026-06-27", "2026-08-15", "2026-08-29",
    "2026-09-17", "2026-10-02", "2026-10-19", "2026-11-09", "2026-11-24",
    "2026-12-25",
}

# Weekend days (0=Monday, 6=Sunday)
WEEKEND_DAYS = {5, 6}  # Saturday, Sunday


def is_holiday(date_val: date) -> bool:
    """Check if a date is a holiday."""
    return date_val.isoformat() in INDIAN_HOLIDAYS


def is_weekend(date_val: date) -> bool:
    """Check if a date is a weekend."""
    return date_val.weekday() in WEEKEND_DAYS


def is_working_day(date_val: date) -> bool:
    """Check if a date is a working day (not weekend, not holiday)."""
    return not is_weekend(date_val) and not is_holiday(date_val)


def add_calendar_features(df: pd.DataFrame, date_col: str = "date") -> pd.DataFrame:
    """
    Add calendar features to a DataFrame with a date column.

    Args:
        df: DataFrame with a date column
        date_col: Name of the date column

    Returns:
        DataFrame with added calendar features
    """
    df = df.copy()
    df[date_col] = pd.to_datetime(df[date_col])

    # Basic date components
    df["day_of_week"] = df[date_col].dt.dayofweek  # 0=Mon, 6=Sun
    df["day_of_month"] = df[date_col].dt.day
    df["week_of_year"] = df[date_col].dt.isocalendar().week
    df["month"] = df[date_col].dt.month
    df["quarter"] = df[date_col].dt.quarter
    df["year"] = df[date_col].dt.year

    # Weekend / holiday flags
    df["is_weekend"] = df[date_col].dt.dayofweek.isin([5, 6]).astype(int)
    df["is_holiday"] = df[date_col].dt.date.apply(is_holiday).astype(int)
    df["is_working_day"] = (~df[date_col].dt.date.apply(is_weekend) & ~df[date_col].dt.date.apply(is_holiday)).astype(int)

    # Month start/end
    df["is_month_start"] = df[date_col].dt.is_month_start.astype(int)
    df["is_month_end"] = df[date_col].dt.is_month_end.astype(int)

    # Quarter start/end
    df["is_quarter_start"] = df[date_col].dt.is_quarter_start.astype(int)
    df["is_quarter_end"] = df[date_col].dt.is_quarter_end.astype(int)

    # Cyclical encoding for periodic features
    df["day_of_week_sin"] = np.sin(2 * np.pi * df["day_of_week"] / 7)
    df["day_of_week_cos"] = np.cos(2 * np.pi * df["day_of_week"] / 7)
    df["day_of_month_sin"] = np.sin(2 * np.pi * df["day_of_month"] / 31)
    df["day_of_month_cos"] = np.cos(2 * np.pi * df["day_of_month"] / 31)
    df["month_sin"] = np.sin(2 * np.pi * df["month"] / 12)
    df["month_cos"] = np.cos(2 * np.pi * df["month"] / 12)

    return df


def generate_future_dates(last_date: date, horizon_days: int) -> pd.DataFrame:
    """Generate future dates for forecasting."""
    dates = pd.date_range(
        start=last_date + pd.Timedelta(days=1),
        periods=horizon_days,
        freq="D"
    )
    df = pd.DataFrame({"date": dates})
    return add_calendar_features(df, "date")


def is_sufficient_history(df: pd.DataFrame, min_days: int = 14) -> bool:
    """Check if a product has sufficient history for modeling."""
    if df.empty:
        return False
    unique_dates = df["date"].nunique()
    return unique_dates >= min_days


def get_history_stats(df: pd.DataFrame) -> dict:
    """Get statistics about the history available."""
    if df.empty:
        return {"total_days": 0, "unique_products": 0, "date_range": None}

    return {
        "total_days": df["date"].nunique(),
        "unique_products": df["sku"].nunique() if "sku" in df.columns else 0,
        "date_range": (df["date"].min(), df["date"].max()),
        "total_observations": len(df),
    }