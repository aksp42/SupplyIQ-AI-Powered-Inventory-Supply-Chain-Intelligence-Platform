/**
 * MOVED — this script is superseded and no longer runs.
 *
 * It created three accounts in Firebase Auth + Firestore and mapped them to the
 * store ids grocery-01, hardware-01 and stationery-01. Those stores do not exist
 * in the normalised schema, and `users.store_id` now has a real foreign key, so
 * the MySQL half of this script could only fail.
 *
 * Two design changes also make the old approach wrong rather than merely broken:
 *
 *   1. Firebase is now authentication-only. No business rows live in Firestore —
 *      MySQL is the single source of truth, and the app links a provider account
 *      to a MySQL user through the `auth_identities` table at the moment the
 *      person signs in.
 *   2. A workspace is provisioned per account by POST /api/signup (or by
 *      POST /api/auth/firebase on a first Google/Microsoft sign-in), so there is
 *      nothing left for an offline script to pre-create.
 *
 * To create a real account, just sign up through the app. To load the one demo
 * tenant locally:
 *
 *     node backend/scripts/seed-sample.js
 */