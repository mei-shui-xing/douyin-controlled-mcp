@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
if not exist "logs" mkdir "logs" >nul 2>nul
cls
echo ============================================================
echo  Douyin Controlled MCP - First Setup v0.1.0-alpha
echo ============================================================
echo Project: %CD%
echo.
if not exist "scripts\setup.ps1" (
  echo ERROR: scripts\setup.ps1 is missing.
  echo Please extract the whole ZIP again.
  echo.
  pause
  exit /b 2
)
if not exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" (
  echo ERROR: Windows PowerShell was not found.
  echo.
  pause
  exit /b 3
)
echo This window will stay open even if setup fails.
echo Detailed log: logs\setup-transcript.log
echo.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo ============================================================
echo Setup finished with exit code %EXIT_CODE%.
if not "%EXIT_CODE%"=="0" echo Open logs\setup-error.txt or run DIAGNOSE.cmd.
echo ============================================================
echo.
pause
exit /b %EXIT_CODE%
