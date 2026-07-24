@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
cls
if not exist "scripts\status.ps1" (
  echo ERROR: scripts\status.ps1 is missing.
  pause
  exit /b 2
)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\status.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
pause
exit /b %EXIT_CODE%
