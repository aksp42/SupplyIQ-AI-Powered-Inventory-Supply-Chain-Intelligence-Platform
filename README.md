# SupplyIQ — AI Supply Chain Intelligence

> Multi-tenant inventory dashboard for small retail stores. Live MySQL data, Stock IN/OUT,
> purchase orders, a TradeSaarthi assistant, and a supplier delay predictor.
> Auth is JWT-based: passwords are bcrypt-hashed and every data endpoint is scoped to one store.

---

## 🚀 Quick Start

### Option 1 — Double-click

```
start.bat   ← double-click this!
```

It checks Node.js, installs backend dependencies on first run, starts the API
(`port 4000`) and the static server (`port 3000`), then opens
`http://localhost:3000/public/landing.html`.

> Requires a running MySQL server. `start.bat` does **not** start MySQL — see setup below.

### Option 2 — Docker (MySQL included)

```bash
# JWT_SECRET is required; everything else has a default
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))") docker compose up --build
```

| Service | URL |
|---------|-----|
| Frontend | http://localhost |
| Backend API | http://localhost:4000 |

### Option 3 — Manual

```bash
# 1. Database
mysql -u root -p supplyiq < backend/supplyiq_schema.sql

# 2. Backend
cd backend
npm install
cp .env.example .env        # then fill in DB_* and generate JWT_SECRET
node seed-mysql.js          # inventory + sales + orders
node scripts/seed-sample.js # organisation, store and demo owner
node server.js

# 3. Frontend (separate terminal)
cd frontend && node serve.js
```

Generate a JWT secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

## 🔑 Demo Account

There is exactly one seeded account. It is created by
`node backend/scripts/seed-sample.js`, which provisions the organisation, the
store and the owner together so the foreign keys are satisfied by construction.

| Field | Value |
|-------|-------|
| Email | `demo@supplyiq.local` (`DEMO_EMAIL`) |
| Store | `demo-store-01` (`DEMO_STORE_ID`) |
| Password | **whatever you set in `DEMO_PASSWORD`** |

The password is not in this repository and there is no default. Set
`DEMO_PASSWORD` in `backend/.env` before seeding:

```bash
DEMO_PASSWORD=$(node -e "console.log(require('crypto').randomBytes(12).toString('base64url'))")
```

`scripts/seed-sample.js` refuses to run without it rather than falling back to a
literal — a default would be a working credential in every clone of this repo.

> Earlier revisions of this README listed three demo accounts against store ids
> `grocery-01`, `hardware-01` and `stationery-01`. Those were created by
> `backend/seed-users.js`, which is now a tombstone: the normalised schema no
> longer contains those stores, so every insert it made would fail on a foreign
> key. See the comment in that file.

---

## 🗂️ Project Structure

```
.
├── backend/
│   ├── server.js                     ← Express app: all routes
│   ├── auth.js                       ← bcrypt hashing, JWT, requireAuth/requireStore
│   ├── mysql.js                      ← MySQL connection pool
│   ├── supplyiq_schema.sql           ← tables (passwords NOT seeded here)
│   ├── seed-mysql.js                 ← inventory / sales / orders data
│   ├── seed-users.js                 ← demo accounts, hashed
│   ├── migrate-password-hashes.js    ← one-time plaintext → bcrypt migration
│   └── tests/api.test.js             ← 120 API tests
│
├── frontend/
│   ├── SupplyIQ-Grocery-Dashboard.html   ← main dashboard
│   ├── SupplyShield-AI.html              ← supplier delay predictor
│   ├── serve.js                          ← static server (port 3000)
│   ├── public/                           ← landing / login / signup (live copies)
│   └── css/, js/
│
├── .github/workflows/ci.yml          ← GitHub Actions
├── docker-compose.yml                ← MySQL + backend + nginx
└── start.bat
```

---

## 🔒 Authentication

| Concern | How it works |
|---------|--------------|
| Password storage | bcrypt hash (cost 10) in `users.password` — never plaintext |
| Session token | JWT HS256, signed with `JWT_SECRET`, 7-day expiry |
| Claims | `sub`, `email`, `storeId`, `provider` |
| Transport | `Authorization: Bearer <token>` on every data request |
| Tenant isolation | `storeId` is read from the **token**, not the request. A mismatch returns `403` |
| User enumeration | Wrong email and wrong password return the same `401` message |
| Brute force | Login throttled to 8 attempts per email+IP per 15 minutes |
| Google / Microsoft | Frontend sends a Firebase ID token; the backend verifies it before issuing a JWT |
| Password reuse | A hash made with weaker rounds is upgraded to the current cost on next login |

The frontend keeps the JWT in `localStorage` under `siq_session` and redirects to
`public/login.html` on any `401`.

> Tokens in `localStorage` are readable by any script on the page. That is the usual
> trade-off for a no-build SPA; an httpOnly cookie is stricter if you need it.

---

## 🔌 API Endpoints

### Auth (public)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Liveness check |
| POST | `/api/login` | Email + password → JWT |
| POST | `/api/signup` | Create account → JWT |
| POST | `/api/auth/firebase` | Exchange a Firebase ID token → JWT |
| GET | `/api/me` | Current user (requires token) |

Password reset is not an API route. The login page calls Firebase's
`sendPasswordResetEmail` directly, so the backend never handles mail.

### Data (require `Authorization: Bearer <token>`)

All of these also require `storeId` matching the token's store.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/stores` | The caller's store |
| GET | `/api/stores/:storeId` | One store |
| GET | `/api/kpis` | Dashboard KPI summary |
| GET | `/api/sales?period=1D\|1W\|15D\|1M` | Sales series |
| GET | `/api/inventory` | Inventory with `status` / `category` / `search` filters |
| POST | `/api/stock/in` | Record stock received |
| POST | `/api/stock/out` | Record stock sold |
| GET | `/api/stock/transactions` | Last 50 movements |
| GET | `/api/orders` | Purchase orders |
| POST | `/api/orders` | Create purchase order |
| POST | `/api/orders/:order_no/receive` | Mark received (auto-increments stock) |
| POST | `/api/chat` | TradeSaarthi assistant |
| POST | `/api/dev/reseed` | Instructions for reseeding |

---

## 🧪 Tests

```bash
cd backend
npm start          # terminal 1
npm test           # terminal 2
```

Expected: **120/120 ✅** — including tenant-isolation and token-tampering checks.

---

## 🔁 GitHub Actions

| Job | What it does |
|-----|--------------|
| `backend-test` | Starts MySQL 8 service, loads the schema, seeds, runs the 120 tests |
| `validate-frontend` | Checks pages exist and the frontend sends `Authorization` headers |
| `no-committed-secrets` | Fails if `.env`, a service-account key, or a plaintext seed is committed |
| `docker-build` | Builds the backend image |

---

## 🛠 Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla HTML + CSS + JS, ECharts 5.4.3, Three.js r128, Firebase JS SDK 10.13.0 |
| Backend | Node.js 20, Express 4 |
| Database | MySQL 8 via `mysql2` |
| Auth | `bcryptjs` + `jsonwebtoken`, Firebase for Google/Microsoft and password reset |
| Container | Docker, nginx |
| CI/CD | GitHub Actions |

---

## ⚠️ Before deploying

- [ ] Set a real `JWT_SECRET` (never the default)
- [ ] Restrict CORS — `app.use(cors())` currently allows every origin
- [ ] Serve over HTTPS, otherwise JWTs travel in cleartext
- [ ] Rate-limit at the reverse proxy as well as in-process
- [ ] Remove `frontend/Login_Authentication/` — a vendored copy of the auth pages that
      talks straight to Firebase and bypasses this backend
