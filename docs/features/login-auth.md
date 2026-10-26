# Authentication & Access Control

How a caller becomes an authenticated, authorised SupplyIQ user — email/password,
Google, Microsoft, emailed OTP, JWT sessions, and the RBAC layer that decides what
a signed-in account may do.

This complements `../ARCHITECTURE.md`, which covers the schema and the
organization → store → user triangle. This document covers the request flow and
the operational rules.

## Sign-in methods

Four flows converge on one session shape, so the frontend never has to care which
door the user came through:

| Flow | Endpoint | Proves identity with |
|---|---|---|
| Email + password | `POST /api/login` | bcrypt hash comparison |
| New account | `POST /api/signup` | emailed OTP, then a password is set |
| Google | `POST /api/auth/firebase` | Firebase ID token → `identitytoolkit` lookup |
| Microsoft | `POST /api/auth/firebase` | same endpoint; provider is read from the token |
| Password reset | `POST /api/password/reset` | emailed OTP, then a new password |

All of them answer with the **same payload** (`sessionPayload()` in
`backend/auth.js`):

```js
{ success, token, storeId, storeName, userName, ownerName, email, theme }
```

`userName` and `ownerName` are deliberately different fields. A staff account's
`userName` is the person signed in; `ownerName` is who the store belongs to. The
dashboard needs both, and collapsing them into one field was a source of
confusion in earlier versions.

The browser stores this as `siq_session` in `localStorage`. Every subsequent call
sends `Authorization: Bearer <token>`.

## Passwords

- Hashed with **bcrypt** (`bcryptjs`), cost factor from `BCRYNC_ROUNDS`
  (`BCRYPT_ROUNDS` in `.env`, default 10).
- `auth.js` also exposes `needsRehash()`, so a successful login transparently
  upgrades an old-cost hash.
- A plaintext password is never stored. CI fails the build if one appears in the
  schema or seed files.

## Emailed OTP

Signup verification and password reset both use a six-digit code, which is why
SupplyIQ has its own OTP layer rather than delegating either flow to Firebase.

- Codes are **never stored in plaintext**. They are stored as
  `HMAC-SHA256(email + ":" + code, PEPPER)` and compared in constant time.
- The pepper is `OTP_PEPPER`, falling back to `JWT_SECRET`. Changing it
  invalidates every code that is currently outstanding — this is deliberate.
- Guards against brute force: `OTP_TTL_MINUTES` (10), `OTP_MAX_ATTEMPTS` (5),
  `OTP_RESEND_COOLDOWN_SECONDS` (60), `OTP_MAX_SENDS_PER_HOUR` (5).
- `/api/otp/send` answers **identically whether or not the address exists**, so
  the endpoint cannot be used to enumerate registered users.
- With `SMTP_HOST` unset and `NODE_ENV !== 'production'`, the code is returned as
  `devCode` so the flow stays testable without a mail server. In production it is
  logged and emailed only.

## Tokens

- Signed with `JWT_SECRET` via `jsonwebtoken`, lifetime `JWT_EXPIRES_IN` (7d).
- The token carries the **user id**. The store is *not* trusted from the token:
  it comes from a `storeId` query parameter and is validated against the token by
  `requireStore` on every data route. A caller cannot read another store's data by
  editing the URL.

`auth.js` exposes two distinct guards, and the difference matters:

| Guard | Enforces |
|---|---|
| `requireAuth` | a valid token; populates `req.user` |
| `requireStore` | `requireAuth` **plus** the store actually belongs to this user |

## RBAC

Permissions are not stored on the user. They are resolved through the membership
row, so removing someone from a team immediately removes their access.

```
user → store_members → roles → role_permissions → permissions
```

- `store_members` is the single source of truth. An account with no membership row
  signs in successfully and then **cannot read a single endpoint** — that is the
  intended behaviour, not a bug.
- Permission keys are namespaced by domain: `inventory.view`, `po.approve`,
  `forecast.run`, `imports.run`, `risk.resolve`, `org.edit`, and so on
  (`backend/migrations/002_reference_data.sql`).
- Three system roles ship by default:
  - `owner` — everything, including billing, team and approvals
  - `manager` — daily operations, approves purchase orders
  - `staff` — receives stock, records sales, no approvals
- `GET /api/me/permissions` returns the resolved set so the UI can hide what the
  user cannot do. It is a convenience for rendering, **not** the enforcement
  point — every mutating route is checked server-side.

## Signup creates the whole workspace

`provisionWorkspaceForUser()` runs one transaction that creates the organization,
the store, the account, the owner role grant, notification preferences and the
default warehouse. If any part fails, nothing is left behind, so a retry starts
clean.

A new workspace is created **empty**. It used to be seeded with a starter
catalogue, which was wrong for a genuine new user: their dashboard showed a
grocery shop's stock before they had entered anything, and the seeded SKUs
collided with the ones in the ledger template, so importing the template renamed
existing products and desynchronised the inventory copy. Development runs that
want the sample catalogue can set `SEED_NEW_WORKSPACES=1`.

## Rate limiting

Every authentication endpoint is wrapped in `throttleLogin`, which counts
**failed** attempts keyed by email and IP. Successful logins are not throttled, so
an active user is never locked out by their own legitimate traffic.

## Verifying this area

```bash
# unit / integration coverage for sign-in, sessions and store scoping
npm run test:api

# the whole suite, including the browser and dashboard boot tests
npm run test:full
```

`tests/api.test.js` covers: anonymous access is refused, the demo owner signs in,
a wrong password is refused, `GET /api/me` returns the caller, store-scoped calls
reject a store the token does not own, and imports cannot be read across stores.

## Environment variables

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | token signing key — changing it signs everyone out |
| `JWT_EXPIRES_IN` | token lifetime (`30m`, `24h`, `7d`) |
| `BCRYPT_ROUNDS` | bcrypt cost factor |
| `OTP_PEPPER` | pepper for OTP digests |
| `OTP_TTL_MINUTES` | code lifetime |
| `OTP_MAX_ATTEMPTS` | attempts before a code is dead |
| `OTP_RESEND_COOLDOWN_SECONDS` | minimum gap between sends |
| `OTP_MAX_SENDS_PER_HOUR` | hourly send cap |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | OTP mail |
| `FIREBASE_API_KEY` | public web API key, used to verify Google/Microsoft ID tokens |

None of these belong in source control. Copy `backend/.env.example` to
`backend/.env` and fill them in; `.env` is git-ignored.

## Security notes for reviewers

- A `process.env.X || 'literal'` fallback is how a real password ends up
  committed: it looks like a harmless default in review and behaves as a working
  credential everywhere the variable is missing. There was a live instance of this
  in `mysql.js`. CI now fails on any secret-shaped fallback.
- The one credential-shaped value that *is* in tracked files is the demo seed
  account's password, used by the seeder, the tests and the README. It is a
  documented development credential, not a real secret, and CI excludes it by
  name. Rotate it before exposing any seeded environment publicly.
