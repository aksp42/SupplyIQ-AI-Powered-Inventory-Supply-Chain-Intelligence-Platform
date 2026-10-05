"""
Database connection pool for SupplyIQ ML Service.

Read-only connection pool for ML inference and training.
Uses the same connection parameters as the main backend.
"""

import os
import logging
from contextlib import contextmanager
from typing import Any, Dict, List, Optional, Generator
from contextlib import asynccontextmanager

import mysql.connector
from mysql.connector import pooling
from mysql.connector.pooling import MySQLConnectionPool

from .config import settings

logger = logging.getLogger(__name__)

_pool: Optional[MySQLConnectionPool] = None


def get_pool() -> MySQLConnectionPool:
    """Get or create the global connection pool."""
    global _pool
    if _pool is None:
        _pool = pooling.MySQLConnectionPool(
            pool_name="ml_pool",
            pool_size=5,
            pool_reset_session=True,
            host=settings.db_host,
            port=settings.db_port,
            user=settings.db_user,
            password=settings.db_password,
            database=settings.db_name,
            autocommit=True,
            charset="utf8mb4",
            collation="utf8mb4_0900_ai_ci",
            time_zone="+00:00",
            raise_on_warnings=True,
        )
        logger.info("Created ML database connection pool")
    return _pool


def close_pool() -> None:
    """Close the global connection pool."""
    global _pool
    if _pool is not None:
        # mysql-connector-python doesn't have a direct close method on pool
        # We just set it to None and let GC handle it
        _pool = None
        logger.info("Closed ML database connection pool")


@contextmanager
def get_connection() -> Generator:
    """Get a connection from the pool."""
    pool = get_pool()
    conn = pool.get_connection()
    try:
        yield conn
    finally:
        conn.close()


def execute_query(
    query: str,
    params: Optional[tuple] = None,
    fetch: bool = True,
) -> List[Dict[str, Any]]:
    """
    Execute a SELECT query and return results as list of dicts.

    Args:
        query: SQL query string with %s placeholders
        params: Query parameters
        fetch: Whether to fetch results (True for SELECT, False for DML)

    Returns:
        List of dictionaries representing rows
    """
    with get_connection() as conn:
        cursor = conn.cursor(dictionary=True)
        try:
            cursor.execute(query, params or ())
            if fetch:
                results = cursor.fetchall()
                return results or []
            else:
                conn.commit()
                return [{"affected_rows": cursor.rowcount, "insert_id": cursor.lastrowid}]
        except Exception as e:
            logger.error(f"Query failed: {query[:100]}... Error: {e}")
            raise
        finally:
            cursor.close()


def execute_many(query: str, params_list: List[tuple]) -> int:
    """Execute many INSERT/UPDATE statements."""
    with get_connection() as conn:
        cursor = conn.cursor()
        try:
            cursor.executemany(query, params_list)
            conn.commit()
            return cursor.rowcount
        except Exception as e:
            logger.error(f"Batch query failed: {e}")
            raise
        finally:
            cursor.close()


# --- High-level data access functions for ML ---


def get_store_id_from_session(session_store_id: str) -> Optional[str]:
    """Validate store_id exists and return it."""
    result = execute_query(
        "SELECT store_id FROM stores WHERE store_id = %s AND is_active = 1",
        (session_store_id,),
    )
    return result[0]["store_id"] if result else None


def get_organization_id(store_id: str) -> Optional[int]:
    """Get organization_id for a store."""
    result = execute_query(
        "SELECT organization_id FROM stores WHERE store_id = %s", (store_id,)
    )
    return result[0]["organization_id"] if result else None


def get_active_products(store_id: str) -> list[dict]:
    """Get active products for a store with their inventory info."""
    org_id = get_organization_id(store_id)
    if not org_id:
        return []

    return execute_query(
        """
        SELECT p.id, p.sku, p.name, p.default_unit_cost, p.default_sell_price,
               i.quantity, i.monthly_demand, i.reorder_pt, i.safety_stock, i.status,
               c.name as category
        FROM products p
        JOIN inventory i ON i.product_id = p.id
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.organization_id = %s AND i.store_id = %s AND p.is_active = 1
        ORDER BY p.name
        """,
        (org_id, store_id),
    )


def get_sales_history(store_id: str, days: int = 90) -> list[dict]:
    """Get daily sales history for a store from stock_movements (reason='sale')."""
    return execute_query(
        """
        SELECT 
            DATE(sm.occurred_at) as date,
            p.sku,
            p.name,
            SUM(sm.quantity) as quantity,
            SUM(sm.quantity * sm.unit_cost) as cost,
            SUM(sm.quantity * p.default_sell_price) as sales
        FROM stock_movements sm
        JOIN products p ON p.id = sm.product_id
        WHERE sm.store_id = %s
          AND sm.direction = 'OUT'
          AND sm.reason = 'sale'
          AND sm.occurred_at >= DATE_SUB(CURDATE(), INTERVAL %s DAY)
        GROUP BY DATE(sm.occurred_at), p.sku, p.name
        ORDER BY date ASC
        """,
        (store_id, days),
    )


def get_product_sales_history(store_id: str, sku: str, days: int = 90) -> list[dict]:
    """Get sales history for a specific product."""
    return execute_query(
        """
        SELECT date, quantity, sales, profit
        FROM sales
        WHERE store_id = %s AND sku = %s
        ORDER BY date ASC
        LIMIT %s
        """,
        (store_id, sku, days),
    )


def get_inventory_snapshot(store_id: str) -> list[dict]:
    """Get current inventory snapshot for a store."""
    return execute_query(
        """
        SELECT p.id, p.sku, p.name, i.quantity, i.monthly_demand, i.reorder_pt,
               i.safety_stock, i.max_stock, i.unit_cost, i.status
        FROM inventory i
        JOIN products p ON p.id = i.product_id
        WHERE i.store_id = %s AND p.is_active = 1
        ORDER BY p.name
        """,
        (store_id,),
    )


def get_stock_movements(store_id: str, days: int = 30) -> list[dict]:
    """Get recent stock movements for a store."""
    return execute_query(
        """
        SELECT sm.*, p.sku, p.name
        FROM stock_movements sm
        JOIN products p ON p.id = sm.product_id
        WHERE sm.store_id = %s
        AND sm.occurred_at >= DATE_SUB(CURDATE(), INTERVAL %s DAY)
        ORDER BY sm.occurred_at DESC
        LIMIT 1000
        """,
        (store_id, days),
    )


def get_supplier_lead_times(organization_id: int) -> list[dict]:
    """Get supplier lead time statistics."""
    return execute_query(
        """
        SELECT slt.*, s.name as supplier_name, p.sku, p.name as product_name
        FROM supplier_lead_times slt
        JOIN suppliers s ON s.id = slt.supplier_id
        LEFT JOIN products p ON p.id = slt.product_id
        WHERE slt.organization_id = %s
        ORDER BY slt.ordered_on DESC
        """,
        (organization_id,),
    )


def get_supplier_performance(organization_id: int) -> list[dict]:
    """Get supplier performance metrics."""
    return execute_query(
        """
        SELECT sp.*, s.name as supplier_name
        FROM supplier_performance sp
        JOIN suppliers s ON s.id = sp.supplier_id
        WHERE sp.organization_id = %s
        ORDER BY sp.computed_at DESC
        """,
        (organization_id,),
    )


def get_purchase_orders(store_id: str, days: int = 90) -> list[dict]:
    """Get purchase orders for a store."""
    return execute_query(
        """
        SELECT po.*, s.name as supplier_name,
               COALESCE(SUM(pi.quantity), 0) as total_qty,
               COALESCE(SUM(pi.received_qty), 0) as received_qty
        FROM purchase_orders po
        JOIN suppliers s ON s.id = po.supplier_id
        LEFT JOIN purchase_order_items pi ON pi.purchase_order_id = po.id
        WHERE po.store_id = %s
        AND po.order_date >= DATE_SUB(CURDATE(), INTERVAL %s DAY)
        GROUP BY po.id
        ORDER BY po.order_date DESC
        """,
        (store_id, days),
    )


def get_forecast_runs(store_id: str, limit: int = 10) -> list[dict]:
    """Get recent forecast runs for a store."""
    org_id = get_organization_id_from_store(store_id)
    if not org_id:
        return []

    return execute_query(
        """
        SELECT * FROM forecast_runs
        WHERE store_id = %s
        ORDER BY created_at DESC
        LIMIT %s
        """,
        (store_id, limit),
    )


def get_organization_id_from_store(store_id: str) -> Optional[int]:
    """Get organization_id from store_id."""
    result = execute_query(
        "SELECT organization_id FROM stores WHERE store_id = %s",
        (store_id,),
    )
    return result[0]["organization_id"] if result else None


def save_forecast_run(
    organization_id: int,
    store_id: str,
    run_key: str,
    model_name: str,
    horizon_days: int,
    window_start: str,
    window_end: str,
    created_by: Optional[int] = None,
) -> int:
    """Create a new forecast run record."""
    result = execute_query(
        """
        INSERT INTO forecast_runs
        (organization_id, store_id, run_key, model_name, horizon_days,
         window_start, window_end, status, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)
        """,
        (organization_id, store_id, run_key, model_name, horizon_days,
         window_start, window_end, None),
        fetch=False,
    )
    return result[0]["insert_id"]


def update_forecast_run(run_id: int, **kwargs) -> None:
    """Update forecast run fields."""
    if not kwargs:
        return
    set_clause = ", ".join(f"{k} = %s" for k in kwargs.keys())
    params = list(kwargs.values()) + [1]  # + run_id
    execute_query(
        f"UPDATE forecast_runs SET {set_clause} WHERE id = %s",
        tuple(params),
        fetch=False,
    )


def save_forecast_results(
    run_id: int,
    organization_id: int,
    store_id: str,
    results: list[dict],
) -> int:
    """Save forecast results for a run."""
    if not results:
        return 0

    query = """
    INSERT INTO forecast_results
    (forecast_run_id, organization_id, store_id, product_id,
     forecast_date, p10_qty, p50_qty, p90_qty, stockout_risk)
    VALUES
    """ + ", ".join(["%s"] * len(results))

    params = []
    for r in results:
        params.extend([
            r["forecast_run_id"], r["organization_id"], r["store_id"],
            r["product_id"], r["forecast_date"], r["p10_qty"],
            r["p50_qty"], r["p90_qty"], r.get("stockout_risk", 0)
        ])

    execute_query(query, tuple(params), fetch=False)
    return len(results)


def save_model_metrics(
    run_id: int,
    organization_id: int,
    store_id: str,
    metrics: list[dict],
) -> int:
    """Save model evaluation metrics."""
    if not metrics:
        return 0

    query = """
    INSERT INTO model_metrics
    (forecast_run_id, organization_id, store_id, product_id,
     model_name, mape, wape, mae, rmse, bias, observations, is_reliable)
    VALUES
    """ + ", ".join(["%s"] * len(metrics))

    params = []
    for m in metrics:
        params.extend([
            m["forecast_run_id"], m["organization_id"], m["store_id"],
            m["product_id"], m["model_name"], m.get("mape"),
            m.get("wape"), m.get("mae"), m.get("rmse"), m.get("bias"),
            m.get("observations", 0), m.get("is_reliable", 1)
        ])

    execute_query(query, tuple(params), fetch=False)
    return len(metrics)


def get_product_sales_series(store_id: str, product_id: int, days: int = 90) -> list[dict]:
    """Get sales history for a specific product."""
    return execute_query(
        """
        SELECT s.date, s.quantity, s.sales, s.profit
        FROM sales s
        WHERE s.store_id = %s AND s.sku = (
            SELECT sku FROM products WHERE id = %s
        )
        ORDER BY s.date ASC
        LIMIT %s
        """,
        (store_id, product_id, 90),
    )


def get_inventory_by_product(store_id: str, product_id: int) -> Optional[dict]:
    """Get current inventory for a specific product."""
    result = execute_query(
        """
        SELECT i.*, p.sku, p.name
        FROM inventory i
        JOIN products p ON p.id = i.product_id
        WHERE i.store_id = %s AND i.product_id = %s
        """,
        (store_id, product_id),
    )
    return result[0] if result else None


def get_product_info(organization_id: int, sku: str) -> Optional[dict]:
    """Get product by SKU within an organization."""
    result = execute_query(
        "SELECT * FROM products WHERE organization_id = %s AND sku = %s",
        (organization_id, sku),
    )
    return result[0] if result else None


def get_suppliers(organization_id: int) -> list[dict]:
    """Get all active suppliers for an organization."""
    return execute_query(
        "SELECT * FROM suppliers WHERE organization_id = %s AND is_active = 1",
        (organization_id,),
    )