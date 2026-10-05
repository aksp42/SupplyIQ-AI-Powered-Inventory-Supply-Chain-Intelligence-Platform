// MOVED — this script is superseded and no longer runs.
//
// It created three hardcoded demo accounts pointing at store ids
// (grocery-01, hardware-01, stationery-01) that the normalised schema no longer
// contains. Since `users.store_id` now has a real foreign key to `stores`, every
// insert here would fail with an FK error, and re-running it would also silently
// repoint those accounts at a store that belongs to somebody else.
//
// The single canonical sample owner is created by:
//
//     node backend/scripts/seed-sample.js
//
// which creates the organization, store and owner together, so the FKs are
// satisfied by construction. Real users are created by POST /api/signup, which
// provisions a personal workspace per account.