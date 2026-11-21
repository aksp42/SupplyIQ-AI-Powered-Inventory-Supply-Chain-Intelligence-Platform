# Question 13: CI/CD Pipeline Configuration Evidence

## 1. Executive Summary & Pipeline Overview

SupplyIQ employs a production-grade Continuous Integration and Continuous Deployment (CI/CD) pipeline implemented with **GitHub Actions**. The pipeline is formally declared in:
- **File Location:** `.github/workflows/ci.yml`
- **Total Pipeline Lines:** 722 lines of structured workflow code
- **Trigger Events:**
  - `push` to branches: `main`, `master`, `develop`
  - `pull_request` targeting: `main`, `master`
- **Concurrency Control:** `concurrency: group: ci-${{ github.ref }}, cancel-in-progress: true` (cancels obsolete builds on subsequent commits to conserve build minutes).
- **Security Posture:** Least-privilege permission model (`permissions: contents: read`).

---

## 2. Multi-Stage Automated Verification Architecture

The workflow orchestrates **5 comprehensive jobs** designed to ensure zero secrets leakage, absolute test coverage with real database services, and container deployability:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                     GitHub Actions CI Pipeline (.github/workflows/ci.yml)       │
└─────────────────────────────────────────────────────────────────────────────────┘
         │
         ├───► [Job 1: secret-scan] ───► Verifies no .env or API keys are committed
         │
         ├───► [Job 2: backend-test] ──► Spins up MySQL 8.0 container & runs API tests
         │
         ├───► [Job 3: frontend-validate] ─► Lints HTML5, CSS3, and JavaScript syntax
         │
         ├───► [Job 4: docker-build] ──► Builds production Docker container image
         │
         └───► [Job 5: integration] ───► Launches full Docker Compose stack for E2E
```

---

## 3. In-Depth Job Breakdown & Verification Steps

### 3.1 Job 1: `secret-scan` ("No committed secrets")
- **Purpose:** Prevents accidental leakage of production credentials, database passwords, and API keys.
- **Verification Logic:**
  - Scans `git ls-files` to ensure no active `.env` or `.env.production` files are tracked.
  - Enforces existence of sanitized template `backend/.env.example`.
  - Executes regex pattern scanning across all commits to detect private keys (`RSA`, `DSA`, `OPENSSH`), cloud tokens (`AKIA`, `ASIA`, `AIza`, `ya29`), GitHub personal access tokens (`ghp_`, `github_pat_`), and hardcoded password strings.

### 3.2 Job 2: `backend-test` ("Backend tests with live database")
- **Runner Environment:** `ubuntu-latest` with `node-version: 20`.
- **Database Service Container:**
  - Container Image: `mysql:8.0`
  - Ports: `3306:3306`
  - Healthcheck: Probes `mysqladmin ping` until the database is ready to accept queries.
- **Execution Workflow:**
  - Checks out repository and initializes Node.js dependencies via `npm ci`.
  - Runs database schema migration `backend/migrations/init.sql` against the test container.
  - Executes unit test suites, authentication route tests, CSV import validation tests, and inventory cover calculations.

### 3.3 Job 3: `frontend-validate` ("Frontend validation")
- **Purpose:** Verifies presentation layer integrity across all public and authenticated interfaces.
- **Verification Logic:**
  - Verifies presence and valid markup of `landing.html`, `login.html`, `signup.html`, and `SupplyIQ-Grocery-Dashboard.html`.
  - Audits stylesheet links, JavaScript script tags, Chart.js dependencies, and CDN asset integrity.

### 3.4 Job 4: `docker-build` ("Docker build validation")
- **Purpose:** Confirms that the production container image builds successfully with no broken layers.
- **Tooling:** Docker Buildx (`docker/setup-buildx-action@v3`).
- **Target:** `backend/Dockerfile`.
- **Optimization:** Utilizes GitHub Actions cache (`type=gha`) to accelerate subsequent builds.

### 3.5 Job 5: `integration` ("End-to-End Docker Compose Stack")
- **Purpose:** End-to-end multi-container integration testing before merge.
- **Execution Workflow:**
  - Launches `docker-compose.yml` (`mysql`, `backend`, `frontend`).
  - Waits for container health status to report healthy.
  - Executes HTTP integration tests against `http://localhost:4000/api/health` and verifies 200 OK response.
  - Gracefully tears down the stack.

---

## 4. Instructions for Capturing GitHub Actions Evidence Screenshot

To capture genuine GitHub Actions execution runs directly from the repository:
1. Navigate to:
   `https://github.com/aksp42/SupplyIQ-AI-Powered-Inventory-Supply-Chain-Intelligence-Platform/actions`
2. Select the latest completed workflow run titled **"CI"** triggered on branch `main`.
3. Verify that the 5 jobs (`No committed secrets`, `Backend tests`, `Frontend validation`, `Docker build`, `End-to-end (compose)`) display green checkmarks.
4. Capture the browser window showing the workflow graph and status with `Windows Key + Shift + S`.
5. Save the screenshot in this directory as:
   `Project_Submission_Evidence/05_CICD_Evidence/GitHub_Actions_Workflow_Screenshot.png`.
