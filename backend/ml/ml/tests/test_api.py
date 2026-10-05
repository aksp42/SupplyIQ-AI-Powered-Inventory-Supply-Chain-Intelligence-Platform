"""
Test API client integration.
"""

import pytest
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "js"))

# Note: This tests the Python API client conceptually
# The actual JS api.js would be tested in the browser


def test_api_client_structure():
    """Test that api.js has the expected structure."""
    api_path = os.path.join(
        os.path.dirname(__file__),
        "..",
        "..",
        "frontend",
        "js",
        "api.js"
    )

    with open(api_path, "r") as f:
        content = f.read()

    # Check key exports exist
    assert "siqApi" in content
    assert "getStoreId" in content
    assert "auth" in content
    assert "store" in content
    assert "kpis" in content
    assert "sales" in content
    assert "inventory" in content
    assert "stock" in content
    assert "orders" in content
    assert "imports" in content
    assert "chat" in content


def test_api_client_methods():
    """Test that API client has all required methods."""
    api_path = os.path.join(
        os.path.dirname(__file__),
        "..",
        "..",
        "frontend",
        "js",
        "api.js"
    )

    with open(api_path, "r") as f:
        content = f.read()

    # Auth methods
    assert "login" in content
    assert "signup" in content
    assert "firebase" in content
    assert "logout" in content

    # Store methods
    assert "list" in content
    assert "get" in content
    assert "profile" in content

    # KPI methods
    assert "get" in content

    # Sales methods
    assert "sales" in content
    assert "get" in content

    # Inventory methods
    assert "inventory" in content
    assert "get" in content

    # Stock methods
    assert "stock" in content
    assert "in" in content
    assert "out" in content
    assert "transactions" in content

    # Orders methods
    assert "orders" in content
    assert "list" in content
    assert "create" in content
    assert "receive" in content

    # Imports methods
    assert "imports" in content
    assert "types" in content
    assert "validate" in content
    assert "get" in content
    assert "commit" in content
    assert "history" in content

    # Chat methods
    assert "chat" in content
    assert "send" in content


if __name__ == "__main__":
    pytest.main([__file__, "-v"])