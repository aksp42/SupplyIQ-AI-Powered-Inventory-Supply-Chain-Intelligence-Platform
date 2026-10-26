"""
Evaluation package for SupplyIQ ML.
"""

from .metrics import (
    calculate_metrics,
    calculate_metrics_per_product,
    aggregate_metrics,
    check_forecast_validity,
)

from .backtest import (
    time_series_split,
    rolling_time_series_split,
    evaluate_forecast_model,
    backtest_model,
    compare_models,
    generate_backtest_report,
)

__all__ = [
    "calculate_metrics",
    "calculate_metrics_per_product",
    "aggregate_metrics",
    "check_forecast_validity",
    "time_series_split",
    "rolling_time_series_split",
    "evaluate_forecast_model",
    "backtest_model",
    "compare_models",
    "generate_backtest_report",
]