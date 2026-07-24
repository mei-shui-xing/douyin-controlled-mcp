@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install_transcript.ps1"
set "RC=%ERRORLEVEL%"
echo.
echo ================================================================
echo Transcript setup finished with exit code %RC%.
echo ================================================================
pause
exit /b %RC%
