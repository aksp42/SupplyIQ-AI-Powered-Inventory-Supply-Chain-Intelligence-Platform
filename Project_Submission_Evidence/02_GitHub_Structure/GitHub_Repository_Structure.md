# Question 10: GitHub Repository Structure Evidence

## 1. Repository Identification & Metadata

| Field | Repository Value |
| :--- | :--- |
| **Project Title** | SupplyIQ – AI-Powered Inventory & Supply Chain Intelligence Platform |
| **Repository Name** | `SupplyIQ-AI-Powered-Inventory-Supply-Chain-Intelligence-Platform` |
| **Repository Owner / Author** | `aksp42` (Akanksha Singh) |
| **Official Repository URL** | [https://github.com/aksp42/SupplyIQ-AI-Powered-Inventory-Supply-Chain-Intelligence-Platform](https://github.com/aksp42/SupplyIQ-AI-Powered-Inventory-Supply-Chain-Intelligence-Platform) |
| **Default Primary Branch** | `main` |
| **Visibility** | Public |
| **Hosting Platform** | GitHub |

---

## 2. Complete Repository Directory Tree

```
SupplyIQ-AI-Powered-Inventory-Supply-Chain-Intelligence-Platform/
├── .github/
│   └── workflows/
│       └── ci.yml                         # Automated 5-stage GitHub Actions CI/CD Pipeline
├── backend/
│   ├── csv/                               # Sample and benchmark CSV transaction datasets
│   ├── migrations/                        # Relational database schema & SQL migration scripts
│   │   └── init.sql                       # MySQL table definitions, indexes, and constraints
│   ├── ml/                                # Machine Learning & demand forecasting scripts
│   ├── scripts/                           # Database migration, verification, and seed helpers
│   ├── tests/                             # Automated Jest/Supertest backend unit & API tests
│   ├── .env.example                       # Documented environment variable template
│   ├── auth.js                            # JWT authentication & password verification logic
│   ├── catalog.js                         # Product catalog and classification endpoints
│   ├── csv.js                             # Multi-format CSV ingestion & error-healing engine
│   ├── Dockerfile                         # Production multi-stage Docker build configuration
│   ├── forecast.js                        # Demand forecasting, moving averages, and lead time logic
│   ├── imports.js                         # Batch import processing and transaction reconciliation
│   ├── mysql.js                           # TiDB / MySQL connection pool with SSL TLS support
│   ├── package.json                       # Backend Node.js dependencies and script declarations
│   ├── server.js                          # Express.js REST API server entry point & middleware
│   ├── stock.js                           # Stock ledger, safety stock, and inventory cover calculations
│   └── tenancy.js                         # Multi-tenant store profile isolation & session handling
├── frontend/
│   ├── css/                               # Component stylesheets, responsive grids, and design themes
│   ├── js/                                # Client-side state managers, chart renderers, and API clients
│   │   └── api.js                         # Unified frontend HTTP client interfacing with backend
│   ├── public/                            # Statically served web assets and public-facing pages
│   │   ├── landing.html                   # Official SupplyIQ marketing landing page
│   │   ├── login.html                     # User authentication login interface
│   │   └── signup.html                    # Store registration and onboarding interface
│   ├── Dockerfile                         # Frontend Nginx production container configuration
│   ├── nginx.conf                         # Reverse proxy configuration for frontend container
│   └── SupplyIQ-Grocery-Dashboard.html    # Core responsive Single Page Application (SPA) dashboard
├── docs/                                  # Technical specifications and architectural references
│   ├── features/                          # Feature-specific deep-dive documents
│   └── ARCHITECTURE.md                    # Detailed engineering architecture documentation
├── Project_Submission_Evidence/           # Academic college submission evidence deliverables
│   ├── 01_Architecture/                   # High-resolution PNG, PDF, SVG, and Mermaid diagrams
│   ├── 02_GitHub_Structure/               # Repository structure documentation and evidence
│   ├── 03_Forked_Repository/              # Fork verification report and GitHub API analysis
│   ├── 04_Docker_Evidence/                # Container execution verification and Compose analysis
│   ├── 05_CICD_Evidence/                  # GitHub Actions CI workflow analysis and job details
│   ├── 06_Cloud_Deployment/               # Render + TiDB Cloud live infrastructure verification
│   ├── 07_Application_URL/                # Verified live application endpoints and testing guide
│   └── 08_Submission_Summary/             # Consolidated questions 9 to 15 master submission report
├── .gitattributes                         # Git text and line ending normalization rules
├── .gitignore                             # Ignored files, dependencies (node_modules), and secrets
├── CONTRIBUTING.md                        # Developer contribution guidelines and PR workflow
├── create-docker-env.sh                   # Helper script for container environment setup
├── docker-compose.yml                     # Multi-service local composition (MySQL + Backend + Nginx)
├── README.md                              # Main project documentation, quickstart, and live links
├── render.yaml                            # Infrastructure-as-Code for Render Cloud deployment
└── start.bat                              # One-click Windows local development launcher
```

---

## 3. Component & Folder Functional Breakdown

### 3.1 `.github/workflows/ci.yml`
Contains the complete continuous integration specification. Configured to trigger on all pushes and pull requests targeting the `main` branch. Executes 5 sequential and parallel verification jobs: secret scanning, unit testing with MySQL 8.0 service container, frontend linting, Docker image build validation, and end-to-end multi-container integration testing.

### 3.2 `backend/`
The application server tier written in Node.js with Express:
- **`server.js`**: Server initialization, CORS policy, JSON body parsers, health check route `/api/health`, and sub-router mounts.
- **`auth.js` & `tenancy.js`**: Token-based authentication, bcrypt password hashing, and multi-tenant store isolation ensuring store owners only access their own inventories.
- **`csv.js` & `imports.js`**: Core ingestion engine supporting multi-format CSVs. Includes intelligent auto-sorting of stock receipts before sales dispatches to resolve chronological deficit errors.
- **`stock.js` & `forecast.js`**: Business logic engines calculating real-time inventory balances, minimum cover days, reorder thresholds, and demand forecasts.
- **`mysql.js`**: High-resiliency database connector supporting standard MySQL and TiDB Cloud with mandatory TLS 1.2+ SSL encryption.

### 3.3 `frontend/`
The presentation layer built with vanilla JavaScript, modern CSS3 variables, and semantic HTML5:
- **`SupplyIQ-Grocery-Dashboard.html`**: The unified dashboard application. Contains 8 navigation tabs, dynamic KPI counters, interactive Chart.js visualizations, CSV drag-and-drop importers, and the TradeSaarthi AI modal.
- **`public/landing.html`**: Production-grade landing page explaining the platform value proposition, business pain points, workflow stages, and live credentials.
- **`public/login.html` & `public/signup.html`**: User registration and authentication workflows with real-time field validation.

### 3.4 Root Configuration Files
- **`docker-compose.yml`**: Defines the multi-container development environment consisting of `mysql` (port 3306), `backend` (port 4000), and `frontend` (port 80).
- **`render.yaml`**: Infrastructure-as-Code blueprint deploying the application on Render's cloud platform.
- **`README.md`**: Complete documentation covering architecture, setup guides, API reference, demo walkthrough, and live URLs.

---

## 4. Instructions for Capturing Genuine GitHub Screenshot

To maintain 100% academic integrity and satisfy the submission guideline requiring genuine screenshots:

1. Open your web browser and navigate to:
   `https://github.com/aksp42/SupplyIQ-AI-Powered-Inventory-Supply-Chain-Intelligence-Platform`
2. Ensure you are on the `main` branch.
3. Make sure the repository header (`aksp42 / SupplyIQ-AI-Powered-Inventory-Supply-Chain-Intelligence-Platform`), branch selector (`main`), and root file list (`.github`, `backend`, `frontend`, `docker-compose.yml`, `README.md`, `render.yaml`) are clearly visible in the browser viewport.
4. Press `Windows Key + Shift + S` (Windows Snipping Tool) or `Print Screen`.
5. Capture the full browser window showing the URL bar and repository root files.
6. Save the captured screenshot in this folder as:
   `Project_Submission_Evidence/02_GitHub_Structure/GitHub_Repository_Screenshot.png`.
