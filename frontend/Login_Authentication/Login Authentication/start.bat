@echo off
title Firebase Authentication Module
setlocal

cd /d "%~dp0authentication"

echo =============================================================
echo   Firebase Authentication Module
echo   Project    : my-login-system-9a207
echo   URL        : http://localhost:5000/login.html
echo   Stop server: Press Ctrl+C in this window
echo =============================================================
echo.

REM Detect the Python command (prefer 'python', fall back to 'py -3')
set "PYCMD="
where python >nul 2>nul && set "PYCMD=python"
if not defined PYCMD (
  where py >nul 2>nul && set "PYCMD=py -3"
)
if not defined PYCMD (
  echo [ERROR] Python was not found.
  echo Install it from https://www.python.org/downloads/
  echo Then tick "Add Python to PATH" during install.
  echo.
  pause
  exit /b 1
)

REM Open the browser after a short delay so the server is ready
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:5000/login.html"

REM Run the server in the foreground (Ctrl+C stops it)
%PYCMD% -m http.server 5000

endlocal