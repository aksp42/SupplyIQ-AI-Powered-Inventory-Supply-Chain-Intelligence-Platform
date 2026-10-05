# Stock Management

Everything that moves stock: Add Stock, Stock Out, manual adjustments, CSV import,
the movement ledger, and the inventory projection it writes to.

This complements `../ARCHITECTURE.md`, which covers the schema. This document
covers the invariants and the reasons behind them.

## The one rule

**All stock changes go through `postMovement()` in `backend/stock.js`.**

```
postMovement({ storeId, organizationId, productId, direction, quantity,
               reason, unitCost?, invoiceNo?, note?, userId?,
               referenceType?, referenceId?, occurredAt?, tx? })
```

There is no second path. Sales, Stock Out, CSV import, PO receipt and adjustments
all call it. It writes the `stock_movements` row **and** updates the `inventory`
projection in the same transaction, so the ledger and the projection can never
disagree.

A consequence worth stating plainly: a bug that bypassed this function would
desynchronise stock on hand from the ledger, and there is no reconciliation job
to hide behind. If you add a way to change stock, call this.

## Inventory projection vs ledger

- `stock_movements` — append-only. Every movement ever, with direction, quantity,
  reason, unit cost, invoice, who did it and when. This is the audit trail.
- `inventory` — one row per SKU per store, holding the current quantity and value.
  This is what the dashboard reads.

Read from the projection, write through the ledger.

## Status is derived, not stored

`computeStatus(qty, reorderPt, maxStock)` in `stock.js` is the single definition:

| Condition | Status |
|---|---|
| `qty <= 0` | Critical |
| `reorderPt > 0` and `qty < reorderPt * 0.3` | Critical |
| `reorderPt > 0` and `qty < reorderPt` | Low |
| `maxStock > 0` and `qty > maxStock` | Overstock |
| `maxStock > 0` and `qty > reorderPt * 8` | Overstock |
| otherwise | OK |

The dashboard buckets `Critical` and `Low` into "Low Stock" for its counter. It
never invents a status of its own, so a status shown in the UI always has a
server-side definition behind it.

## Reasons are constrained by direction

```js
REASONS.IN  = ['purchase', 'return', 'opening', 'import', 'adjustment']
REASONS.OUT = ['sale', 'damage', 'expiry', 'lost', 'transfer', 'adjustment']
```

`postMovement` rejects a reason that is not valid for the direction. This is what
stops `direction: 'IN'` carrying `reason: 'sale'` and quietly inflating stock.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/inventory` | current projection for the dashboard |
| `POST` | `/api/products` | create a product, optionally with opening stock |
| `POST` | `/api/stock/in` | receive stock |
| `POST` | `/api/stock/out` | record a deduction (Sales, Stock Out) |
| `GET` | `/api/stock/out` | OUT movement history |
| `GET` | `/api/stock/transactions` | full ledger for a SKU |

### `POST /api/stock/out` takes a SKU, not a name

This is the detail the dashboard got wrong once. The API identifies a product by
`sku`. The Stock Out form's product field is a **name**, and `S.prod` in the
frontend is keyed by product name with the SKU only in the value object. Posting
the field value directly sent a product *name* where the API wanted a SKU, and
the deduction silently matched nothing.

The form now resolves the typed name to its entry and posts `item.sku`. The live
browser test asserts the SKU is present and that over-deduction is refused with
`Insufficient stock. Available quantity: N`.

### `POST /api/stock/out` accepts optional `date` and `invoiceNo`

Both are stored as data in `stock_movements.invoice_no` rather than folded into
the free-text note, which keeps the invoice searchable. `invoice_no` is nullable
and was added in migration `006`; `006_down.sql` reverses it.

Keep `apiStockOut(sku, qty, note)` → `stock.out(sku, qty, note)` working as-is.
That is the Sales path and its behaviour is unchanged.

## Transactions and nesting

`postMovement` starts its own transaction unless the caller passes `tx`. Callers
that write several documents at once — PO receipt, workspace provisioning — pass
their executor so the whole unit commits or rolls back together.

Opening a second transaction inside an outer one deadlocks against the rows the
outer transaction already holds. If you are batching writes, pass `tx`.

## CSV import

Six types, each validated as a job and only then committed:

| Type | What it carries |
|---|---|
| `products` | SKU, name, category, unit costs |
| `stock_levels` | opening quantities |
| `stock_movements` | IN/OUT ledger entries |
| `suppliers` | supplier records |
| `purchase_orders` | inbound stock |
| `sales` | outbound stock and revenue |

The workflow is validate → review → commit, and commit is atomic:

- validation reports row-level errors with line, value and reason;
- a partly-good file may still be committed, and the skipped rows are listed
  individually — bad rows are skipped, not silently dropped;
- a file with nothing valid offers no commit button at all;
- committing an already-committed job is refused;
- if a commit fails part-way, **every** row rolls back and the job is marked
  failed.

Imports write through `postMovement`, so imported stock is indistinguishable from
manually entered stock in the ledger.

## CSV templates

Downloadable from the dashboard and reproducible from the repo:

```bash
cd backend && node scripts/generate-ledger-template.js
```

Templates live in `backend/csv/templates/`.

## Verifying this area

```bash
npm run test:ledger   # stock ledger arithmetic and movement rules
npm run test:csv      # every import type: validate, commit, rollback
npm run test:full     # adds the dashboard and browser suites
```

`tests/ledger.test.js` is the one that will catch an arithmetic regression —
running balances, reason validity, and the refusal to over-deduct.

## Environment

None. Stock operations take no configuration; `MAX_IMPORT_BYTES` (12 MB default)
caps CSV uploads.

## Reviewer notes

- Any new stock write must go through `postMovement`.
- Any new status must be added to `computeStatus`, not computed in the UI.
- If you change the Stock Out contract, update `tests/ledger.test.js` and the
  over-deduction assertion in `frontend/test_dashboard_boot.js` in the same
  change — those two are what stop the SKU/name mix-up returning.
