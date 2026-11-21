# SupplyIQ: Final Academic Project Submission Evidence (Questions 9–15)

**Project Title:** SupplyIQ – AI-Powered Inventory & Supply Chain Intelligence Platform  
**Author / Candidate:** Akanksha Singh (`aksp42`)  
**Official GitHub Repository:** [https://github.com/aksp42/SupplyIQ-AI-Powered-Inventory-Supply-Chain-Intelligence-Platform](https://github.com/aksp42/SupplyIQ-AI-Powered-Inventory-Supply-Chain-Intelligence-Platform)  
**Live Production URL:** [https://supplyiq-9kmv.onrender.com](https://supplyiq-9kmv.onrender.com)  
**Interactive Demo URL:** [https://supplyiq-9kmv.onrender.com/SupplyIQ-Grocery-Dashboard.html?demo=1](https://supplyiq-9kmv.onrender.com/SupplyIQ-Grocery-Dashboard.html?demo=1)  
**Author LinkedIn:** [https://www.linkedin.com/in/akanksha-singh-4715a0351/](https://www.linkedin.com/in/akanksha-singh-4715a0351/)

---

## QUESTION 9: Project Architecture Diagram

### Academic Answer
SupplyIQ is engineered around a multi-tier microservices architecture separating presentation, edge reverse-proxying, application business logic, and resilient cloud database persistence:

1. **Client Tier (Presentation Layer):**
   - Single Page Application (SPA) built with semantic HTML5, CSS3 variables, and vanilla JavaScript.
   - Features 8 distinct operational views: Overview, Replenishment, Products, Inventory, Suppliers, Risk & Alerts, Demand Forecast, and Reports.
   - Includes Guest Demo Mode (`?demo=1`) for instant evaluation without authentication friction.
2. **Cloud Hosting & Edge Tier:**
   - Deployed on Render's managed Web Service infrastructure with automatic SSL/TLS encryption.
   - Statically serves public marketing pages (`landing.html`) and client scripts while routing `/api/*` to the Express REST engine.
3. **Application & Intelligence Server Tier:**
   - Node.js & Express RESTful API with JWT authentication and bcrypt password hashing.
   - Multi-tenant data isolation ensuring store data confidentiality.
   - Core Engines:
     - *CSV Ingestion & Validation Engine:* Automatically detects format, validates schemas, and reorders chronological receipts and dispatches to prevent negative balance stock anomalies.
     - *Inventory & Stock Ledger:* Real-time tracking of on-hand quantities, safety stock buffers, and minimum cover days.
     - *Demand Forecasting:* Moving averages and sales velocity analysis predicting stockout dates.
     - *Supplier Performance Monitor:* Calculates On-Time In-Full (OTIF) scores and lead-time volatility.
     - *TradeSaarthi AI:* Conversational assistant providing natural language supply chain decision support.
4. **Data Persistence Tier:**
   - Production database powered by TiDB Cloud Serverless MySQL with enforced TLS 1.2+ encryption (`DB_SSL: true`).
   - Highly normalized relational schema storing users, store profiles, products, inventory batches, and immutable stock movement ledgers.
5. **CI/CD DevOps Tier:**
   - Automated GitHub Actions workflow executing 5 verification jobs on every commit to `main`.

### Deliverables & Diagram Files
- **High-Resolution PNG (300 DPI):** `Project_Submission_Evidence/01_Architecture/SupplyIQ_Architecture.png`
- **Vector PDF:** `Project_Submission_Evidence/01_Architecture/SupplyIQ_Architecture.pdf`
- **Scalable Vector Graphics (SVG):** `Project_Submission_Evidence/01_Architecture/SupplyIQ_Architecture.svg`
- **Mermaid Editable Source:** `Project_Submission_Evidence/01_Architecture/SupplyIQ_Architecture.mmd`
- **Detailed Specification:** `Project_Submission_Evidence/01_Architecture/Architecture_Documentation.md`

---

## QUESTION 10: GitHub Repository Structure Screenshot

### Academic Answer
The SupplyIQ repository is organized following industry-standard monorepo practices, with strict separation between continuous integration workflows, backend business services, frontend presentation assets, and architectural documentation:

- **`.github/workflows/ci.yml`**: Defines the automated 5-job CI/CD pipeline.
- **`backend/`**: Node.js/Express REST server, JWT auth, MySQL/TiDB database connectors, CSV auto-healing engine, and Jest test suites.
- **`frontend/`**: Responsive SPA dashboard, Chart.js visualizations, landing page, and authentication views.
- **`docs/`**: Comprehensive architectural specifications and feature documentation.
- **`Project_Submission_Evidence/`**: Complete academic evidence deliverables organized into structured subdirectories.
- **Root Configuration Files**: `docker-compose.yml`, `render.yaml`, `start.bat`, `create-docker-env.sh`, and `README.md`.

### Deliverables & Evidence Files
- **Structure Documentation:** `Project_Submission_Evidence/02_GitHub_Structure/GitHub_Repository_Structure.md`
- **Genuine Screenshot Capture Guide:** Detailed in Section 4 of the above markdown document.

---

## QUESTION 11: Forked GitHub Repository URL

### Academic Answer
To verify the provenance and origin of the codebase, a query was executed against the official GitHub REST API (`GET https://api.github.com/repos/aksp42/SupplyIQ-AI-Powered-Inventory-Supply-Chain-Intelligence-Platform`).

The response verified:
- `"fork": false`
- `"parent": null`
- `"source": null`

**Official Submission Status:**
- **Original Repository URL:** [https://github.com/aksp42/SupplyIQ-AI-Powered-Inventory-Supply-Chain-Intelligence-Platform](https://github.com/aksp42/SupplyIQ-AI-Powered-Inventory-Supply-Chain-Intelligence-Platform)
- **Forked Repository URL:** **Not Applicable / No Forked URL Available.** This repository is an original, standalone root creation by candidate `aksp42` and is not a fork of any preexisting repository.

### Deliverables & Evidence Files
- **Verification Report:** `Project_Submission_Evidence/03_Forked_Repository/Fork_Status_Report.md`

---

## QUESTION 12: Docker Container Execution Evidence

### Academic Answer
SupplyIQ provides full containerization support through Docker and Docker Compose:
- **`backend/Dockerfile`**: Uses lightweight `node:20-alpine` with multi-stage layer caching, non-dev dependency installation (`npm ci --omit=dev`), automated health checking (`HEALTHCHECK` probing `/api/health`), and port 4000 exposure.
- **`frontend/Dockerfile`**: Alpine Nginx container serving static frontend assets and reverse proxying API calls.
- **`docker-compose.yml`**: Multi-container stack orchestrating MySQL 8.0 (port 3306), Backend API (port 4000), and Nginx Frontend (port 80) over an isolated bridge network (`supplyiq-net`). It enforces healthy service dependencies (`depends_on: mysql: condition: service_healthy`) to prevent startup race conditions.

**Workstation Status Note:**
Docker CLI version `29.8.0` is verified and installed on the host machine. The Docker Desktop Linux Engine daemon was idle at verification time; in strict compliance with the submission integrity guidelines, no artificial terminal output was fabricated. A complete step-by-step PowerShell guide is provided to reproduce container execution on demand.

### Deliverables & Evidence Files
- **Docker Verification Report:** `Project_Submission_Evidence/04_Docker_Evidence/Docker_Verification_Report.md`
- **Windows Docker Execution Guide:** `Project_Submission_Evidence/04_Docker_Evidence/Windows_Docker_Execution_Guide.md`

---

## QUESTION 13: CI/CD Pipeline Configuration

### Academic Answer
Continuous Integration and Deployment is implemented via GitHub Actions in `.github/workflows/ci.yml` (722 lines). It runs on every `push` and `pull_request` to `main`, `master`, and `develop` with active concurrency deduplication:

1. **`secret-scan`:** Scans commits and files for untracked credentials, private keys, AWS tokens, GitHub PATs, and passwords.
2. **`backend-test`:** Spins up an official MySQL 8.0 service container, applies schema migrations from `backend/migrations/init.sql`, and executes backend API and business logic tests under Node.js 20.
3. **`frontend-validate`:** Validates HTML markup, CSS styling, and client-side JavaScript integrity.
4. **`docker-build`:** Tests production Docker image compilation using Buildx with GitHub Actions layer caching.
5. **`integration`:** Performs end-to-end multi-container validation using Docker Compose.

### Deliverables & Evidence Files
- **CI/CD Pipeline Report:** `Project_Submission_Evidence/05_CICD_Evidence/CICD_Pipeline_Report.md`
- **Workflow File:** `.github/workflows/ci.yml`

---

## QUESTION 14: Cloud Deployment and Infrastructure Evidence

### Academic Answer
SupplyIQ operates on a high-availability cloud architecture combining Render Cloud Application Services and TiDB Cloud Serverless MySQL:

- **Production Cloud Host:** Render Web Service (`https://supplyiq-9kmv.onrender.com`), managed via declarative Infrastructure-as-Code (`render.yaml`).
- **Production Database:** TiDB Cloud Serverless MySQL, providing distributed MySQL 8.0-compatible storage with enforced TLS 1.2+ SSL encryption (`DB_SSL: true`).
- **Verified Active Health:** The live API probe at `https://supplyiq-9kmv.onrender.com/api/health` returns `200 OK` with payload `{"status":"ok","message":"SupplyIQ Backend (MySQL) running"}`.
- **Historical AWS Deployment:** Verified in git commit `72720f0` (*"Add AWS ECR deployment with OIDC role auth"*), configuring container push to AWS ECR in Mumbai (`ap-south-1`) via GitHub Actions OpenID Connect. The AWS infrastructure was subsequently decommissioned to prevent idle cloud billing while maintaining 24/7 public availability via Render and TiDB Cloud.

### Deliverables & Evidence Files
- **Cloud Infrastructure Report:** `Project_Submission_Evidence/06_Cloud_Deployment/Cloud_Infrastructure_Report.md`
- **Render Configuration:** `render.yaml`

---

## QUESTION 15: Final Deployed Application URL

### Academic Answer
The SupplyIQ platform is fully deployed, operational, and publicly accessible across all core user journeys:

- **Live Landing Page:** [https://supplyiq-9kmv.onrender.com/public/landing.html](https://supplyiq-9kmv.onrender.com/public/landing.html) (HTTP 200 OK)
- **Guest Demo Mode:** [https://supplyiq-9kmv.onrender.com/SupplyIQ-Grocery-Dashboard.html?demo=1](https://supplyiq-9kmv.onrender.com/SupplyIQ-Grocery-Dashboard.html?demo=1) (HTTP 200 OK – immediate evaluation with preloaded dataset)
- **Store Owner Login:** [https://supplyiq-9kmv.onrender.com/public/login.html](https://supplyiq-9kmv.onrender.com/public/login.html) (HTTP 200 OK)
- **New Store Registration:** [https://supplyiq-9kmv.onrender.com/public/signup.html](https://supplyiq-9kmv.onrender.com/public/signup.html) (HTTP 200 OK)
- **Health Check API:** [https://supplyiq-9kmv.onrender.com/api/health](https://supplyiq-9kmv.onrender.com/api/health) (HTTP 200 OK)

### Deliverables & Evidence Files
- **Verified URLs & Response Proofs:** `Project_Submission_Evidence/07_Application_URL/Verified_Application_URLs.md`
- **Faculty Evaluation Guide:** `Project_Submission_Evidence/07_Application_URL/Faculty_Evaluation_Guide.md`
