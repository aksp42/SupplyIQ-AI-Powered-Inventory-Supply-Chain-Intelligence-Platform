"""
Synthetic historical data generator for SupplyIQ ML development.

Generates realistic SKU-level historical sales data when real data is insufficient.
All generated data is clearly marked with source='synthetic' for traceability.
"""

import pandas as pd
import numpy as np
from datetime import date as date_cls, datetime, timedelta
from typing import List, Dict, Optional
import warnings
warnings.filterwarnings("ignore")


def generate_synthetic_sales_history(
    products: list[dict],
    store_id: str,
    organization_id: int,
    days: int = 90,
    seed: int = 42,
) -> pd.DataFrame:
    """
    Generate synthetic SKU-level daily sales history.

    Args:
        products: List of product dicts with keys:
            - id, sku, name, category, monthly_demand, default_sell_price, default_unit_cost
        store_id: Store identifier
        organization_id: Organization ID
        days: Number of days of history to generate
        seed: Random seed for reproducibility

    Returns:
        DataFrame with columns: date, sku, quantity, sales, profit, units_sold
    """
    np.random.seed(seed)

    end_date = date_cls.today() - timedelta(days=1)
    dates = pd.date_range(end=end_date, periods=days, freq="D")

    # Product demand profiles
    product_profiles = {}
    for p in products:
        monthly_demand = float(p.get("monthly_demand", 100))
        unit_cost = float(p.get("default_unit_cost", 100))
        unit_price = float(p.get("default_sell_price", unit_cost * 1.5))

        # Daily base demand
        daily_base = monthly_demand / 30.0

        product_profiles[p["sku"]] = {
            "daily_base": daily_base,
            "unit_price": unit_price,
            "unit_cost": unit_cost,
            "category": p.get("category", "General"),
        }

    rows = []

    for date in dates:
        dow = date.dayofweek  # 0=Mon, 6=Sun
        is_sunday = (dow == 6)
        is_weekend = dow >= 5

        # Weekend boost factor
        weekend_multiplier = 1.5 if is_weekend and not is_sunday else 1.0
        sunday_multiplier = 0.0 if is_sunday else 1.0

        daily_revenue = 0
        daily_units = 0

        for p in products:
            sku = p["sku"]
            profile = product_profiles[sku]

            if is_sunday:
                qty = 0
            else:
                # Poisson demand with weekend boost
                daily_lambda = profile["daily_base"] * weekend_multiplier
                qty = np.random.poisson(max(0.1, daily_lambda))

            unit_price = profile["unit_price"]
            unit_cost = profile["unit_cost"]

            sales = qty * unit_price
            cost = qty * unit_cost
            profit = sales - cost

            daily_revenue += sales
            daily_units += qty

            rows.append({
                "date": date,
                "sku": sku,
                "name": p["name"],
                "quantity": qty,
                "sales": round(sales, 2),
                "profit": round(profit, 2),
                "units_sold": qty,
                "unit_price": unit_price,
                "unit_cost": unit_cost,
                "source": "synthetic",
            })

        # Adjust to match aggregate daily sales pattern if needed
        # (Optional: could calibrate to match aggregate daily sales table)

    df = pd.DataFrame(rows)
    df["date"] = pd.to_datetime(df["date"])
    df["source"] = "synthetic"

    return df


def distribute_aggregate_sales(
    aggregate_sales_df: pd.DataFrame,
    sku_sales_df: pd.DataFrame,
    date_col: str = "date",
    qty_col: str = "quantity",
) -> pd.DataFrame:
    """
    Distribute aggregate daily sales across SKUs proportionally.

    Args:
        aggregate_sales_df: Daily aggregate sales (date, total_sales, total_units)
        sku_sales_df: SKU-level synthetic sales (date, sku, quantity, sales)

    Returns:
        Calibrated SKU-level sales matching aggregate totals
    """
    # Aggregate synthetic by date
    synth_agg = sku_sales_df.groupby("date").agg(
        synth_qty=("quantity", "sum"),
        synth_sales=("sales", "sum")
    ).reset_index()

    # Merge with actual aggregate
    merged = aggregate_sales_df.merge(synth_agg, on="date", how="left")

    # Calculate scaling factors
    merged["qty_scale"] = merged["units_sold"] / merged["synth_qty"].replace(0, np.nan)
    merged["sales_scale"] = merged["sales"] / merged["synth_sales"].replace(0, np.nan)

    # Fill NaN scales with 1
    merged["qty_scale"] = merged["qty_scale"].fillna(1)
    merged["sales_scale"] = merged["sales_scale"].fillna(1)

    # Merge scales back to SKU-level data
    sku_sales = sku_sales_df.merge(
        merged[["date", "qty_scale", "sales_scale"]],
        on="date",
        how="left"
    )

    # Apply scaling
    sku_sales["quantity"] = (sku_sales["quantity"] * sku_sales["qty_scale"]).round().astype(int)
    sku_sales["sales"] = (sku_sales["sales"] * sku_sales["sales_scale"]).round(2)
    sku_sales["profit"] = (sku_sales["sales"] - sku_sales["quantity"] * sku_sales["unit_cost"]).round(2)

    return sku_sales


def generate_full_history(
    products: list[dict],
    store_id: str,
    organization_id: int,
    days: int = 90,
    seed: int = 42,
    calibrate_to_aggregate: bool = True,
) -> pd.DataFrame:
    """
    Generate complete synthetic sales history calibrated to aggregate data.

    Args:
        products: Product catalog with demand profiles
        store_id: Store identifier
        organization_id: Organization ID
        days: Days of history to generate
        seed: Random seed
        calibrate_to_aggregate: Whether to calibrate to actual aggregate sales table

    Returns:
        DataFrame with synthetic sales history
    """
    # Generate base synthetic data
    synth_df = generate_synthetic_sales_history(
        products=products,
        store_id=store_id,
        organization_id=organization_id,
        days=days,
        seed=seed,
    )

    if not calibrate_to_aggregate:
        return synth_df

    # Get actual aggregate sales for calibration
    from ..database import get_sales_history
    agg_list = get_sales_history(store_id="demo-store-01", days=90)
    agg_df = pd.DataFrame(agg_list)

    if not agg_df.empty:
        # Calibrate synthetic to match aggregate
        agg_df = agg_df.rename(columns={
            "sales": "total_sales",
            "units_sold": "total_units"
        })[["date", "total_sales", "total_units"]]
        sku_sales_df = sku_sales_df.rename(columns={"quantity": "synth_qty", "sales": "synth_sales"})

        calibrated_df = distribute_aggregate_sales(agg_df, synth_df)
        return calibrated_df

    return synth_df