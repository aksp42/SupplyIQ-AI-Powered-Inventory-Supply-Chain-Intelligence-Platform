"""
Generate High-Resolution Architecture Diagrams for SupplyIQ (PNG, PDF, SVG, MMD)
"""
import os
import matplotlib.pyplot as plt
import matplotlib.patches as patches

# Ensure output directory exists
output_dir = r"c:\Users\HP\Desktop\Akshu.S.P\SupplyIQ-AI-Powered-Inventory-Supply-Chain-Intelligence-Platform-main\Project_Submission_Evidence\01_Architecture"
os.makedirs(output_dir, exist_ok=True)

# 1. Mermaid Source File
mermaid_content = """graph TB
    subgraph Client_Tier ["Client Tier (Browser & Presentation)"]
        UI["SupplyIQ Responsive Dashboard (HTML5 / Vanilla JS / CSS3)"]
        Landing["Landing & Auth Pages (landing.html, login.html, signup.html)"]
        Demo["Guest Demo Mode (SupplyIQ-Grocery-Dashboard.html?demo=1)"]
        Charts["Interactive Visualizations (Chart.js / Custom Metrics)"]
    end

    subgraph CDN_Hosting ["Cloud Hosting & Edge Delivery"]
        RenderCDN["Render Web Service (Global CDN / Static & Proxy)"]
    end

    subgraph API_Gateway ["Application Server Tier (Node.js & Express)"]
        AuthMiddleware["JWT Authentication & RBAC Middleware"]
        Router["Express REST API Router (/api/*)"]
        
        subgraph Core_Engines ["Business Intelligence & Core Engines"]
            InvEngine["Inventory Management Engine (Levels, Safety Stock, Cover)"]
            CSVEngine["CSV Parser & Validation Engine (Transaction Reordering)"]
            SalesEngine["Sales & Stock Transaction Engine (FIFO / Issues / Receipts)"]
            ForecastML["Demand Forecasting & Trend Analysis (Moving Avg / Seasonality)"]
            RiskAlert["Risk & Stockout Alert Engine (Lead Time, Critical Buffers)"]
            SupplierMon["Supplier Performance Monitor (On-Time Delivery, Fill Rates)"]
            TradeSaarthi["TradeSaarthi AI Supply Chain Assistant (Rule & NLP Logic)"]
        end
    end

    subgraph Database_Tier ["Data Persistence Tier (TiDB Cloud / MySQL 8.0)"]
        TiDB[("TiDB Cloud Serverless MySQL (TLS 1.2+ Encrypted)")]
        UsersTable[("Users & Store Profiles")]
        InventoryTable[("Products & Real-time Stock")]
        TransactionsTable[("Ledger & Stock Movements")]
        SuppliersTable[("Suppliers & Purchase History")]
        AuditTable[("System Audit Logs")]
    end

    subgraph CICD_Tier ["CI/CD Automation & DevOps"]
        GH["GitHub Actions CI Pipeline (.github/workflows/ci.yml)"]
        Jobs["5 Automated Jobs: Secret Scan | Backend Tests | Frontend Lint | Docker Build | Compose E2E"]
        DockerBuild["Docker Multi-Stage Image (node:20-alpine)"]
    end

    subgraph Legacy_Infra ["Historical Deployment Pipeline (Archived)"]
        AWSECS["AWS ECR / ECS Fargate (ap-south-1 Mumbai via GitHub OIDC)"]
    end

    %% Data Flow Connections
    Landing --> AuthMiddleware
    UI --> Router
    Demo --> UI
    Charts --> UI
    RenderCDN --> Client_Tier

    AuthMiddleware --> Router
    Router --> InvEngine
    Router --> CSVEngine
    Router --> SalesEngine
    Router --> ForecastML
    Router --> RiskAlert
    Router --> SupplierMon
    Router --> TradeSaarthi

    InvEngine --> TiDB
    CSVEngine --> TiDB
    SalesEngine --> TiDB
    ForecastML --> TiDB
    RiskAlert --> TiDB
    SupplierMon --> TiDB

    TiDB --> UsersTable
    TiDB --> InventoryTable
    TiDB --> TransactionsTable
    TiDB --> SuppliersTable
    TiDB --> AuditTable

    GH --> Jobs
    Jobs --> DockerBuild
    DockerBuild -.-> RenderCDN
    DockerBuild -.-> AWSECS
"""

with open(os.path.join(output_dir, "SupplyIQ_Architecture.mmd"), "w", encoding="utf-8") as f:
    f.write(mermaid_content)

# 2. Generate Matplotlib High-Resolution Diagram (PNG & PDF)
fig, ax = plt.subplots(figsize=(18, 12), dpi=300)
ax.set_facecolor("#0b1319")
fig.patch.set_facecolor("#0b1319")

# Helper function to draw rounded boxes
def draw_box(x, y, w, h, title, subtitle="", bg="#13232f", border="#00c853", text_color="#ffffff", alpha=0.95):
    rect = patches.FancyBboxPatch(
        (x, y), w, h,
        boxstyle="round,pad=0.03,rounding_size=0.15",
        linewidth=1.8,
        edgecolor=border,
        facecolor=bg,
        alpha=alpha,
        zorder=2
    )
    ax.add_patch(rect)
    if title:
        ax.text(x + w / 2, y + h - 0.28, title, ha="center", va="center",
                fontsize=11, fontweight="bold", color=border, zorder=3)
    if subtitle:
        ax.text(x + w / 2, y + h / 2 - 0.1, subtitle, ha="center", va="center",
                fontsize=8.5, color=text_color, wrap=True, zorder=3)

# Container background panels
def draw_container(x, y, w, h, title, border="#37474f", bg="#0f1b24"):
    rect = patches.FancyBboxPatch(
        (x, y), w, h,
        boxstyle="round,pad=0.04,rounding_size=0.2",
        linewidth=1.5,
        linestyle="--",
        edgecolor=border,
        facecolor=bg,
        alpha=0.7,
        zorder=1
    )
    ax.add_patch(rect)
    ax.text(x + 0.3, y + h - 0.35, title, ha="left", va="center",
            fontsize=13, fontweight="bold", color="#81c784", zorder=3)

# Draw Containers
# 1. Client Tier
draw_container(0.5, 8.5, 17, 3.0, "1. CLIENT TIER (Browser & Mobile Responsive SPA)")
draw_box(0.8, 8.8, 3.8, 2.0, "Landing & Auth", "• landing.html\n• login.html / signup.html\n• JWT Token Storage\n• Session State Handling", bg="#102a27", border="#00e676")
draw_box(5.0, 8.8, 3.8, 2.0, "Interactive Dashboard", "• SupplyIQ-Grocery-Dashboard.html\n• Single Page App (SPA)\n• 8 Integrated Tabs\n• Live Theme & Store Switcher", bg="#102a27", border="#00e676")
draw_box(9.2, 8.8, 3.8, 2.0, "Guest Demo Mode", "• ?demo=1 Parameter Support\n• Instant Evaluation Mode\n• Preloaded Grocery Dataset\n• Zero Login Barrier for Faculty", bg="#102a27", border="#00e676")
draw_box(13.4, 8.8, 3.8, 2.0, "Data Visualizations", "• Chart.js Sales & Profit\n• Stock Health Radar\n• Lead Time Gauges\n• Interactive Data Tables", bg="#102a27", border="#00e676")

# 2. Cloud Edge & Hosting
draw_container(0.5, 6.8, 17, 1.3, "2. CLOUD HOSTING & GATEWAY TIER", border="#1e88e5", bg="#0d1b2a")
draw_box(1.0, 7.0, 7.5, 0.9, "Render Web Service", "Production Host: supplyiq-9kmv.onrender.com | Node.js Runtime + HTTPS SSL Termination", bg="#15263a", border="#42a5f5")
draw_box(9.5, 7.0, 7.5, 0.9, "Reverse Proxy & Routing", "Express Static Hosting (/public, /) + REST API Gateway (/api/*)", bg="#15263a", border="#42a5f5")

# 3. Application Tier
draw_container(0.5, 2.6, 17, 3.8, "3. APPLICATION & INTELLIGENCE SERVER TIER (Node.js & Express)", border="#ffb300", bg="#1c1f17")
draw_box(0.8, 4.4, 3.8, 1.6, "Auth & Security", "• JWT Authentication\n• bcrypt Password Hashing\n• CORS & Helmet Security\n• Multi-Store Tenant Isolation", bg="#262312", border="#ffd54f")
draw_box(5.0, 4.4, 3.8, 1.6, "CSV Engine & Auditor", "• Multi-Format CSV Importer\n• Chronological Re-ordering\n• Stock Deficit Auto-Healing\n• Row-Level Error Correction", bg="#262312", border="#ffd54f")
draw_box(9.2, 4.4, 3.8, 1.6, "Inventory & Ledger", "• Real-Time Stock Balance\n• Stock Received / Issued\n• Minimum Cover Calculator\n• Automated Safety Buffers", bg="#262312", border="#ffd54f")
draw_box(13.4, 4.4, 3.8, 1.6, "TradeSaarthi AI", "• Contextual AI Assistant\n• Supply Chain Query Engine\n• Stockout & Reorder Guidance\n• Restocking Recommendations", bg="#262312", border="#ffd54f")

draw_box(0.8, 2.8, 5.2, 1.3, "Demand Forecasting & Trends", "• 7-Day & 30-Day Moving Average Forecasts\n• Sales Velocity & Stockout Risk Projections\n• Fast vs Slow Moving SKU Classification", bg="#262312", border="#ffd54f")
draw_box(6.4, 2.8, 5.2, 1.3, "Supplier Risk & Performance", "• On-Time In-Full (OTIF) Delivery Scoring\n• Lead-time Volatility Tracking\n• Risk Severity Matrix & Critical Alerts", bg="#262312", border="#ffd54f")
draw_box(12.0, 2.8, 5.2, 1.3, "Automated Replenishment", "• Reorder Point (ROP) Detection\n• Economic Order Recommendations\n• Supplier PO Generation Preview", bg="#262312", border="#ffd54f")

# 4. Data Tier & CI/CD
draw_container(0.5, 0.3, 10.5, 2.0, "4. DATA PERSISTENCE TIER (Managed MySQL / TiDB Cloud)", border="#ab47bc", bg="#1d1326")
draw_box(0.8, 0.5, 4.8, 1.5, "TiDB Cloud Serverless MySQL", "• High Availability Cloud MySQL\n• TLS 1.2+ SSL Encrypted Connection\n• Auto-Scaling Serverless Storage", bg="#2a1836", border="#ce93d8")
draw_box(5.8, 0.5, 4.8, 1.5, "Normalized Relational Schema", "• users & store_profiles\n• products, inventory_batches\n• stock_movements & supplier_metrics", bg="#2a1836", border="#ce93d8")

draw_container(11.5, 0.3, 6.0, 2.0, "5. DEVOPS & CI/CD PIPELINE", border="#26a69a", bg="#0e2321")
draw_box(11.8, 0.5, 5.4, 1.5, "GitHub Actions CI (.github/workflows/ci.yml)", "• 5 Automated Verification Stages:\n  Secret Scan | Backend Tests | Frontend Lint\n  Docker Build | Compose E2E Integration Stack", bg="#132c29", border="#80cbc4")

# Draw connecting arrows
def draw_arrow(x1, y1, x2, y2, label=""):
    ax.annotate(
        "", xy=(x2, y2), xytext=(x1, y1),
        arrowprops=dict(arrowstyle="->", color="#90caf9", lw=1.6, mutation_scale=14)
    )
    if label:
        ax.text((x1 + x2) / 2, (y1 + y2) / 2, label, color="#b0bec5", fontsize=7.5,
                ha="center", va="center", backgroundcolor="#0b1319")

# Connect Client to Edge Gateway
draw_arrow(2.7, 8.8, 4.5, 7.9, "HTTPS Requests")
draw_arrow(6.9, 8.8, 4.8, 7.9)
draw_arrow(11.1, 8.8, 13.0, 7.9)
draw_arrow(15.3, 8.8, 13.5, 7.9)

# Connect Edge Gateway to App Tier
draw_arrow(4.8, 7.0, 2.7, 6.0, "Auth / Handshake")
draw_arrow(7.0, 7.0, 7.0, 6.0, "REST API Calls")
draw_arrow(13.2, 7.0, 11.1, 6.0, "Data Ingestion")
draw_arrow(13.2, 7.0, 15.3, 6.0, "AI Queries")

# Connect App Tier to Database
draw_arrow(3.4, 2.8, 3.2, 2.0, "TLS Queries")
draw_arrow(9.0, 2.8, 8.2, 2.0, "SQL Persistence")

# Connect CI/CD to Hosting
draw_arrow(14.5, 2.0, 14.5, 6.8, "Automated Validation")

# Title and metadata header
ax.text(9.0, 11.65, "SupplyIQ – System Architecture & End-to-End Data Flow",
        ha="center", va="center", fontsize=18, fontweight="bold", color="#ffffff")
ax.text(9.0, 11.35, "AI-Powered Inventory & Supply Chain Intelligence Platform | Academic Project Submission Evidence",
        ha="center", va="center", fontsize=11, color="#81c784")

ax.set_xlim(0, 18)
ax.set_ylim(0, 12)
ax.axis("off")

plt.tight_layout()
png_path = os.path.join(output_dir, "SupplyIQ_Architecture.png")
pdf_path = os.path.join(output_dir, "SupplyIQ_Architecture.pdf")
svg_path = os.path.join(output_dir, "SupplyIQ_Architecture.svg")

plt.savefig(png_path, dpi=300, facecolor=fig.get_facecolor(), bbox_inches="tight")
plt.savefig(pdf_path, facecolor=fig.get_facecolor(), bbox_inches="tight")
plt.savefig(svg_path, facecolor=fig.get_facecolor(), bbox_inches="tight")
plt.close()

print(f"Architecture files generated successfully:\n- {png_path}\n- {pdf_path}\n- {svg_path}\n- {os.path.join(output_dir, 'SupplyIQ_Architecture.mmd')}")
