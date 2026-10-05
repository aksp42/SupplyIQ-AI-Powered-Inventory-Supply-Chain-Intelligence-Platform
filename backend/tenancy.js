/**
 * tenancy.js — store → organisation resolution and RBAC checks.
 *
 * The tenant boundary is `organizations.id`. Every business row carries it, but
 * a request only arrives knowing `store_id` (from the verified JWT), so the
 * organisation has to be resolved once and then passed into every query.
 *
 * Nothing here reads the tenant from client input. `requireStore` in auth.js has
 * already rejected any storeId that is not the caller's own, so storeId is
 * trusted only because it came out of the token.
 */
const { query, queryOne } = require('./mysql');

async function storeContext(storeId) {
  const store = await queryOne(
    'SELECT store_id, organization_id, name, currency, timezone, theme, owner_name, owner_initials, type ' +
    'FROM stores WHERE store_id = ? AND is_active = 1', [storeId]);
  if (!store) return null;
  const organization = await queryOne(
    'SELECT id, slug, name, business_type, currency, timezone FROM organizations WHERE id = ?',
    [store.ORGANIZATION_ID || store.organization_id]);
  return { store, organization, organizationId: store.ORGANIZATION_ID || store.organization_id };
}

/** Permission keys granted to a user in a store, via their store_members role. */
async function permissionsFor(userId, storeId) {
  const rows = await query(
    `SELECT DISTINCT p.key_name
       FROM store_members m
       JOIN roles r            ON r.id = m.role_id
       JOIN role_permissions rp ON rp.role_id = r.id
       JOIN permissions p      ON p.id = rp.permission_id
      WHERE m.user_id = ? AND m.store_id = ? AND m.is_active = 1`, [userId, storeId]);
  return rows.map(r => r.key_name || r.KEY_NAME);
}

/** Membership rows for a user — used by the "my businesses" screen. */
async function membershipsFor(userId) {
  return query(
    `SELECT m.store_id, m.role_id, r.key_name AS role, s.name AS store_name,
            s.organization_id, o.name AS organization_name, o.business_type
       FROM store_members m
       JOIN stores s        ON s.store_id = m.store_id
       JOIN organizations o ON o.id = s.organization_id
       JOIN roles r         ON r.id = m.role_id
      WHERE m.user_id = ? AND m.is_active = 1 AND s.is_active = 1`, [userId]);
}

module.exports = { storeContext, permissionsFor, membershipsFor };