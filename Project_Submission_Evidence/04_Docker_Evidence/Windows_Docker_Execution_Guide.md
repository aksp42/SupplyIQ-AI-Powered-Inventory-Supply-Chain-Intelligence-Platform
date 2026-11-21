# Windows Docker Execution Guide & Screenshot Instructions

## 1. Prerequisites
To execute the multi-container stack locally on your Windows machine:
1. Launch **Docker Desktop** from the Windows Start menu.
2. Wait until the whale icon in the Windows notification area becomes steady and displays **"Docker Desktop is running"**.

---

## 2. Step-by-Step Execution Commands (PowerShell)

Open PowerShell as Administrator in the project root directory:
```powershell
cd c:\Users\HP\Desktop\Akshu.S.P\SupplyIQ-AI-Powered-Inventory-Supply-Chain-Intelligence-Platform-main
```

### Step 1: Build and Launch the Stack
Run the orchestration command in detached mode:
```powershell
docker compose up -d --build
```
*Expected Output:* Docker will pull the `mysql:8.0` base image, build the `node:20-alpine` backend image, configure network `supplyiq-net`, and launch all three containers.

### Step 2: Verify Running Containers
Verify that all 3 services are active and healthy:
```powershell
docker compose ps
```
or
```powershell
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```
*Expected Status:*
- `supplyiq-mysql` -> `Up (healthy)` on `0.0.0.0:3306->3306/tcp`
- `supplyiq-backend` -> `Up (healthy)` on `0.0.0.0:4000->4000/tcp`
- `supplyiq-frontend` -> `Up` on `0.0.0.0:80->80/tcp`

### Step 3: Test Health Endpoint
Verify that the backend container is actively serving requests:
```powershell
Invoke-RestMethod -Uri http://localhost:4000/api/health
```
*Expected Response:*
```json
{"status":"ok","message":"SupplyIQ Backend (MySQL) running"}
```

### Step 4: Access the Frontend
Open your web browser and navigate to:
```
http://localhost/SupplyIQ-Grocery-Dashboard.html?demo=1
```

---

## 3. Capturing Genuine Container Execution Screenshot

1. In PowerShell, execute:
   ```powershell
   docker ps
   ```
2. Open Docker Desktop and click on the **Containers** tab to show `supplyiq-mysql`, `supplyiq-backend`, and `supplyiq-frontend` with green "Running" status chips.
3. Capture the screen using `Windows Key + Shift + S`.
4. Save the screenshot in this directory as:
   `Project_Submission_Evidence/04_Docker_Evidence/Docker_Containers_Screenshot.png`.

---

## 4. Teardown / Cleanup
When testing is complete, gracefully stop and remove all containers and network bridges:
```powershell
docker compose down
```
To also purge database volumes:
```powershell
docker compose down -v
```
