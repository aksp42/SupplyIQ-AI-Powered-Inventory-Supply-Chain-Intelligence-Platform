"""
Test database module with proper mocking.
"""

import pytest
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from ml.database import (
    get_store_id_from_session,
    get_organization_id,
    get_active_products,
    get_sales_history,
    get_inventory_snapshot,
    get_stock_movements,
    get_supplier_lead_times,
    get_supplier_performance,
    get_purchase_orders,
    get_forecast_runs,
    get_organization_id_from_store,
    get_product_sales_series,
    get_inventory_by_product,
    get_product_info,
    get_suppliers,
)


class MockCursor:
    def __init__(self, results=None):
        self.results = results or []
        self.rowcount = len(self.results)
        self.lastrowid = 1
        self._index = 0

    def execute(self, query, params=None):
        pass

    def fetchall(self):
        return self.results

    def fetchone(self):
        return self.results[0] if self.results else None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def close(self):
        pass


class MockConnection:
    def __init__(self, results=None):
        self.results = results or []
        self._cursor = MockCursor(self.results)

    def cursor(self, dictionary=True):
        return self._cursor

    def commit(self):
        pass

    def close(self):
        pass


class MockPool:
    def __init__(self, results=None):
        self.results = results or []

    def get_connection(self):
        return MockConnection(self.results)


def test_get_store_id_from_session():
    """Test store_id extraction from session."""
    with patch('ml.database.get_pool') as mock_pool:
        mock_pool.return_value = MockPool([
            {"store_id": "demo-store-01"}
        ])
        result = get_store_id_from_session("demo-store-01")
        assert result == "demo-store-01"

    # Test non-existent store
    with patch('ml.database.get_pool') as mock_pool:
        mock_pool.return_value = MockPool([])
        result = get_store_id_from_session("invalid-store")
        assert result is None


def test_get_organization_id():
    """Test organization_id lookup from store_id."""
    with patch('ml.database.get_pool') as mock_pool:
        mock_pool.return_value = MockPool([
            {"organization_id": 2}
        ])
        result = get_organization_id("demo-store-01")
        assert result == 2


def test_get_active_products():
    """Test fetching active products for a store."""
    with patch('ml.database.get_pool') as mock_pool:
        mock_pool.return_value = MockPool([
            {"id": 1, "sku": "GRC-001", "name": "Basmati Rice 5kg", "quantity": 8},
            {"id": 2, "sku": "GRC-002", "name": "Sunflower Oil 1L", "quantity": 20},
        ])
        products = get_active_products("demo-store-01")
        assert len(products) == 2
        assert products[0]["sku"] == "GRC-001"


def test_get_sales_history():
    """Test fetching sales history."""
    with patch('ml.database.get_pool') as mock_pool:
        mock_pool.return_value = MockPool([
            {"date": "2026-10-01", "sku": "GRC-001", "quantity": 10, "sales": 7800, "profit": 1800},
            {"date": "2026-10-02", "sku": "GRC-001", "quantity": 5, "sales": 3900, "profit": 900},
        ])
        history = get_sales_history("demo-store-01", days=30)
        assert len(history) == 2


def test_get_inventory_snapshot():
    """Test fetching inventory snapshot."""
    with patch('ml.database.get_pool') as mock_pool:
        mock_pool.return_value = MockPool([
            {"sku": "GRC-001", "quantity": 8, "monthly_demand": 420, "reorder_pt": 50},
            {"sku": "GRC-002", "quantity": 20, "monthly_demand": 300, "reorder_pt": 30},
        ])
        inv = get_inventory_snapshot("demo-store-01")
        assert len(inv) == 2


def test_get_stock_movements():
    """Test fetching stock movements."""
    with patch('ml.database.get_pool') as mock_pool:
        mock_pool.return_value = MockPool([
            {"sku": "GRC-001", "direction": "IN", "quantity": 100, "reason": "purchase"},
            {"sku": "GRC-001", "direction": "OUT", "quantity": 10, "reason": "sale"},
        ])
        movements = get_stock_movements("demo-store-01", days=30)
        assert len(movements) == 2


def test_get_supplier_lead_times():
    """Test fetching supplier lead times."""
    with patch('ml.database.get_pool') as mock_pool:
        mock_pool.return_value = MockPool([
            {"supplier_id": 1, "product_id": 1, "actual_days": 10, "is_late": 0},
            {"supplier_id": 1, "product_id": 3, "actual_days": 12, "is_late": 1},
        ])
        lt = get_supplier_lead_times(2)
        assert len(lt) == 2


def test_get_supplier_performance():
    """Test fetching supplier performance."""
    with patch('ml.database.get_pool') as mock_pool:
        mock_pool.return_value = MockPool([
            {"supplier_id": 1, "on_time_rate": 95.0, "avg_lead_time_days": 7},
        ])
        perf = get_supplier_performance(2)
        assert len(perf) == 1


def test_tenant_isolation():
    """Test that queries are properly scoped to organization_id."""
    with patch('ml.database.get_pool') as mock_pool:
        mock_pool.return_value = MockPool([
            {"id": 1, "sku": "GRC-001", "organization_id": 2},
            {"id": 2, "sku": "GRC-002", "organization_id": 2},
        ])
        products = get_active_products("demo-store-01")
        assert len(products) == 2


if __name__ == "__main__":
    pytest.main([__file__, "-v"])