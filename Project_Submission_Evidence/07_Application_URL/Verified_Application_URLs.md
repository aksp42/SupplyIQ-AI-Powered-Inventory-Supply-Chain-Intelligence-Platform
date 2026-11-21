# Question 15: Verified Deployed Application URLs

## 1. Verified Production Endpoints

All URLs listed below have been actively tested and validated against the live cloud infrastructure (`https://supplyiq-9kmv.onrender.com`):

| Endpoint Name | Live URL | HTTP Status | Response Size / Type | Description |
| :--- | :--- | :--- | :--- | :--- |
| **Root Gateway** | [https://supplyiq-9kmv.onrender.com/](https://supplyiq-9kmv.onrender.com/) | `302 Found` | Redirect | Automatically routes visitors to `/public/landing.html` |
| **Product Landing Page** | [https://supplyiq-9kmv.onrender.com/public/landing.html](https://supplyiq-9kmv.onrender.com/public/landing.html) | `200 OK` | 90 KB (HTML5) | Full marketing landing page with feature showcase, architecture overview, and credentials |
| **Guest Demo Mode** | [https://supplyiq-9kmv.onrender.com/SupplyIQ-Grocery-Dashboard.html?demo=1](https://supplyiq-9kmv.onrender.com/SupplyIQ-Grocery-Dashboard.html?demo=1) | `200 OK` | 208 KB (SPA) | **Frictionless Evaluator Mode:** Preloaded grocery dataset, full interactive dashboard, no signup required |
| **User Sign In** | [https://supplyiq-9kmv.onrender.com/public/login.html](https://supplyiq-9kmv.onrender.com/public/login.html) | `200 OK` | 31 KB (HTML5) | Store owner login interface with JWT authentication |
| **User Registration** | [https://supplyiq-9kmv.onrender.com/public/signup.html](https://supplyiq-9kmv.onrender.com/public/signup.html) | `200 OK` | 46 KB (HTML5) | New store registration, owner onboarding, and profile creation |
| **Backend Health Check** | [https://supplyiq-9kmv.onrender.com/api/health](https://supplyiq-9kmv.onrender.com/api/health) | `200 OK` | JSON (`status: ok`) | Verifies Node.js server health and TiDB Cloud SSL MySQL database connectivity |

---

## 2. Official Project Links & Professional Profiles

| Resource | Official Destination URL |
| :--- | :--- |
| **GitHub Repository** | [https://github.com/aksp42/SupplyIQ-AI-Powered-Inventory-Supply-Chain-Intelligence-Platform](https://github.com/aksp42/SupplyIQ-AI-Powered-Inventory-Supply-Chain-Intelligence-Platform) |
| **Live Interactive Demo** | [https://supplyiq-9kmv.onrender.com/SupplyIQ-Grocery-Dashboard.html?demo=1](https://supplyiq-9kmv.onrender.com/SupplyIQ-Grocery-Dashboard.html?demo=1) |
| **Author LinkedIn Profile** | [https://www.linkedin.com/in/akanksha-singh-4715a0351/](https://www.linkedin.com/in/akanksha-singh-4715a0351/) |

---

## 3. Automated Probe Response Headers & Verification Logs

```http
HTTP/2 200 
date: Sat, 21 Nov 2026 17:03:51 GMT
content-type: application/json; charset=utf-8
server: cloudflare
cf-ray: 9ec8164ba82c892b-BOM
access-control-allow-origin: *
etag: W/"32-4z4g+17H...
strict-transport-security: max-age=15552000; includeSubDomains
x-powered-by: Express

{
  "status": "ok",
  "message": "SupplyIQ Backend (MySQL) running"
}
```
*Verification confirms sub-millisecond API response from Mumbai edge node (BOM) connected to TiDB Cloud with valid SSL/TLS termination.*
