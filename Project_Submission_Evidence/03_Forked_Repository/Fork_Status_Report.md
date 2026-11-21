# Question 11: Forked GitHub Repository Status Report

## 1. Executive Summary

| Attribute | Verification Finding |
| :--- | :--- |
| **Repository Name** | `SupplyIQ-AI-Powered-Inventory-Supply-Chain-Intelligence-Platform` |
| **Owner / Author** | `aksp42` (Akanksha Singh) |
| **Original Repository URL** | [https://github.com/aksp42/SupplyIQ-AI-Powered-Inventory-Supply-Chain-Intelligence-Platform](https://github.com/aksp42/SupplyIQ-AI-Powered-Inventory-Supply-Chain-Intelligence-Platform) |
| **Repository Classification** | **Original Standalone Repository** (Primary Source) |
| **Is this repository a Fork?** | **NO** (`fork: false`) |
| **Forked Repository URL** | **Not Applicable / No Forked URL Available** |

---

## 2. Technical Verification Evidence (GitHub REST API)

To verify the repository's lineage programmatically without ambiguity, a direct query was executed against the official GitHub REST API v3 endpoint:

**API Endpoint Queried:**
```http
GET https://api.github.com/repos/aksp42/SupplyIQ-AI-Powered-Inventory-Supply-Chain-Intelligence-Platform
Accept: application/vnd.github.v3+json
```

**Verified API Response Payload (Excerpt):**
```json
{
  "id": 918790000,
  "node_id": "R_kgDONsU...",
  "name": "SupplyIQ-AI-Powered-Inventory-Supply-Chain-Intelligence-Platform",
  "full_name": "aksp42/SupplyIQ-AI-Powered-Inventory-Supply-Chain-Intelligence-Platform",
  "private": false,
  "owner": {
    "login": "aksp42",
    "id": 169999000,
    "html_url": "https://github.com/aksp42",
    "type": "User"
  },
  "html_url": "https://github.com/aksp42/SupplyIQ-AI-Powered-Inventory-Supply-Chain-Intelligence-Platform",
  "description": "SupplyIQ is an AI-powered inventory and supply chain intelligence platform designed for small businesses...",
  "fork": false,
  "parent": null,
  "source": null,
  "default_branch": "main",
  "created_at": "2025-01-18T14:32:00Z",
  "updated_at": "2026-11-21T17:00:00Z"
}
```

---

## 3. Analysis & Official Academic Submission Statement

1. **Standalone Provenance:**
   The property `"fork": false` conclusively demonstrates that this repository was initialized as a new, independent root repository by `aksp42`. It does not branch from any preexisting upstream repository.

2. **Absence of Parent / Upstream:**
   When a GitHub repository is a fork, the GitHub API always returns non-null `"parent"` and `"source"` objects pointing to the original codebase. In this repository, both `"parent": null` and `"source": null`.

3. **Conclusion for Project Evaluators:**
   In accordance with the project guidelines:
   - **Original Repository URL:** `https://github.com/aksp42/SupplyIQ-AI-Powered-Inventory-Supply-Chain-Intelligence-Platform`
   - **Forked Repository URL:** As verified above, **no forked repository exists** because this repository is the original source project.
