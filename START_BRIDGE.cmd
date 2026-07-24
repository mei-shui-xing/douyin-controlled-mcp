@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
if not exist "logs" mkdir "logs" >nul 2>nul
cls
echo ============================================================
echo  Douyin Controlled MCP - Start Bridge v0.1.0-alpha
echo ============================================================
echo Project: %CD%
echo.
if not exist "scripts\start.ps1" (
  echo ERROR: scripts\start.ps1 is missing.
  echo Please extract the whole ZIP again.
  echo.
  pause
  exit /b 2
)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo Bridge launcher finished with exit code %EXIT_CODE%.
if not "%EXIT_CODE%"=="0" echo Open logs\start-error.txt or run DIAGNOSE.cmd.
echo.
pause
exit /b %EXIT_CODE%
