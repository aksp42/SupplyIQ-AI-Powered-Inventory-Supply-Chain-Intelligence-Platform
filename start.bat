@echo off
title SupplyIQ Grocery - Launcher
color 0A
cls

echo.
echo  ============================================================
echo   SupplyIQ Grocery  ^|  AI Supply Chain Intelligence
echo  ============================================================
echo.

:: Root folder (where this bat file lives)
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

:: Paths
set "BDIR=%ROOT%\backend"
set "FDIR=%ROOT%\frontend"
set "LAND=http://localhost:3000/public/landing.html"
set "DASH=http://localhost:3000/SupplyIQ-Grocery-Dashboard.html"

:: Check Node.js
where node >nul 2>&1
if errorlevel 1 (
    color 0C
    echo.
    echo  [ERROR] Node.js is not installed.
    echo  Please download from: https://nodejs.org
    echo.
    pause
    exit /b 1
)

:: Check dashboard file exists
if not exist "%FDIR%\SupplyIQ-Grocery-Dashboard.html" (
    color 0C
    echo.
    echo  [ERROR] Dashboard file not found:
    echo  %FDIR%\SupplyIQ-Grocery-Dashboard.html
    echo.
    pause
    exit /b 1
)

echo  [1/2] Checking backend dependencies...
if not exist "%BDIR%\node_modules" (
    echo       Installing packages ^(first run only^)...
    pushd "%BDIR%"
    call npm install --silent
    if errorlevel 1 (
        color 0C
        echo  [ERROR] npm install failed.
        pause
        exit /b 1
    )
    popd
    echo       Done.
) else (
    echo       Already installed.
)

echo  [2/2] Starting servers...
echo.

:: Kill anything already on port 4000
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":4000 " ^| findstr "LISTENING" 2^>nul') do (
    echo       Freeing port 4000 ^(backend^)...
    taskkill /PID %%a /F >nul 2>&1
)

:: Kill anything already on port 3000
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000 " ^| findstr "LISTENING" 2^>nul') do (
    echo       Freeing port 3000 ^(frontend^)...
    taskkill /PID %%a /F >nul 2>&1
)
timeout /t 1 /nobreak >nul

:: Start API backend
start "SupplyIQ Backend [port 4000]" cmd /k "cd /d "%BDIR%" && node server.js"

:: Start frontend static server
start "SupplyIQ Frontend [port 3000]" cmd /k "cd /d "%FDIR%" && node serve.js"

:: Wait for servers to boot
timeout /t 3 /nobreak >nul

:: Open landing page in browser (http:// so Firebase auth works)
start "" "%LAND%"

echo.
echo  ============================================================
echo   SupplyIQ is running!
echo.
echo   Landing    ^>  %LAND%
echo   Dashboard  ^>  %DASH%
echo   Backend    ^>  http://localhost:4000/api/health
echo   Login      ^>  http://localhost:3000/public/login.html
echo.
echo   Close the blue backend window to stop.
echo  ============================================================
echo.
pause
