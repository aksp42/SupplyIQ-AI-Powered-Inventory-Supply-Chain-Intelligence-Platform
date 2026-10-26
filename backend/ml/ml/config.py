"""
SupplyIQ ML Configuration

Loads settings from environment variables with sensible defaults.
All sensitive configuration comes from environment variables.
"""

import os
from pathlib import Path
from typing import Optional
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=Path(__file__).parent.parent.parent / ".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # Database
    db_host: str = Field(default="localhost", validation_alias="DB_HOST")
    db_port: int = Field(default=3306, validation_alias="DB_PORT")
    db_user: str = Field(default="root", validation_alias="DB_USER")
    db_password: str = Field(validation_alias="DB_PASSWORD")
    db_name: str = Field(default="supplyiq", validation_alias="DB_NAME")

    # ML Service
    ml_port: int = Field(default=8001, validation_alias="ML_PORT")
    ml_host: str = Field(default="0.0.0.0", validation_alias="ML_HOST")

    # Model Settings
    forecast_horizon_days: int = Field(default=30, validation_alias="FORECAST_HORIZON_DAYS")
    min_history_days: int = Field(default=14, validation_alias="MIN_HISTORY_DAYS")
    seasonal_period: int = Field(default=7, validation_alias="SEASONAL_PERIOD")
    retrain_frequency_days: int = Field(default=7, validation_alias="RETRAIN_FREQUENCY_DAYS")

    # Model Paths
    model_registry_path: str = Field(default="./models/registry", validation_alias="MODEL_REGISTRY_PATH")

    # Training
    lightgbm_n_estimators: int = Field(default=200, validation_alias="LIGHTGBM_N_ESTIMATORS")
    lightgbm_learning_rate: float = Field(default=0.05, validation_alias="LIGHTGBM_LEARNING_RATE")
    lightgbm_max_depth: int = Field(default=6, validation_alias="LIGHTGBM_MAX_DEPTH")
    lightgbm_random_state: int = Field(default=42, validation_alias="LIGHTGBM_RANDOM_STATE")

    # Evaluation
    min_train_days: int = Field(default=14, validation_alias="MIN_TRAIN_DAYS")
    validation_days: int = Field(default=30, validation_alias="VALIDATION_DAYS")
    min_observations_per_product: int = Field(default=14, validation_alias="MIN_OBS_PER_PRODUCT")

    # Logging
    log_level: str = Field(default="INFO", validation_alias="LOG_LEVEL")

    @property
    def db_url(self) -> str:
        return f"mysql+mysqlconnector://{self.db_user}:{self.db_password}@{self.db_host}:{self.db_port}/{self.db_name}"


settings = Settings()