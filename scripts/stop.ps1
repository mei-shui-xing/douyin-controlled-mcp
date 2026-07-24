$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Root = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $Root 'runtime\pids.json'
$ProfileDir = Join-Path $Root 'runtime\browser-profile'
$RootCommentProfileDir = Join-Path $Root 'runtime\operator_root_comment_clean'
$CloudflaredExe = Join-Path $Root 'tools\cloudflared.exe'
$DistIndex = Join-Path $Root 'dist\index.js'

function Stop-RecordedOwnedProcess([object]$PidValue, [string]$Role) {
    if (-not $PidValue) { return }
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$PidValue)"
    if (-not $candidate) { return }
    $owned = switch ($Role) {
        'mcp' { $candidate.Name -eq 'node.exe' -and $candidate.CommandLine -and $candidate.CommandLine.Contains($DistIndex) }
        'tunnel' { $candidate.Name -eq 'cloudflared.exe' -and $candidate.ExecutablePath -and ([IO.Path]::GetFullPath($candidate.ExecutablePath) -eq [IO.Path]::GetFullPath($CloudflaredExe)) }
        'browser' { ($candidate.Name -eq 'chrome.exe' -or $candidate.Name -eq 'msedge.exe') -and $candidate.CommandLine -and $candidate.CommandLine.Contains($ProfileDir) }
        default { $false }
    }
    if ($owned) { Stop-Process -Id ([int]$PidValue) -Force }
}
if (Test-Path $PidFile) {
    try {
        $pids = Get-Content $PidFile -Raw | ConvertFrom-Json
        Stop-RecordedOwnedProcess $pids.tunnelPid 'tunnel'
        Stop-RecordedOwnedProcess $pids.mcpPid 'mcp'
        Stop-RecordedOwnedProcess $pids.browserPid 'browser'
    }
    catch { }
    Remove-Item $PidFile -Force
}
Get-CimInstance Win32_Process | Where-Object {
    ($_.CommandLine -like "*$ProfileDir*") -or
    ($_.CommandLine -like "*$RootCommentProfileDir*") -or
    ($_.CommandLine -like "*$Root*dist*index.js*") -or
    ($_.ExecutablePath -like "*$Root*tools*cloudflared.exe")
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Write-Host '抖音受控桥已停止；专用浏览器登录态仍保留。下次启动会生成新的或复用当次 Quick Tunnel 地址。' -ForegroundColor Green
Start-Sleep -Seconds 2
