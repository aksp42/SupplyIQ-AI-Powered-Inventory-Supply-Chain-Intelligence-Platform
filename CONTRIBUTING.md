# Working on SupplyIQ

Practical notes: getting it running, running the tests, and the conventions the
codebase actually follows.

## Requirements

- Node.js 18+ (developed on 24)
- MySQL 8
- Chrome or Chromium — two suites drive it headlessly

## First run

```bash
# 1. environment
cd backend
cp .env.example .env        # then fill in the values

# 2. schema
npm run db:migrate
npm run db:seed             # creates the demo store and its owner account

# 3. backend — port 4000
npm start

# 4. frontend — port 3000, in a second terminal
cd frontend && npm start
```

`backend/.env` holds every real credential and is git-ignored. Never commit it.
`backend/.env.example` documents all 43 variables the backend and ML service
read, with safe placeholders only.

## Running the tests

```bash
cd backend

npm run test:full     # everything — use this before a push
npm run test:all      # fast inner loop (server required)
npm run test:ui       # no server needed
```

`test:full` includes two headless-Chrome suites and takes roughly 30 seconds
longer than `test:all`. That is deliberate: they are the only suites that catch a
dashboard which parses but renders nothing. See
[`docs/features/test-strategy.md`](docs/features/test-strategy.md).

The backend suites expect a running API on port 4000 (`TEST_PORT`). The dashboard
boot test starts the frontend and backend itself if nothing is listening.

## Repository layout

```
backend/
  server.js              HTTP API
  auth.js  otp.js        sessions, OTP
  mysql.js               pool and transaction helpers
  stock.js               the single stock-movement writer
  forecast.js            statistical demand baseline
  imports.js  csv.js     bulk import pipeline
  migrations/            numbered SQL, with rollback/
  tests/                 api, ledger, csv
  ml/                    Python forecasting service
frontend/
  SupplyIQ-Grocery-Dashboard.html   the dashboard
  js/api.js              frontend API client
  test_*.js              render, browser and boot suites
docs/
  ARCHITECTURE.md        schema and system overview
  features/              per-subsystem documentation
```

## Conventions

- **Comments explain why, not what.** The codebase is sparse on narration and
  dense on rationale — if a line looks odd, there is usually a comment above it
  recording the mistake that made it necessary. Keep that up.
- **Secrets come from the environment.** No `process.env.X || 'literal'`
  fallback, ever. That pattern looks harmless in review and behaves as a working
  credential wherever the variable is missing; CI fails the build on it.
- **Stock writes go through `postMovement()`** in `backend/stock.js`. See
  [`docs/features/stock-management.md`](docs/features/stock-management.md).
- **Tenant isolation is checked per request** by `requireStore`, not trusted from
  the token.
- **Tests live next to what they test**: `backend/tests/` for the API,
  `frontend/test_*.js` for the dashboard.

## Adding a change

1. Branch: `feature/<area>` off `main`.
2. Keep the tests passing — `npm run test:full` must be green before you push.
3. If you change a contract, update the test that guards it in the same commit.
4. If you get something wrong in a way that is not obvious from the code, leave a
   comment recording it. The next person will thank you.

## Before your first push

```bash
git status                 # nothing unexpected staged
npm run test:full          # green
```

CI runs a secret scan on every push. It matches the *shape* of a credential, never
a specific value, so it stays useful after rotation. The documented exclusions are
`backend/.env` (by name), the workflow file itself, `README.md` and `docs/` (the
demo seed password is documented there on purpose), and `firebase-config.js`
(Firebase web config is public by design).

If the scan fails, do not add the value to an exclusion list — an earlier version
of this workflow did exactly that and committed the very secrets it existed to
block. Move the value into `backend/.env` instead.
