"""
Feature engineering package for SupplyIQ ML.
"""

from .calendar import (
    add_calendar_features,
    generate_future_dates,
    is_holiday,
    is_weekend,
    is_working_day,
    is_sufficient_history,
    get_history_stats,
    INDIAN_HOLIDAYS,
    WEEKEND_DAYS,
)

"""
Feature engineering package for SupplyIQ ML.
"""

from .calendar import (
    add_calendar_features,
    generate_future_dates,
    is_holiday,
    is_weekend,
    is_working_day,
    is_sufficient_history,
    get_history_stats,
    INDIAN_HOLIDAYS,
    WEEKEND_DAYS,
)

from .sales_features import (
    build_sales_panel,
    add_lag_features,
    add_rolling_features,
    add_trend_features,
    add_demand_features,
    build_feature_matrix,
    filter_sufficient_history,
    add_lag_features,
    add_rolling_features,
    add_trend_features,
    add_demand_features,
)

from .inventory_features import (
    add_inventory_features,
    merge_inventory_features,
    add_stockout_features,
    compute_velocity,
    add_inventory_features,
)

__all__ = [
    # calendar
    "add_calendar_features",
    "generate_future_dates",
    "is_holiday",
    "is_weekend",
    "is_working_day",
    "is_sufficient_history",
    "get_history_stats",
    "INDIAN_HOLIDAYS",
    "WEEKEND_DAYS",
    # sales_features
    "build_sales_panel",
    "add_lag_features",
    "add_rolling_features",
    "add_trend_features",
    "add_demand_features",
    "build_feature_matrix",
    "filter_sufficient_history",
    "add_lag_features",
    "add_rolling_features",
    "add_trend_features",
    "add_demand_features",
    "compute_velocity",
    # inventory_features
    "add_inventory_features",
    "merge_inventory_features",
    "add_stockout_features",
    "compute_velocity",
]