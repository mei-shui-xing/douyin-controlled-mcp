@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
cls
echo Stopping Douyin Read-Only MCP bridge...
if not exist "scripts\stop.ps1" (
  echo ERROR: scripts\stop.ps1 is missing.
  pause
  exit /b 2
)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo Stop finished with exit code %EXIT_CODE%.
echo.
pause
exit /b %EXIT_CODE%
