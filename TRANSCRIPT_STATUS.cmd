@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$p=Join-Path '%~dp0' 'runtime\TRANSCRIPT_PYTHON.txt'; if(Test-Path $p){$py=(Get-Content $p -Raw).Trim(); Write-Host ('Local transcript Python: '+$py) -ForegroundColor Green; & $py -c \"import faster_whisper; print('faster-whisper ready')\"} else {Write-Host 'Transcript component is not installed. Run INSTALL_TRANSCRIPT.cmd.' -ForegroundColor Yellow}"
pause
