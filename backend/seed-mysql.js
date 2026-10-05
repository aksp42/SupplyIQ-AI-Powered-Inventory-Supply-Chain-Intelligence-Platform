// MOVED — this script is superseded and no longer runs.
//
// It seeded three separate demo stores (grocery-01, hardware-01, stationery-01)
// with one hardcoded organization each and wrote to the old `orders` table. That
// table no longer exists, and `inventory` now requires organization_id, so this
// script could only ever fail against the current schema.
//
// The single canonical sample dataset lives here instead:
//
//     node backend/scripts/seed-sample.js
//
// It creates one organization / store / owner, and populates suppliers,
// products, the opening stock ledger, 30 days of sales, and purchase orders in a
// realistic spread of statuses. Run `node backend/scripts/verify-sample.js`
// afterwards to confirm the ledger and tenant boundaries are consistent.
//
// See also:
//   backend/scripts/migrate.js         schema migrations
//   backend/scripts/verify-schema.js    database shape
//   backend/scripts/verify-sample.js    data integrity