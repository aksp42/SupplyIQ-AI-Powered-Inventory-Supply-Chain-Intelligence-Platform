"""
Forecast pipeline for SupplyIQ ML.

Orchestrates data extraction, feature engineering, model training,
evaluation, and result storage.
"""

import pandas as pd
import numpy as np
from typing import Optional, Dict, List, Tuple, Any
from datetime import date, datetime, timedelta
import uuid
import logging
import warnings
warnings.filterwarnings("ignore")

from ..config import settings
from ..database import (
    get_active_products,
    get_sales_history,
    get_inventory_snapshot,
    get_supplier_lead_times,
    get_supplier_performance,
    get_organization_id_from_store,
    get_product_sales_series,
    get_inventory_by_product,
    get_product_info,
    get_suppliers,
)
from ..data.synthetic_generator import generate_full_history
from ..features import (
    build_feature_matrix,
    filter_sufficient_history,
    get_history_stats,
    merge_inventory_features,
    add_inventory_features,
)
from ..models import (
    NaiveForecast,
    SeasonalNaiveForecast,
    MovingAverageForecast,
    evaluate_baselines,
)
from ..evaluation import (
    time_series_split,
    backtest_model,
    generate_backtest_report,
)
from ..evaluation.metrics import calculate_metrics, calculate_metrics_per_product

logger = logging.getLogger(__name__)


class ForecastPipeline:
    """
    End-to-end forecast pipeline.

    Handles the complete workflow:
    1. Data extraction from MySQL
    2. Feature engineering
    2. Model training and evaluation
    3. Forecast generation
    4. Result storage
    """

    def __init__(
        self,
        store_id: str,
        model_name: str = "seasonal_naive",
        horizon_days: int = 30,
        validation_days: int = 30,
        min_history_days: int = 14,
    ):
        self.store_id = store_id
        self.model_name = model_name
        self.horizon_days = horizon_days
        self.validation_days = validation_days
        self.min_history_days = min_history_days
        self.run_id: Optional[int] = None
        self.organization_id: Optional[int] = None

    def _get_model(self, model_name: str):
        """Instantiate model by name."""
        models = {
            "naive": NaiveForecast,
            "seasonal_naive": SeasonalNaiveForecast,
            "sma_7": MovingAverageForecast,
        }
        if model_name not in models:
            raise ValueError(f"Unknown model: {model_name}. Available: {list(models.keys())}")
        return models[model_name](seasonal_period=7)

    def extract_data(self) -> Tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
        """
        Extract sales, inventory, and supplier data for the store.
        Generates synthetic data if real data is insufficient.

        Returns:
            (sales_df, inventory_df, products_df)
        """
        logger.info(f"Extracting data for store {self.store_id}")

        # Get organization ID
        self.organization_id = self._get_org_id()
        if not self.organization_id:
            raise ValueError(f"Store {self.store_id} not found")

        # Get active products for this store
        products = get_active_products(self.store_id)
        logger.info(f"Loaded {len(products)} active products")

        # Get inventory snapshot
        inventory_df = self._get_inventory_snapshot()
        logger.info(f"Loaded {len(inventory_df)} inventory records")

        # Get supplier info
        supplier_lt = get_supplier_lead_times(self.organization_id)
        logger.info(f"Loaded {len(supplier_lt)} supplier lead time records")

        # Try to get real sales history
        sales_df = get_sales_history(self.store_id, days=90)
        logger.info(f"Loaded {len(sales_df)} sales records")

        # Check if we have sufficient real sales data
        if len(sales_df) < 14:
            logger.warning("Insufficient real sales data, generating synthetic history...")
            # Generate synthetic sales history from product catalog
            synthetic_sales_df = generate_full_history(
                products=products,
                store_id=self.store_id,
                organization_id=self.organization_id,
                days=90,
                seed=42,
            )
            sales_df = synthetic_sales_df
            logger.info(f"Generated {len(sales_df)} synthetic sales records")
        else:
            logger.info("Using real sales data")

        # Get inventory snapshot
        inventory_df = self._get_inventory_snapshot()
        logger.info(f"Loaded {len(inventory_df)} inventory records")

        return sales_df, inventory_df, products

    def _get_org_id(self) -> Optional[int]:
        from ..database import queryOne
        result = queryOne(
            "SELECT organization_id FROM stores WHERE store_id = %s",
            (self.store_id,),
        )
        return result["organization_id"] if result else None

    def _get_inventory_snapshot(self) -> pd.DataFrame:
        from .database import get_inventory_snapshot
        return get_inventory_snapshot(self.store_id)

    def prepare_features(
        self,
        sales_df: pd.DataFrame,
        inventory_df: pd.DataFrame,
    ) -> Tuple[pd.DataFrame, Dict]:
        """
        Build feature matrix from sales and inventory data.

        Returns:
            (feature_matrix, data_quality_info)
        """
        logger.info("Building feature matrix...")

        # Build feature matrix from sales
        feature_df = build_feature_matrix(
            sales_df=sales_df,
            sku_col="sku",
            date_col="date",
            qty_col="quantity",
        )

        logger.info(f"Built feature matrix: {feature_df.shape}")

        # Get data quality info
        stats = get_history_stats(sales_df)
        logger.info(f"Data stats: {stats}")

        # Filter products with sufficient history
        filtered_df, info = filter_sufficient_history(
            feature_df,
            min_days=self.min_history_days,
        )

        logger.info(
            f"Products included: {info['included_products']}, "
            f"excluded: {info['excluded_products']} (insufficient history)"
        )

        if info["excluded_products"] > 0:
            logger.warning(f"Excluded products: {info['insufficient_history_products']}")

        return filtered_df, info

    def run_baseline_evaluation(
        self,
        feature_df: pd.DataFrame,
    ) -> Dict:
        """
        Evaluate baseline models using time-series backtesting.
        """
        logger.info("Running baseline evaluation...")

        # Use the last 60 days for evaluation (30 train, 30 validation)
        eval_results = evaluate_baselines(
            feature_df,
            horizon=7,
            validation_days=self.validation_days,
            seasonal_period=7,
        )

        return eval_results.to_dict("records") if not eval_results.empty else []

    def train_and_forecast(
        self,
        feature_df: pd.DataFrame,
        model_name: str = "seasonal_naive",
        horizon_days: int = None,
    ) -> Tuple[List[Dict], List[Dict]]:
        """
        Train model and generate forecasts.

        Returns:
            (forecasts, metrics)
        """
        if horizon_days is None:
            horizon_days = self.horizon_days

        logger.info(f"Training {self.model_name} model...")

        # Get model
        ModelClass = self._get_model(model_name)
        model = self._get_model(self.model_name)()

        # Train on full feature matrix
        model.fit(
            feature_df,
            sku_col="sku",
            date_col="date",
            qty_col="quantity",
        )

        # Generate forecasts for all products
        skus = feature_df["sku"].unique()
        all_forecasts = []
        all_metrics = []

        for sku in feature_df["sku"].unique():
            try:
                # Get validation data for this product
                product_df = feature_df[feature_df["sku"] == sku].copy()

                # Generate forecast
                forecast_df = model.predict(horizon=self.horizon_days, sku=sku)

                if forecast_df.empty:
                    continue

                # Add metadata
                forecast_df["forecast_run_id"] = self.run_id or 0
                forecast_df["organization_id"] = self.organization_id
                forecast_df["store_id"] = self.store_id
                forecast_df["model_name"] = self.model_name

                # Add stockout risk (simple heuristic)
                product_data = self._get_product_sales(feature_df, sku)
                last_qty = product_data["quantity"].iloc[-1] if not product_data.empty else 0
                avg_demand = product_data["quantity"].mean() if not product_data.empty else 0

                forecast_df["stockout_risk"] = (
                    (forecast_df["p50"] > 0) & (forecast_df["p50"] > 0)
                ).astype(int)  # placeholder

                all_forecasts.extend(forecast_df.to_dict("records"))

                # Calculate metrics if we have validation data
                # (would need actuals for the forecast period)

            except Exception as e:
                logger.warning(f"Failed to forecast for {sku}: {e}")
                continue

        return all_forecasts, all_metrics

    def _get_product_sales(self, feature_df: pd.DataFrame, sku: str) -> pd.DataFrame:
        """Get sales history for a specific SKU."""
        return feature_df[feature_df["sku"] == sku].sort_values("date")

    def run(self, model_name: str = "seasonal_naive") -> Dict[str, Any]:
        """
        Run the complete forecast pipeline.

        Returns:
            Dictionary with run results and metadata.
        """
        run_key = f"{self.model_name}-{self.store_id}-{uuid.uuid4().hex[:8]}"

        # Create forecast run record
        self.run_id = save_forecast_run(
            organization_id=self.organization_id,
            store_id=self.store_id,
            run_key=run_key,
            model_name=self.model_name,
            horizon_days=self.horizon_days,
            window_start=date.today().isoformat(),
            window_end=(date.today() + timedelta(days=self.horizon_days)).isoformat(),
            created_by=1,  # TODO: get from auth
        )

        try:
            update_forecast_run(self.run_id, status="running")

            # 1. Extract data
            sales_df, inventory_df, _ = self.extract_data()

            # 2. Prepare features
            feature_df, data_info = self.prepare_features(
                sales_df=sales_df,
                inventory_df=inventory_df,
            )

            # 3. Baseline evaluation
            eval_results = self.run_baseline_evaluation(feature_df)

            # 4. Train and forecast
            forecasts, metrics = self.train_and_forecast(feature_df)

            # 5. Save results
            if forecasts:
                save_forecast_results(
                    run_id=self.run_id,
                    organization_id=self.organization_id,
                    store_id=self.store_id,
                    results=forecasts,
                )

            if metrics:
                save_model_metrics(
                    run_id=self.run_id,
                    organization_id=self.organization_id,
                    store_id=self.store_id,
                    metrics=metrics,
                )

            # 6. Update run status
            update_forecast_run(
                self.run_id,
                status="completed",
                created_rows=len(forecasts),
                updated_rows=0,
            )

            return {
                "run_id": self.run_id,
                "run_key": run_key,
                "status": "completed",
                "forecasts_generated": len(forecasts),
                "data_quality": data_info,
                "baseline_eval": eval_results,
                "metrics": metrics,
            }

        except Exception as e:
            logger.error(f"Pipeline failed: {e}")
            update_forecast_run(
                self.run_id,
                status="failed",
                error_message=str(e),
            )
            raise


def run_forecast_pipeline(
    store_id: str,
    model_name: str = "seasonal_naive",
    horizon_days: int = 30,
    validation_days: int = 30,
    min_history_days: int = 14,
) -> Dict[str, Any]:
    """
    Convenience function to run the full pipeline.

    Args:
        store_id: Store identifier
        model_name: Model to use (naive, seasonal_naive, sma_7)
        horizon_days: Forecast horizon in days
        validation_days: Validation window for backtesting
        min_history_days: Minimum history required per product

    Returns:
        Pipeline results dictionary
    """
    pipeline = ForecastPipeline(
        store_id=store_id,
        model_name=model_name,
        horizon_days=horizon_days,
        validation_days=validation_days,
        min_history_days=min_history_days,
    )
    return pipeline.run(model_name)