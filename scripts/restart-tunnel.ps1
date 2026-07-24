$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $Root 'runtime\pids.json'
$Stdout = Join-Path $Root 'logs\cloudflared.stdout.log'
$Stderr = Join-Path $Root 'logs\cloudflared.stderr.log'
$Cloudflared = Join-Path $Root 'tools\cloudflared.exe'
$PublicUrlFile = Join-Path $Root 'runtime\PUBLIC_MCP_URL.txt'
$ConnectHtml = Join-Path $Root 'runtime\CONNECT_TO_CHATGPT.html'
$AccessTokenFile = Join-Path $Root 'runtime\MCP_ACCESS_TOKEN.txt'

if (-not (Test-Path $PidFile)) { throw 'runtime\pids.json does not exist.' }
if (-not (Test-Path $Cloudflared)) { throw 'tools\cloudflared.exe does not exist.' }
if (-not (Test-Path $AccessTokenFile)) { throw 'runtime\MCP_ACCESS_TOKEN.txt does not exist.' }
$accessToken = (Get-Content -LiteralPath $AccessTokenFile -Raw -Encoding utf8).Trim()
if ($accessToken.Length -lt 43) { throw 'MCP access token is invalid.' }

$pids = Get-Content $PidFile -Raw | ConvertFrom-Json
$oldUrl = [string]$pids.publicMcpUrl
$oldTunnel = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$pids.tunnelPid)" -ErrorAction SilentlyContinue
if ($oldTunnel -and (
    $oldTunnel.Name -ne 'cloudflared.exe' -or
    -not $oldTunnel.ExecutablePath -or
    ([IO.Path]::GetFullPath($oldTunnel.ExecutablePath) -ne [IO.Path]::GetFullPath($Cloudflared)))) {
    throw 'Refusing to replace an unverified tunnel process.'
}
if ($oldTunnel) { Stop-Process -Id ([int]$oldTunnel.ProcessId) -Force }

Remove-Item -LiteralPath $Stdout, $Stderr -Force -ErrorAction SilentlyContinue
$tunnel = Start-Process -FilePath $Cloudflared `
    -ArgumentList @(
        'tunnel',
        '--no-autoupdate',
        '--protocol',
        'quic',
        '--url',
        'http://127.0.0.1:31337'
    ) `
    -WindowStyle Hidden `
    -RedirectStandardOutput $Stdout `
    -RedirectStandardError $Stderr `
    -PassThru

$newBaseUrl = $null
for ($attempt = 0; $attempt -lt 90; $attempt += 1) {
    if ($tunnel.HasExited) {
        throw 'The replacement Cloudflare tunnel exited before publishing a URL.'
    }
    $logText = ''
    if (Test-Path $Stdout) {
        $logText += Get-Content $Stdout -Raw -ErrorAction SilentlyContinue
    }
    if (Test-Path $Stderr) {
        $logText += Get-Content $Stderr -Raw -ErrorAction SilentlyContinue
    }
    $match = [regex]::Match(
        $logText,
        'https://[a-z0-9-]+\.trycloudflare\.com',
        'IgnoreCase'
    )
    if ($match.Success) {
        $newBaseUrl = $match.Value.TrimEnd('/')
        if ($logText -match 'Registered tunnel connection') { break }
    }
    Start-Sleep -Milliseconds 500
}
if (-not $newBaseUrl) {
    throw 'The replacement Cloudflare tunnel did not publish a URL within 45 seconds.'
}
if ($logText -notmatch 'Registered tunnel connection') {
    if (-not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue }
    throw 'The replacement Cloudflare tunnel published a URL but did not establish an edge connection.'
}

$encodedToken = [Uri]::EscapeDataString($accessToken)
$newUrl = "$newBaseUrl/mcp?access_token=$encodedToken"
$pids.tunnelPid = $tunnel.Id
$pids.publicMcpUrl = $newUrl
$pids | Add-Member -NotePropertyName tunnelRestartedAt `
    -NotePropertyValue (Get-Date).ToString('o') `
    -Force
$pids | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $PidFile -Encoding utf8
[IO.File]::WriteAllText(
    $PublicUrlFile,
    $newUrl + [Environment]::NewLine,
    [Text.UTF8Encoding]::new($true)
)

if (Test-Path $ConnectHtml) {
    $html = Get-Content $ConnectHtml -Raw -Encoding utf8
    $html = $html.Replace($oldUrl, $newUrl)
    [IO.File]::WriteAllText(
        $ConnectHtml,
        $html,
        [Text.UTF8Encoding]::new($true)
    )
}
try { Set-Clipboard -Value $newUrl } catch { }

[pscustomobject]@{
    oldUrl = $oldUrl
    newUrl = $newUrl
    tunnelPid = $tunnel.Id
    mcpPid = $pids.mcpPid
} | ConvertTo-Json
