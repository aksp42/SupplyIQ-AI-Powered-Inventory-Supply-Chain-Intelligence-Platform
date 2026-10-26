# SupplyIQ Architecture Documentation

## Overview
SupplyIQ is a multi-tenant inventory and supply chain management system with a MySQL 8 backend and React/vanilla JS frontend. Firebase is used **only for Google/Microsoft OAuth authentication**; all business data lives in MySQL.

## Technology Stack
- **Backend**: Node.js 24 + Express + mysql2/promise
- **Database**: MySQL 8.0 (InnoDB, utf8mb4, timezone UTC)
- **Auth**: Firebase (Google/Microsoft OAuth) + bcrypt email/password
- **Frontend**: Vanilla JS + HTML/CSS (served statically)
- **CSV Import**: RFC 4180 parser + preview/validate/commit workflow

## Database Architecture (ER Overview)

```mermaid
erDiagram
    ORGANIZATIONS ||--o{ STORES : "has"
    ORGANIZATIONS ||--o{ USERS : "owns"
    STORES ||--o{ STORE_MEMBERS : "has"
    USERS ||--o{ STORE_MEMBERS : "belongs to"
    ROLES ||--o{ STORE_MEMBERS : "assigned"
    ROLES ||--o{ ROLE_PERMISSIONS : "grants"
    PERMISSIONS ||--o{ ROLE_PERMISSIONS : "granted to"

    ORGANIZATIONS ||--o{ CATEGORIES : "contains"
    ORGANIZATIONS ||--o{ PRODUCTS : "contains"
    ORGANIZATIONS ||--o{ WAREHOUSES : "contains"
    ORGANIZATIONS ||--o{ SUPPLIERS : "contains"
    ORGANIZATIONS ||--o{ SUPPLIER_PRODUCTS : "links"
    ORGANIZATIONS ||--o{ SUPPLIER_LEAD_TIMES : "tracks"
    ORGANIZATIONS ||--o{ SUPPLIER_PERFORMANCE : "aggregates"

    STORES ||--o{ INVENTORY : "stocks"
    STORES ||--o{ STOCK_MOVEMENTS : "records"
    STORES ||--o{ SALES : "rolls up"
    STORES ||--o{ SALES_ORDERS : "receives"
    STORES ||--o{ PURCHASE_ORDERS : "issues"
    STORES ||--o{ DELIVERIES : "receives"
    STORES ||--o{ STOCK_ADJUSTMENTS : "corrects"

    PRODUCTS ||--o{ INVENTORY : "stocked in"
    PRODUCTS ||--o{ STOCK_MOVEMENTS : "moved"
    PRODUCTS ||--o{ SALES_ORDER_ITEMS : "sold via"
    PRODUCTS ||--o{ PURCHASE_ORDER_ITEMS : "ordered via"
    PRODUCTS ||--o{ SUPPLIER_PRODUCTS : "supplied by"
    PRODUCTS ||--o{ FORECAST_RESULTS : "forecasted"

    SUPPLIERS ||--o{ PURCHASE_ORDERS : "supplies"
    SUPPLIERS ||--o{ DELIVERIES : "delivers"
    SUPPLIERS ||--o{ SUPPLIER_PRODUCTS : "offers"
    SUPPLIERS ||--o{ SUPPLIER_LEAD_TIMES : "measured"
    SUPPLIERS ||--o{ SUPPLIER_PERFORMANCE : "scored"

    PURCHASE_ORDERS ||--o{ PURCHASE_ORDER_ITEMS : "contains"
    PURCHASE_ORDERS ||--o{ DELIVERIES : "fulfilled by"
    PURCHASE_ORDERS ||--o{ SUPPLIER_LEAD_TIMES : "measured by"
    PURCHASE_ORDERS ||--o{ REPLENISHMENT_RECOMMENDATIONS : "sourced from"

    SALES_ORDERS ||--o{ SALES_ORDER_ITEMS : "contains"
    SALES_ORDERS ||--o{ CUSTOMERS : "placed by"

    FORECAST_RUNS ||--o{ FORECAST_RESULTS : "produces"
    FORECAST_RUNS ||--o{ MODEL_METRICS : "evaluates"
    FORECAST_RUNS ||--o{ REPLENISHMENT_RECOMMENDATIONS : "drives"

    RISK_RECORDS ||--o{ ALERTS : "triggers"
    RISK_RECORDS ||--o{ RISK_ASSESSMENTS : "assessed"

    REPLENISHMENT_RECOMMENDATIONS ||--o{ REPLENISHMENT_ITEMS : "details"
    REPLENISHMENT_RECOMMENDATIONS ||--o{ REPLENISHMENT_APPROVALS : "approved by"
    REPLENISHMENT_RECOMMENDATIONS ||--o{ PURCHASE_ORDERS : "creates"
```

## Core Tables (51 tables total)

### Tenant & Identity (7)
| Table | Purpose | Key Constraints |
|-------|---------|-----------------|
| `organizations` | Tenant root | `PRIMARY KEY (id)`, `UNIQUE (slug)`, `FK owner_user_id → users.id` |
| `stores` | Branch/outlet | `PRIMARY KEY (store_id)`, `FK organization_id → organizations.id`, `UNIQUE (org_id, code)`, `UNIQUE (org_id, store_id)` |
| `users` | People | `PRIMARY KEY (id)`, `UNIQUE (email)`, `FK store_id → stores.store_id` |
| `store_members` | Tenant-scoped RBAC | `PK (id)`, `FK (user_id, store_id, role_id, org_id)`, `UNIQUE (store_id, user_id)` |
| `roles` | Permission bundles | `PK (id)`, `FK org_id → organizations.id`, `GENERATED org_scope`, `UNIQUE (org_scope, key_name)` |
| `permissions` | Atomic actions | `PK (id)`, `UNIQUE (key_name)` |
| `role_permissions` | Role→Permission mapping | `PK (role_id, permission_id)` |

### Auth (2)
| Table | Purpose |
|-------|---------|
| `auth_identities` | Firebase UID ↔ MySQL user mapping. `UNIQUE (provider, provider_uid)`, `UNIQUE (user_id, provider)` |
| `otp_codes` | Email OTP for signup/verify |

### Catalogue (3)
| Table | Purpose |
|-------|---------|
| `categories` | Product hierarchy. `PK (id)`, `FK org_id`, `FK parent_id`, `UNIQUE (org_id, name)` |
| `products` | Sellable items. `PK (id)`, `FK org_id`, `FK category_id`, `UNIQUE (org_id, sku)` |
| `warehouses` | Storage locations. `PK (id)`, `FK org_id`, `UNIQUE (org_id, code)` |

### Inventory & Ledger (4)
| Table | Purpose |
|-------|---------|
| `inventory` | Projected stock per store/product. `PK (id)`, `FK (org_id, store_id, product_id, warehouse_id)`, `UNIQUE (store_id, product_id)`, `CHECK (quantity >= 0)` |
| `stock_movements` | **Append-only ledger**. `PK (id)`, `FK (org_id, store_id, product_id, warehouse_id, created_by)`, `direction IN/OUT`, `balance_after`, `reason` |
| `stock_adjustments` | Periodic corrections | `PK (id)`, `FK (org_id, store_id, warehouse_id, posted_by)` |
| `stock_adjustment_items` | Line items for adjustments |

### Suppliers & Procurement (5)
| Table | Purpose |
|-------|---------|
| `suppliers` | Vendor master. `PK (id)`, `FK org_id`, `UNIQUE (org_id, name)` |
| `supplier_products` | What each supplier sells. `PK (id)`, `FK (org_id, supplier_id, product_id)`, `UNIQUE (supplier_id, product_id)` |
| `supplier_lead_times` | PO→delivery timing per product | `PK (id)`, `FK (org_id, supplier_id, product_id, po_id)` |
| `supplier_performance` | Aggregated KPIs per period | `PK (id)`, `FK (org_id, supplier_id)`, `UNIQUE (supplier_id, period_start, period_end)` |
| `purchase_orders` | Buying intent. `PK (id)`, `FK (org_id, store_id, supplier_id, created_by, approved_by)`, `UNIQUE (store_id, po_no)`, `subtotal, tax_total, total_amount` |
| `purchase_order_items` | PO lines. `PK (id)`, `FK (org_id, po_id, product_id)`, `UNIQUE (po_id, product_id)`, `line_total`, `CHECK (quantity > 0)` |
| `deliveries` | Goods receipt. `PK (id)`, `FK (org_id, store_id, supplier_id, po_id, received_by)`, `UNIQUE (store_id, delivery_no)` |
| `delivery_items` | Received quantities per line | `PK (id)`, `FK (org_id, delivery_id, product_id)`, `UNIQUE (delivery_id, product_id)` |

### Sales (3)
| Table | Purpose |
|-------|---------|
| `sales` | Daily rollup per store. `PK (id)`, `FK (org_id, store_id)`, `UNIQUE (store_id, date)`, `sales, profit, units_sold, orders_count` |
| `sales_orders` | Customer orders. `PK (id)`, `FK (org_id, store_id, customer_id, created_by)`, `UNIQUE (store_id, order_no)` |
| `sales_order_items` | Order lines. `PK (id)`, `FK (org_id, so_id, product_id)`, `UNIQUE (so_id, product_id)` |

### Forecasting, Risk & Replenishment (8)
| Table | Purpose |
|-------|---------|
| `forecast_runs` | Batch forecast execution | `PK (id)`, `FK (org_id, store_id, created_by)`, `UNIQUE (org_id, run_key)` |
| `forecast_results` | Per-product predictions | `PK (id)`, `FK (org_id, store_id, product_id, run_id)`, `UNIQUE (run_id, product_id, forecast_date)` |
| `model_metrics` | Accuracy tracking | `PK (id)`, `FK (org_id, store_id, product_id, run_id)`, `UNIQUE (run_id, product_id, model_name)` |
| `risk_records` | Detected anomalies | `PK (id)`, `FK (org_id, store_id, detected_by)`, `UNIQUE (store_id, risk_type, subject_type, subject_id, is_open)` |
| `risk_assessments` | Human review | `PK (id)`, `FK (org_id, risk_id, assessed_by)` |
| `replenishment_recommendations` | Reorder suggestions | `PK (id)`, `FK (org_id, store_id, run_id, po_id, approved_by, generated_by)`, `UNIQUE (org_id, recommendation_no)` |
| `replenishment_items` | Per-product quantities | `PK (id)`, `FK (org_id, store_id, reco_id, product_id, supplier_id)`, `UNIQUE (reco_id, product_id)` |
| `replenishment_approvals` | Multi-step sign-off | `PK (id)`, `FK (org_id, reco_id, approver_user_id)`, `UNIQUE (reco_id, step_no)` |

### Imports & Reporting (6)
| Table | Purpose |
|-------|---------|
| `import_jobs` | Upload→validate→commit workflow | `PK (id)`, `FK (org_id, store_id, started_by)`, `UNIQUE (org_id, job_key)`, `status: pending/ready/committing/completed/failed/invalid` |
| `import_files` | Raw file storage | `PK (id)`, `FK (org_id, job_id)`, `UNIQUE (stored_name)` |
| `import_row_errors` | Per-row validation errors | `PK (id)`, `FK (org_id, job_id)`, `UNIQUE (job_id, row_no, column_name)` |
| `reports` | Report catalogue | `PK (id)`, `UNIQUE (report_key)` |
| `report_runs` | Executed reports | `PK (id)`, `FK (org_id, store_id, report_id, requested_by)` |
| `report_exports` | Generated files | `PK (id)`, `FK (org_id, run_id, downloaded_by)` |

### Platform (3)
| Table | Purpose |
|-------|---------|
| `organization_settings` | Per-org config | `PK (organization_id)`, `FK updated_by` |
| `notifications_preferences` | Per-user alert config | `PK (id)`, `FK (user_id, org_id, store_id)`, `UNIQUE (user_id, org_id, store_id, channel, alert_type)` |
| `schema_migrations` | Version control | `PK (version)`, `checksum, applied_at, duration_ms` |

## Key Design Invariants

### 1. Organization-Store-User Triangle
```
organizations (1) ───< stores (N)
stores (1) ───< store_members (N) >─── (N) users
organizations (1) ───< users (N)  -- via users.store_id → stores.store_id
```
Every business row carries `organization_id` + `store_id` FK to `stores(store_id, organization_id)`. 42 business tables are organization-scoped.

### 2. Inventory Ledger Consistency
- `stock_movements` is **append-only truth**; `direction IN/OUT`, `balance_after` recorded per movement
- `inventory.quantity` = locked projection `SUM(CASE WHEN direction='IN' THEN qty ELSE -qty END)`
- `stock.js` is **sole writer**; all IN/OUT/opening go through `postMovement()` / `openStock()` with row-level `FOR UPDATE`
- `CHECK (quantity >= 0)` on `inventory`; `CHECK (quantity > 0)` on `stock_movements`

### 3. Tenant Isolation
- Composite FK `(organization_id, store_id)` on every business table → `stores(store_id, organization_id)`
- Middleware `requireStore` rejects any request where `req.body.storeId` / `req.query.storeId` ≠ `req.user.store_id` (403)
- All data endpoints require `storeId` query/body; token encodes `store_id`
- Frontend auto-attaches matching `storeId`

### 4. Firebase Authentication Flow
```
Frontend (Google/Microsoft) → Firebase OAuth → ID Token → /api/auth/firebase
  → verifyFirebaseIdToken() → email_verified required to claim existing account
  → auth_identities (provider, provider_uid, user_id) with UNIQUE constraints
  → JWT issued with { sub, email, storeId, provider }
```
- **Email/password**: bcrypt in `users.password`, provider=`email`
- **Firebase OAuth**: maps `firebase_uid` → `users` via `auth_identities`
- **Unverified provider email cannot claim existing email account**
- **Password accounts never relabelled** to Firebase

### 5. CSV Import Workflow
1. `POST /api/imports/validate` → parses CSV, runs per-row validators (FK lookups, stock availability for OUT/sales, money checks), returns `{ job_id, valid, errors[], warnings[], preview[] }`
2. User reviews errors/warnings in UI
3. `POST /api/imports/:id/commit` → re-reads **only validated preview rows**, executes in single transaction:
   - Products upsert (SKU unique per org)
   - Suppliers upsert (name unique per org)
   - Opening stock → `stock.openStock()` (writes ledger + inventory)
   - Stock movements → `stock.postMovement()` (IN/OUT with reasons, ledger + inventory)
   - Sales → ledger OUT (reason `sale`) + daily rollup `sales` table
   - POs → header + lines (repeated `po_no` adds lines; totals recomputed from lines)
4. Job status: `pending → ready → committing → completed` or `failed`

### 6. PO → Delivery → Inventory Flow
1. `POST /api/purchase-orders` creates header + lines (idempotent on `po_no`)
2. `POST /api/purchase-orders/:id/receive`:
   - Locks `purchase_orders` row
   - For each line: updates `received_qty`, writes `delivery_items`, posts `stock_movements` IN, updates `inventory`
   - Updates `supplier_lead_times` (actual vs promised days)
   - Recomputes PO status (`part_received` / `received`)
   - Idempotent: re-receiving same line is no-op

## Migration & Seed Commands

```bash
# Migration management
npm run db:status      # Show applied/pending migrations
npm run db:migrate     # Apply pending migrations
npm run db:rollback    # Rollback last migration (guarded if data exists)
npm run db:fresh       # Drop DB, reapply all migrations (requires typed confirmation)

# Seeding
npm run db:seed        # Idempotent canonical demo tenant (demo-grocery)

# Verification
npm run db:verify      # Schema structure (155 FKs, 41 uniques, 42 org-scoped tables)
npm run db:check       # Data integrity (ledger=inventory, org-store, PO totals, etc.)
npm run db:test        # Negative constraint tests (cross-tenant FK, dup roles, negative qty)

# Auth
npm run migrate:passwords  # One-time bcrypt migration for legacy plaintext passwords
```

## Test Commands

```bash
# All tests (requires server running on port 4000)
npm run test:api       # 28 API integration tests (requires TEST_PORT=4000)
npm run test:csv       # 21 CSV parser unit tests
npm test               # Runs api.test.js (alias for test:api)

# Database verification
npm run db:verify      # Schema structure
npm run db:check       # Data integrity
npm run db:test        # Negative constraint tests
```

## Starting the Application

```bash
# Terminal 1: Start MySQL (if not running as service)
# Ensure .env has DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME

# Terminal 2: Backend API (port 4000)
cd backend
npm start
# or for development with auto-reload
npm run dev

# Terminal 3: Frontend (port 3000)
cd frontend
# Serve static files (e.g., npx serve, or any static server)

# Run tests (in separate terminal, backend must be running)
cd backend
npm run test:api       # 28 integration tests
npm run test:csv       # 21 unit tests
```

## Environment Variables (backend/.env)

```env
# Database
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_secure_password
DB_NAME=supplyiq

# JWT
JWT_SECRET=your_256_bit_secret
JWT_EXPIRES_IN=24h

# Firebase (for OAuth only)
FIREBASE_PROJECT_ID=your_project_id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk@your_project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

# Email (for OTP)
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your_smtp_user
SMTP_PASS=your_smtp_pass
OTP_FROM="SupplyIQ <noreply@supplyiq.example>"

# Frontend URL (for CORS)
FRONTEND_ORIGIN=http://localhost:3000
```

## CSV Template Reference

### Products (`csv/templates/products.csv`)
```
sku,name,category,unit,pack_size,barcode,tax_rate,default_unit_cost,default_sell_price,shelf_life_days
```

### Opening Stock (`csv/templates/stock_levels.csv`)
```
sku,warehouse_code,quantity,unit_cost,reorder_pt,safety_stock,max_stock,monthly_demand,last_counted_at,note
```

### Stock Movements (`csv/templates/stock_movements.csv`)
```
sku,direction,quantity,unit_cost,reason,occurred_at,reference_type,reference_id,note
```

### Sales (`csv/templates/sales.csv`)
```
date,sku,quantity,unit_price,discount,channel,notes
```

### Suppliers (`csv/templates/suppliers.csv`)
```
name,contact_person,phone,email,gstin,address_line,city,state,pincode,payment_terms,rating,is_active,notes
```

### Purchase Orders (`csv/templates/purchase_orders.csv`)
```
po_no,supplier,order_date,expected_date,status,payment_terms,source,item_sku,item_quantity,item_unit_cost,item_tax_rate,notes
```
*Repeat `po_no` to add multiple lines to the same order. Header totals are recomputed from lines.*