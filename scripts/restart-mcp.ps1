$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $Root 'runtime\pids.json'
$Stdout = Join-Path $Root 'logs\mcp.stdout.log'
$Stderr = Join-Path $Root 'logs\mcp.stderr.log'
$DistIndex = Join-Path $Root 'dist\index.js'
$AccessTokenFile = Join-Path $Root 'runtime\MCP_ACCESS_TOKEN.txt'

if (-not (Test-Path $PidFile)) { throw 'runtime\pids.json does not exist.' }
if (-not (Test-Path $DistIndex)) { throw 'dist\index.js does not exist.' }
if (-not (Test-Path $AccessTokenFile)) { throw 'runtime\MCP_ACCESS_TOKEN.txt does not exist.' }
$accessToken = (Get-Content -LiteralPath $AccessTokenFile -Raw -Encoding UTF8).Trim()
if ($accessToken.Length -lt 43) { throw 'MCP access token is invalid.' }

$pids = Get-Content $PidFile -Raw | ConvertFrom-Json
if ($pids.mcpPid) {
    $oldMcp = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$pids.mcpPid)" -ErrorAction SilentlyContinue
    if ($oldMcp) {
        if ($oldMcp.Name -ne 'node.exe' -or
            -not $oldMcp.CommandLine -or
            -not $oldMcp.CommandLine.Contains($DistIndex)) {
            throw "Refusing to stop an MCP PID that is not this project's dist\index.js process."
        }
        Stop-Process -Id ([int]$oldMcp.ProcessId) -Force
    }
}

Remove-Item -LiteralPath $Stdout, $Stderr -Force -ErrorAction SilentlyContinue
$env:MCP_ACCESS_TOKEN = $accessToken
$mcp = Start-Process -FilePath 'node' `
    -ArgumentList @("`"$DistIndex`"", '--http', '--port', '31337') `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $Stdout `
    -RedirectStandardError $Stderr `
    -PassThru

$health = $null
for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:31337/healthz' -TimeoutSec 2
        if ($health.ok -and $health.mcp) { break }
    }
    catch { }
    Start-Sleep -Milliseconds 500
}
if (-not $health.ok) { throw 'Restarted MCP did not become healthy.' }

$pids.mcpPid = $mcp.Id
$pids.startedAt = (Get-Date).ToString('o')
$pids | ConvertTo-Json | Set-Content -Path $PidFile -Encoding UTF8

[pscustomobject]@{
    mcpPid = $mcp.Id
    browserPid = $pids.browserPid
    tunnelPid = $pids.tunnelPid
    publicMcpUrl = $pids.publicMcpUrl
    health = $health
} | ConvertTo-Json -Depth 5
