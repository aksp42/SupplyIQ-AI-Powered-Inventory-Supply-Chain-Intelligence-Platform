"""
Inventory feature engineering for demand forecasting and risk assessment.
"""

import pandas as pd
import numpy as np
from typing import List, Optional, Dict
from .calendar import add_calendar_features
from .sales_features import build_sales_panel


def add_inventory_features(
    inventory_df: pd.DataFrame,
    sales_df: Optional[pd.DataFrame] = None,
    store_id: Optional[str] = None,
) -> pd.DataFrame:
    """
    Add inventory-derived features to the feature matrix.

    Args:
        inventory_df: Current inventory snapshot with columns:
            sku, quantity, monthly_demand, reorder_pt, safety_stock, max_stock,
            unit_cost, status, supplier, category
        sales_df: Optional sales history for computing velocity
        store_id: Store ID for context

    Returns:
        DataFrame with inventory features merged by SKU
    """
    inv = inventory_df.copy()

    # Basic inventory features
    inv["stockout_risk_score"] = np.where(
        inv["quantity"] <= inv["reorder_pt"],
        100,
        np.where(
            inv["quantity"] <= inv["safety_stock"],
            75,
            np.where(
                inv["quantity"] <= inv["reorder_pt"] * 1.5,
                50,
                0
            )
        )
    )

    # Days of cover (how many days current stock will last)
    inv["days_of_cover"] = np.where(
        inv["monthly_demand"] > 0,
        (inv["quantity"] / inv["monthly_demand"]) * 30,
        np.inf
    )
    inv["days_of_cover"] = inv["days_of_cover"].replace([np.inf, -np.inf], np.nan).fillna(999)

    # Stockout risk (probability of stockout before next delivery)
    # Simple heuristic: if days_of_cover < avg_lead_time, high risk
    inv["stockout_risk"] = (inv["days_of_cover"] < 7).astype(int)

    # Overstock indicator
    inv["overstock_risk"] = (inv["quantity"] > inv["max_stock"] * 0.9).astype(int)

    # Inventory value
    inv["inventory_value"] = inv["quantity"] * inv["unit_cost"]

    # Stock-to-sales ratio (inventory / monthly demand)
    inv["stock_to_sales_ratio"] = np.where(
        inv["monthly_demand"] > 0,
        inv["quantity"] / inv["monthly_demand"],
        np.inf
    )
    inv["stock_to_sales_ratio"] = inv["stock_to_sales_ratio"].replace([np.inf, -np.inf], np.nan).fillna(999)

    # Reorder urgency (days until reorder point)
    inv["days_to_reorder"] = np.where(
        inv["quantity"] > inv["reorder_pt"],
        (inv["quantity"] - inv["reorder_pt"]) / (inv["monthly_demand"] / 30).replace(0, 1),
        0
    )
    inv["days_to_reorder"] = inv["days_to_reorder"].clip(lower=0)

    # Inventory turnover (annualized)
    inv["inventory_turnover"] = np.where(
        inv["monthly_demand"] > 0,
        (inv["monthly_demand"] * 12) / inv["quantity"].replace(0, np.nan),
        0
    )
    inv["inventory_turnover"] = inv["inventory_turnover"].fillna(0)

    # Stock status encoding
    status_map = {
        "OK": 0,
        "Low": 1,
        "Critical": 2,
        "Overstock": 3
    }
    inv["status_encoded"] = inv["status"].map(status_map).fillna(-1).astype(int)

    # Days since last counted (if available)
    if "last_counted_at" in inventory_df.columns:
        inv["days_since_count"] = (pd.Timestamp.now().normalize() - pd.to_datetime(inv["last_counted_at"])).dt.days
    else:
        inv["days_since_count"] = -1

    return inv


def merge_inventory_features(
    sales_df: pd.DataFrame,
    inventory_df: pd.DataFrame,
    sku_col: str = "sku",
) -> pd.DataFrame:
    """
    Merge inventory features into sales panel.

    Args:
        sales_df: Sales panel with SKU/date features
        inventory_df: Inventory features from add_inventory_features

    Returns:
        Sales panel with inventory features merged
    """
    sales = sales_df.copy()
    inv = inventory_df.copy()

    # Ensure SKU columns are strings
    for col in ["sku"]:
        if col in sales.columns:
            sales[col] = sales[col].astype(str)
        if col in inventory_df.columns:
            inventory_df[col] = inventory_df[col].astype(str)

    # Select inventory features to merge (avoid duplicating SKU/date)
    inv_cols = [c for c in inventory_df.columns if c not in ["sku", "date", "name"]]
    inv_cols = ["sku"] + [c for c in inv_cols if c in inventory_df.columns]

    merged = sales_df.merge(
        inventory_df[inv_cols],
        on="sku",
        how="left",
        suffixes=("", "_inv")
    )

    return merged


def add_stockout_features(
    df: pd.DataFrame,
    sku_col: str = "sku",
    qty_col: str = "quantity",
    reorder_pt_col: str = "reorder_pt",
    safety_stock_col: str = "safety_stock",
    date_col: str = "date",
) -> pd.DataFrame:
    """
    Add stockout prediction features to the panel.

    Args:
        df: Panel with SKU, date, quantity, reorder_pt, safety_stock
        sku_col: SKU column name
        qty_col: Current quantity column
        reorder_pt_col: Reorder point column
        safety_stock_col: Safety stock column
        date_col: Date column

    Returns:
        DataFrame with stockout features added
    """
    df = df.copy()
    df = df.sort_values([sku_col, date_col])

    # Current stock level relative to reorder point
    df["qty_vs_reorder"] = df[qty_col] / df[reorder_pt_col].replace(0, np.nan)
    df["qty_vs_reorder"] = df["qty_vs_reorder"].fillna(0)

    df["qty_vs_safety"] = df[qty_col] / df["safety_stock"].replace(0, np.nan)
    df["qty_vs_safety"] = df["qty_vs_safety"].fillna(0)

    # Days until stockout at current velocity (if we had velocity)
    # Approximate using 7-day rolling avg
    if "velocity_7" in df.columns:
        df["days_to_stockout"] = np.where(
            df["velocity_7"] > 0,
            df["quantity"] / df["velocity_7"],
            np.inf
        )
        df["days_to_stockout"] = df["days_to_stockout"].replace([np.inf, -np.inf], np.nan).fillna(999)

    # Stockout within horizon
    for horizon in [7, 14, 30]:
        col = f"stockout_risk_{horizon}d"
        if "velocity_7" in df.columns:
            df[col] = (df["quantity"] / df["velocity_7"] <= horizon).astype(int)
            df[col] = df[col].fillna(0)

    return df


def compute_velocity(
    df: pd.DataFrame,
    sku_col: str = "sku",
    qty_col: str = "quantity",
    date_col: str = "date",
    windows: List[int] = None,
) -> pd.DataFrame:
    """
    Compute sales velocity (units/day) over various windows.

    Args:
        df: Panel with SKU, date, quantity
        sku_col: SKU column
        qty_col: Quantity column
        date_col: Date column
        windows: List of window sizes in days

    Returns:
        DataFrame with velocity features
    """
    if windows is None:
        windows = [7, 14, 30]

    df = df.copy()
    df = df.sort_values([sku_col, date_col])

    for window in windows:
        col_name = f"velocity_{window}"
        df[col_name] = df.groupby("sku")[qty_col].transform(
            lambda x: x.rolling(window, min_periods=1).mean()
        )

    return df