@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
if not exist "logs" mkdir "logs" >nul 2>nul
set "LOG=%~dp0logs\diagnose.txt"
(
  echo Douyin Read-Only MCP v0.1.4 diagnosis
  echo Date: %DATE% %TIME%
  echo Root: %CD%
  echo.
  if exist "scripts\setup.ps1" (echo [OK] scripts\setup.ps1) else (echo [MISSING] scripts\setup.ps1)
  if exist "scripts\start.ps1" (echo [OK] scripts\start.ps1) else (echo [MISSING] scripts\start.ps1)
  if exist "dist\index.js" (echo [OK] dist\index.js) else (echo [MISSING] dist\index.js)
  if exist "node_modules\playwright-core\package.json" (echo [OK] offline node_modules) else (echo [MISSING] offline node_modules)
  if exist "tools\cloudflared.exe" (echo [OK] tools\cloudflared.exe) else (echo [NOT READY] tools\cloudflared.exe)
  echo.
  where powershell.exe 2^>nul
  if errorlevel 1 (echo [MISSING] powershell.exe) else (echo [OK] powershell.exe)
  where node.exe 2^>nul
  if errorlevel 1 (echo [MISSING] node.exe) else (node --version)
  where cloudflared.exe 2^>nul
  if errorlevel 1 (echo [PATH] cloudflared not found) else (cloudflared --version)
  echo.
  if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (echo [OK] Chrome) else if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" (echo [OK] Chrome) else if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (echo [OK] Edge) else (echo [MISSING] Chrome or Edge)
  echo.
  echo Last setup error:
  if exist "logs\setup-error.txt" (type "logs\setup-error.txt") else (echo none)
  echo.
  echo Last start error:
  if exist "logs\start-error.txt" (type "logs\start-error.txt") else (echo none)
  echo.
  echo Public URL:
  if exist "runtime\PUBLIC_MCP_URL.txt" (type "runtime\PUBLIC_MCP_URL.txt") else (echo none)
) > "%LOG%" 2>&1
cls
type "%LOG%"
echo.
echo Diagnosis saved to: %LOG%
echo.
pause
exit /b 0
