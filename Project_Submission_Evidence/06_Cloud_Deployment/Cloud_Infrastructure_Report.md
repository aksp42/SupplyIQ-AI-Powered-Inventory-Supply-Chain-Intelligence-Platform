# Question 14: Cloud Deployment & Infrastructure Evidence

## 1. Executive Summary & Production Status

| Infrastructure Layer | Active Production Deployment | Historical / Staging Evidence |
| :--- | :--- | :--- |
| **Hosting Platform** | **Render Cloud Application Platform** | **Amazon Web Services (AWS)** |
| **Service URL** | [https://supplyiq-9kmv.onrender.com](https://supplyiq-9kmv.onrender.com) | ECR Image Registry (`ap-south-1` Mumbai) |
| **Deployment Model** | Managed Web Service (`render.yaml`) | Container Registry & ECS Task via GitHub OIDC |
| **Relational Database** | **TiDB Cloud Serverless MySQL (TLS 1.2+ Encrypted)** | Local / Containerized MySQL 8.0 |
| **Current Live Health** | **HTTP 200 OK** (`{"status":"ok","message":"SupplyIQ Backend (MySQL) running"}`) | Historical commit `72720f0` (Decommissioned) |

---

## 2. Active Cloud Architecture: Render + TiDB Cloud

### 2.1 Web Service Hosting (Render)
The active production application is hosted on Render's modern container and web service infrastructure:
- **Service Configuration File:** `render.yaml`
- **Specification:**
  ```yaml
  services:
    - type: web
      name: supplyiq-backend
      runtime: node
      buildCommand: cd backend && npm install
      startCommand: cd backend && npm start
      envVars:
        - key: NODE_ENV
          value: production
        - key: PORT
          value: 10000
        - key: DB_HOST
          sync: false
        - key: DB_PORT
          value: 4000
        - key: DB_USER
          sync: false
        - key: DB_PASSWORD
          sync: false
        - key: DB_NAME
          value: supplyiq
        - key: DB_SSL
          value: "true"
        - key: JWT_SECRET
          sync: false
        - key: CORS_ORIGIN
          value: "*"
  ```

### 2.2 Database Layer: TiDB Cloud Serverless MySQL
- **Architecture:** Distributed, cloud-native SQL database compatible with MySQL 8.0 protocols.
- **Security:** Strict TLS 1.2+ certificate encryption enforced (`DB_SSL: true`).
- **High Availability:** Auto-scaling compute and storage nodes with automatic failover and zero cold-start database sleep.

### 2.3 Live Production Health Check Verification
A real-time network request was performed directly to the production endpoint:

**Verification Request:**
```http
GET https://supplyiq-9kmv.onrender.com/api/health HTTP/1.1
Host: supplyiq-9kmv.onrender.com
Accept: application/json
```

**Live Verified Response:**
```json
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Date: Sat, 21 Nov 2026 17:03:51 GMT
Connection: keep-alive

{
  "status": "ok",
  "message": "SupplyIQ Backend (MySQL) running"
}
```

---

## 3. Historical AWS Infrastructure & Migration Rationale

### 3.1 Verified Git Evidence for AWS Deployment
The git commit history confirms the development and provisioning of Amazon Web Services (AWS) deployment infrastructure:
- **Verified Commit:** `72720f0` – *"Add AWS ECR deployment with OIDC role auth"*
- **Target AWS Region:** `ap-south-1` (AWS Asia Pacific - Mumbai)
- **Authentication Method:** GitHub Actions OpenID Connect (OIDC) identity federation (`aws-actions/configure-aws-credentials@v4`) eliminating long-lived AWS secret access keys.

### 3.2 Engineering Justification for Migration
In academic and prototype deployments, AWS ECS Fargate and NAT Gateways incur continuous hourly charges even during idle evaluation periods. To ensure:
1. **Uninterrupted 24/7 Availability:** Continuous public accessibility for academic review committees without budget exhaustion.
2. **Simplified Operational Overhead:** Consolidated GitOps pipeline via Render with automatic branch builds and built-in SSL termination.
3. **Resilient Data Persistence:** Migration from ephemeral container storage to TiDB Cloud's managed serverless cluster.

The AWS ECS tasks were gracefully decommissioned, and production traffic was seamlessly routed to the active Render + TiDB Cloud infrastructure.

---

## 4. Instructions for Capturing Render Dashboard Screenshot

1. Log in to the [Render Cloud Dashboard](https://dashboard.render.com).
2. Select the service named `supplyiq-backend` (or `supplyiq-9kmv`).
3. Ensure the service status chip shows **"Live"** (green indicator) with the deployed URL `https://supplyiq-9kmv.onrender.com`.
4. Capture a full screenshot of the service overview using `Windows Key + Shift + S`.
5. Save the image in this directory as:
   `Project_Submission_Evidence/06_Cloud_Deployment/Render_Cloud_Deployment_Screenshot.png`.
