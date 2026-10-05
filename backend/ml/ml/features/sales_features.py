"""
Sales feature engineering for demand forecasting.
"""

import pandas as pd
import numpy as np
from typing import List, Optional, Dict, Tuple
from .calendar import add_calendar_features


def build_sales_panel(
    sales_df: pd.DataFrame,
    sku_col: str = "sku",
    date_col: str = "date",
    qty_col: str = "quantity",
) -> pd.DataFrame:
    """
    Build a complete panel of SKU x Date with zero-filling for missing days.

    Args:
        sales_df: Raw sales data with columns [sku, date, quantity, ...]
        sku_col: SKU column name
        date_col: Date column name
        qty_col: Quantity column name

    Returns:
        Panel with all SKU x Date combinations, zero-filled for missing sales
    """
    df = sales_df.copy()
    df = df.copy()

    # Ensure date column is datetime
    df["date"] = pd.to_datetime(df["date"])
    df["sku"] = df["sku"].astype(str)

    # Get unique SKUs and date range
    skus = df["sku"].unique()
    min_date = df["date"].min()
    max_date = df["date"].max()

    # Create complete date range
    all_dates = pd.date_range(start=min_date, end=max_date, freq="D")
    full_index = pd.MultiIndex.from_product([skus, all_dates], names=["sku", "date"])

    # Reindex to create complete panel
    df = df.set_index(["sku", "date"])
    df = df.reindex(full_index).reset_index()

    # Fill missing quantities with 0 (no sales = 0 units sold)
    df["quantity"] = df["quantity"].fillna(0)

    # Forward fill other columns if needed
    for col in df.columns:
        if col not in ["sku", "date", "quantity"]:
            df[col] = df.groupby("sku")[col].ffill()

    return df


def add_lag_features(
    df: pd.DataFrame,
    sku_col: str = "sku",
    qty_col: str = "quantity",
    lags: List[int] = None,
) -> pd.DataFrame:
    """
    Add lag features for demand forecasting.

    Args:
        df: Panel DataFrame with sku, date, quantity columns
        sku_col: SKU column name
        qty_col: Quantity column name
        lags: List of lag periods to create

    Returns:
        DataFrame with lag features added
    """
    if lags is None:
        lags = [1, 7, 14]

    df = df.copy()
    df = df.sort_values(["sku", "date"])

    for lag in lags:
        col_name = f"lag_{lag}"
        df[col_name] = df.groupby("sku")["quantity"].shift(lag)

    return df


def add_rolling_features(
    df: pd.DataFrame,
    sku_col: str = "sku",
    qty_col: str = "quantity",
    windows: List[int] = None,
    stats: List[str] = None,
) -> pd.DataFrame:
    """
    Add rolling window statistics.

    Args:
        df: Panel DataFrame with sku, date, quantity columns
        sku_col: SKU column name
        qty_col: Quantity column name
        windows: List of window sizes
        stats: List of statistics to compute ('mean', 'std', 'min', 'max', 'sum')

    Returns:
        DataFrame with rolling features added
    """
    if windows is None:
        windows = [7, 14]
    if stats is None:
        stats = ["mean", "std"]

    df = df.copy()
    df = df.sort_values(["sku", "date"])

    for window in windows:
        for stat in stats:
            col_name = f"rolling_{window}_{stat}"
            if stat == "mean":
                df[f"rolling_{window}_mean"] = df.groupby("sku")["quantity"].transform(
                    lambda x: x.rolling(window, min_periods=1).mean()
                )
            elif stat == "std":
                df[f"rolling_{window}_std"] = df.groupby("sku")["quantity"].transform(
                    lambda x: x.rolling(window, min_periods=2).std()
                ).fillna(0)
            elif stat == "min":
                df[f"rolling_{window}_min"] = df.groupby("sku")["quantity"].transform(
                    lambda x: x.rolling(window, min_periods=1).min()
                )
            elif stat == "max":
                df[f"rolling_{window}_max"] = df.groupby("sku")["quantity"].transform(
                    lambda x: x.rolling(window, min_periods=1).max()
                )
            elif stat == "sum":
                df[f"rolling_{window}_sum"] = df.groupby("sku")["quantity"].transform(
                    lambda x: x.rolling(window, min_periods=1).sum()
                )

    return df


def add_trend_features(
    df: pd.DataFrame,
    sku_col: str = "sku",
    qty_col: str = "quantity",
    windows: List[int] = None,
) -> pd.DataFrame:
    """
    Add trend/velocity features (short-term vs long-term average).

    Args:
        df: Panel DataFrame with sku, date, quantity columns
        sku_col: SKU column name
        qty_col: Quantity column name
        windows: List of window sizes for trend comparison

    Returns:
        DataFrame with trend features added
    """
    if windows is None:
        windows = [7, 14]

    df = df.copy()
    df = df.sort_values(["sku", "date"])

    for window in windows:
        # Short-term average (last 'window' days)
        short_mean = df.groupby("sku")["quantity"].transform(
            lambda x: x.rolling(window, min_periods=1).mean()
        )

        # Long-term average (all history up to that point)
        long_mean = df.groupby("sku")["quantity"].transform(
            lambda x: x.expanding(min_periods=1).mean()
        )

        # Trend = short_mean / long_mean (ratio)
        # > 1 means increasing trend, < 1 means decreasing
        df[f"trend_ratio_{window}"] = short_mean / long_mean.replace(0, np.nan)
        df[f"trend_ratio_{window}"] = df[f"trend_ratio_{window}"].fillna(1.0)

        # Difference from long-term average
        df[f"trend_diff_{window}"] = short_mean - long_mean

    return df


def add_demand_features(
    df: pd.DataFrame,
    sku_col: str = "sku",
    qty_col: str = "quantity",
    date_col: str = "date",
) -> pd.DataFrame:
    """
    Add demand-specific features.

    Args:
        df: Panel DataFrame with sku, date, quantity columns
        sku_col: SKU column name
        qty_col: Quantity column name
        date_col: Date column name

    Returns:
        DataFrame with demand features added
    """
    df = df.copy()
    df = df.sort_values(["sku", "date"])

    # Zero-demand streak (consecutive days with zero sales)
    df["is_zero"] = (df["quantity"] == 0).astype(int)
    df["zero_streak"] = df.groupby("sku")["is_zero"].transform(
        lambda x: x * (x.groupby((x != x.shift()).cumsum()).cumcount() + 1)
    )
    df.loc[df["quantity"] > 0, "zero_streak"] = 0

    # Days since last sale
    df["days_since_sale"] = df.groupby("sku").apply(
        lambda x: (x["quantity"] > 0).cumsum().diff().fillna(0)
    ).reset_index(level=0, drop=True)
    # Actually, let's compute it properly
    df["days_since_sale"] = 0
    for sku in df["sku"].unique():
        mask = df["sku"] == sku
        last_sale_idx = np.where(df.loc[mask, "quantity"] > 0)[0]
        if len(last_sale_idx) > 0:
            for i in range(len(df[mask])):
                if i == 0:
                    df.loc[df[mask].index[i], "days_since_sale"] = 0 if df.loc[df[mask].index[i], "quantity"] > 0 else 1
                else:
                    if df.loc[df[mask].index[i], "quantity"] > 0:
                        df.loc[df[mask].index[i], "days_since_sale"] = 0
                    else:
                        df.loc[df[mask].index[i], "days_since_sale"] = df.loc[df[mask].index[i-1], "days_since_sale"] + 1

    # Sales velocity (rolling 7-day average / max observed)
    df["velocity_7"] = df.groupby("sku")["quantity"].transform(
        lambda x: x.rolling(7, min_periods=1).mean()
    )
    max_vel = df.groupby("sku")["velocity_7"].transform("max")
    df["velocity_ratio"] = df["velocity_7"] / max_vel.replace(0, np.nan)
    df["velocity_ratio"] = df["velocity_ratio"].fillna(0)

    # Intermittency flag (CV > 1 means highly intermittent)
    df["demand_cv"] = df.groupby("sku")["quantity"].transform(
        lambda x: x.std() / x.mean() if x.mean() > 0 else 0
    )
    df["is_intermittent"] = (df["demand_cv"] > 1).astype(int)

    return df


def build_feature_matrix(
    sales_df: pd.DataFrame,
    sku_col: str = "sku",
    date_col: str = "date",
    qty_col: str = "quantity",
    date_start: Optional[str] = None,
    date_end: Optional[str] = None,
) -> pd.DataFrame:
    """
    Build complete feature matrix for demand forecasting.

    This is the main entry point that combines all feature engineering steps.

    Args:
        sales_df: Raw sales data with columns [sku, date, quantity, ...]
        sku_col: SKU column name
        date_col: Date column name
        qty_col: Quantity column name
        date_start: Optional start date filter
        date_end: Optional end date filter

    Returns:
        Feature matrix ready for modeling
    """
    # 1. Build complete panel
    df = build_sales_panel(sales_df, sku_col=sku_col, date_col=date_col, qty_col="quantity")

    # 2. Filter date range if specified
    if date_start:
        df = df[df["date"] >= date_start]
    if date_end:
        df = df[df["date"] <= date_end]

    # 2. Add calendar features
    df = add_calendar_features(df, "date")

    # 3. Add lag features
    df = add_lag_features(df, lags=[1, 7, 14])

    # 4. Add rolling features
    df = add_rolling_features(df, windows=[7, 14], stats=["mean", "std"])

    # 5. Add trend features
    df = add_trend_features(df, windows=[7, 14])

    # 6. Add demand-specific features
    df = add_demand_features(df)

    # 6. Sort
    df = df.sort_values(["sku", "date"]).reset_index(drop=True)

    return df


def filter_sufficient_history(
    df: pd.DataFrame,
    min_days: int = 14,
    sku_col: str = "sku",
) -> Tuple[pd.DataFrame, Dict]:
    """
    Filter products with sufficient history for modeling.

    Returns:
        (filtered_df, info_dict) where info_dict contains exclusion stats
    """
    info = {
        "total_products": df["sku"].nunique(),
        "total_rows": len(df),
        "excluded_products": 0,
        "excluded_rows": 0,
        "insufficient_history_products": [],
    }

    # Count observations per product
    product_counts = df.groupby("sku")["date"].nunique()

    # Products with sufficient history
    sufficient_products = product_counts[product_counts >= min_days].index.tolist()
    insufficient_products = product_counts[product_counts < min_days].index.tolist()

    info["excluded_products"] = len(insufficient_products)
    info["excluded_rows"] = len(df[df["sku"].isin(insufficient_products)])
    info["insufficient_history_products"] = insufficient_products
    info["included_products"] = len(sufficient_products)
    info["included_rows"] = len(df[df["sku"].isin(sufficient_products)])

    # Filter
    filtered_df = df[df["sku"].isin(sufficient_products)].copy()

    return df[df["sku"].isin(sufficient_products)], info