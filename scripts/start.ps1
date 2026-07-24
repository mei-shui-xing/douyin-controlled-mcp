$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Split-Path -Parent $PSScriptRoot
$RuntimeDir = Join-Path $Root 'runtime'
$LogsDir = Join-Path $Root 'logs'
$ToolsDir = Join-Path $Root 'tools'
$CloudflaredExe = Join-Path $ToolsDir 'cloudflared.exe'
$PidFile = Join-Path $RuntimeDir 'pids.json'
$ProfileDir = Join-Path $RuntimeDir 'browser-profile'
$PublicUrlFile = Join-Path $RuntimeDir 'PUBLIC_MCP_URL.txt'
$ConnectHtml = Join-Path $RuntimeDir 'CONNECT_TO_CHATGPT.html'
$AccessTokenFile = Join-Path $RuntimeDir 'MCP_ACCESS_TOKEN.txt'
$McpPort = 31337
$ExpectedCloudflaredSha256 = $env:DOUYIN_CLOUDFLARED_SHA256
$browserProcess = $null
$mcpProcess = $null
$tunnelProcess = $null
$startedBrowserThisRun = $false

New-Item -ItemType Directory -Force -Path $RuntimeDir, $LogsDir, $ProfileDir | Out-Null
$TranscriptStarted = $false
try {
    Start-Transcript -Path (Join-Path $LogsDir 'start-transcript.log') -Append -Force | Out-Null
    $TranscriptStarted = $true
}
catch { }

function Find-Browser {
    $candidates = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
    )
    foreach ($candidate in $candidates) { if ($candidate -and (Test-Path $candidate)) { return $candidate } }
    return $null
}

function Wait-Health([string]$AccessToken, [int]$Seconds = 15) {
    for ($i = 0; $i -lt $Seconds * 2; $i++) {
        try {
            $health = Invoke-RestMethod `
                -Uri "http://127.0.0.1:$McpPort/healthz" `
                -TimeoutSec 2
            if ($health.ok -and $health.mcp) { return $true }
        }
        catch { }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Get-OrCreateAccessToken {
    if (Test-Path $AccessTokenFile) {
        $saved = (Get-Content -LiteralPath $AccessTokenFile -Raw -Encoding UTF8).Trim()
        if ($saved.Length -ge 43) { return $saved }
    }
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    [IO.File]::WriteAllText($AccessTokenFile, $token + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    return $token
}

function Get-TokenFingerprint([string]$Token) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Token)) } finally { $sha.Dispose() }
    return (($hash | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 12)
}

function Wait-Cdp([int]$Seconds = 20) {
    for ($i = 0; $i -lt $Seconds * 2; $i++) {
        try {
            $version = Invoke-RestMethod -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 2
            if ($version.webSocketDebuggerUrl) { return $true }
        }
        catch { }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Find-ProfileBrowserPid {
    $match = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe') -and
        $_.CommandLine -and
        $_.CommandLine.Contains($ProfileDir)
    } | Sort-Object CreationDate | Select-Object -First 1
    if ($match) { return [int]$match.ProcessId }
    return $null
}

function Stop-RecordedOwnedProcess([object]$PidValue, [string]$Role) {
    if (-not $PidValue) { return }
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$PidValue)" -ErrorAction SilentlyContinue
    if (-not $candidate) { return }
    $owned = switch ($Role) {
        'mcp' {
            $candidate.Name -eq 'node.exe' -and
            $candidate.CommandLine -and
            $candidate.CommandLine.Contains((Join-Path $Root 'dist\index.js'))
        }
        'tunnel' {
            $candidate.Name -eq 'cloudflared.exe' -and
            $candidate.ExecutablePath -and
            ([IO.Path]::GetFullPath($candidate.ExecutablePath) -eq [IO.Path]::GetFullPath($CloudflaredExe))
        }
        'browser' {
            ($candidate.Name -eq 'chrome.exe' -or $candidate.Name -eq 'msedge.exe') -and
            $candidate.CommandLine -and
            $candidate.CommandLine.Contains($ProfileDir)
        }
        default { $false }
    }
    if (-not $owned) {
        Write-Warning "忽略已复用的 PID $PidValue：它不属于本项目的 $Role 进程。"
        return
    }
    Stop-Process -Id ([int]$PidValue) -Force -ErrorAction SilentlyContinue
}

function Wait-QuickTunnelUrl($Process, [int]$Seconds = 45) {
    $outFile = Join-Path $LogsDir 'cloudflared.stdout.log'
    $errFile = Join-Path $LogsDir 'cloudflared.stderr.log'
    $publishedUrl = $null
    for ($i = 0; $i -lt $Seconds * 2; $i++) {
        if ($Process.HasExited) {
            $details = ''
            if (Test-Path $errFile) { $details = (Get-Content $errFile -Raw -ErrorAction SilentlyContinue) }
            throw "Cloudflare Tunnel 已退出。$details"
        }
        $text = ''
        if (Test-Path $outFile) { $text += (Get-Content $outFile -Raw -ErrorAction SilentlyContinue) }
        if (Test-Path $errFile) { $text += "`n" + (Get-Content $errFile -Raw -ErrorAction SilentlyContinue) }
        $match = [regex]::Match($text, 'https://[a-z0-9-]+\.trycloudflare\.com', 'IgnoreCase')
        if ($match.Success) { $publishedUrl = $match.Value.TrimEnd('/') }
        if ($publishedUrl -and $text -match 'Registered tunnel connection') {
            return $publishedUrl
        }
        Start-Sleep -Milliseconds 500
    }
    if ($publishedUrl) {
        throw '已拿到 trycloudflare.com 地址，但 45 秒内没有建立 Cloudflare edge 连接。'
    }
    throw '45 秒内没有拿到 trycloudflare.com 地址。请查看 logs\cloudflared.stderr.log。'
}

function Start-QuickTunnelWithRetry([int]$Attempts = 4) {
    $outFile = Join-Path $LogsDir 'cloudflared.stdout.log'
    $errFile = Join-Path $LogsDir 'cloudflared.stderr.log'
    $lastError = $null
    for ($attempt = 1; $attempt -le $Attempts; $attempt += 1) {
        Remove-Item $outFile, $errFile -Force -ErrorAction SilentlyContinue
        $process = Start-Process -FilePath $CloudflaredExe `
            -ArgumentList @('tunnel', '--no-autoupdate', '--protocol', 'quic', '--url', "http://127.0.0.1:$McpPort") `
            -WindowStyle Minimized `
            -RedirectStandardOutput $outFile `
            -RedirectStandardError $errFile `
            -PassThru
        try {
            $url = Wait-QuickTunnelUrl $process 45
            return [pscustomobject]@{ Process = $process; Url = $url }
        }
        catch {
            $lastError = $_.Exception.Message
            if (-not $process.HasExited) {
                Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            }
            if ($attempt -lt $Attempts) { Start-Sleep -Seconds ([Math]::Min(2 * $attempt, 6)) }
        }
    }
    throw "Cloudflare Quick Tunnel 连续 $Attempts 次启动失败。最后错误：$lastError"
}

function Write-ConnectPage([string]$McpUrl) {
    $safeUrl = [System.Net.WebUtility]::HtmlEncode($McpUrl)
    $html = @"
<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>连接抖音受控 MCP</title>
<style>body{font-family:system-ui;margin:48px;max-width:900px;line-height:1.7;background:#fafafa;color:#222}main{background:white;padding:32px;border-radius:18px;box-shadow:0 8px 30px #0001}code{display:block;padding:16px;background:#f4f4f4;border-radius:10px;word-break:break-all;font-size:18px}.warn{color:#9a3412}</style>
<main><h1>抖音受控桥已经启动</h1><p>下面这个地址已经复制到剪贴板。把它粘贴到 ChatGPT 的自定义 MCP / 应用地址中：</p><code>$safeUrl</code><p>读取能力默认开放；账号写操作只允许专用白名单工具和 runtime\private-config\douyin_social_actions.json 中的精确社交动作。</p><p class="warn">地址包含访问令牌，请勿转发、截图公开或写入聊天记录之外的共享文档。Quick Tunnel 地址每次启动可能变化，变化后请重新连接。</p></main></html>
"@
    [System.IO.File]::WriteAllText($ConnectHtml, $html, (New-Object System.Text.UTF8Encoding($true)))
}

try {
    if (-not (Test-Path (Join-Path $Root 'dist\index.js'))) { throw '缺少 dist\index.js，请先运行 START_HERE_SETUP.cmd。' }
    if (-not (Test-Path $CloudflaredExe)) { throw '缺少 tools\cloudflared.exe，请先运行 START_HERE_SETUP.cmd。' }
    $cloudflaredHash = (Get-FileHash -LiteralPath $CloudflaredExe -Algorithm SHA256).Hash
    if ($ExpectedCloudflaredSha256 -and $cloudflaredHash -ne $ExpectedCloudflaredSha256) {
        throw "tools\cloudflared.exe 校验失败。expected=$ExpectedCloudflaredSha256 actual=$cloudflaredHash"
    }
    $AccessToken = Get-OrCreateAccessToken

    if (Test-Path $PidFile) {
        try {
            $old = Get-Content $PidFile -Raw | ConvertFrom-Json
            Stop-RecordedOwnedProcess $old.mcpPid 'mcp'
            Stop-RecordedOwnedProcess $old.tunnelPid 'tunnel'
            Stop-RecordedOwnedProcess $old.browserPid 'browser'
        }
        catch { }
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    }

    $browserExe = Find-Browser
    if (-not $browserExe) { throw '没有找到 Chrome 或 Edge。请先安装其中一个。' }

    $browserArgs = @(
        '--remote-debugging-port=9222',
        '--remote-allow-origins=http://127.0.0.1:9222,http://localhost:9222',
        ('--user-data-dir="' + $ProfileDir + '"'),
        '--no-first-run',
        '--no-default-browser-check',
        'https://www.douyin.com/'
    )
    $browserProcess = Start-Process -FilePath $browserExe -ArgumentList $browserArgs -PassThru
    $startedBrowserThisRun = $true
    if (-not (Wait-Cdp 20)) {
        $exitDetail = if ($browserProcess.HasExited) { "浏览器启动进程已退出，退出码 $($browserProcess.ExitCode)。" } else { '浏览器进程仍在，但调试端口不可用。' }
        throw "专用浏览器没有正常启动：$exitDetail"
    }
    $profileBrowserPid = Find-ProfileBrowserPid
    if (-not $profileBrowserPid) { $profileBrowserPid = $browserProcess.Id }

    $mcpOut = Join-Path $LogsDir 'mcp.stdout.log'
    $mcpErr = Join-Path $LogsDir 'mcp.stderr.log'
    Remove-Item $mcpOut, $mcpErr -Force -ErrorAction SilentlyContinue
    $distIndex = Join-Path $Root 'dist\index.js'
    $env:MCP_ACCESS_TOKEN = $AccessToken
    $mcpProcess = Start-Process -FilePath 'node' -ArgumentList @(('"' + $distIndex + '"'), '--http', '--port', "$McpPort") -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $mcpOut -RedirectStandardError $mcpErr -PassThru
    if (-not (Wait-Health $AccessToken 15)) { throw '本地 MCP 没有正常启动。请查看 logs\mcp.stderr.log。' }

    $tunnel = Start-QuickTunnelWithRetry
    $tunnelProcess = $tunnel.Process
    $publicBaseUrl = $tunnel.Url
    $encodedToken = [Uri]::EscapeDataString($AccessToken)
    $publicMcpUrl = "$publicBaseUrl/mcp?access_token=$encodedToken"

    [System.IO.File]::WriteAllText($PublicUrlFile, $publicMcpUrl + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($true)))
    try { Set-Clipboard -Value $publicMcpUrl } catch { }
    Write-ConnectPage $publicMcpUrl

    @{
        browserPid = $profileBrowserPid
        mcpPid = $mcpProcess.Id
        tunnelPid = $tunnelProcess.Id
        startedAt = (Get-Date).ToString('o')
        profileDir = $ProfileDir
        publicMcpUrl = $publicMcpUrl
        accessTokenFingerprint = Get-TokenFingerprint $AccessToken
    } | ConvertTo-Json | Set-Content -Path $PidFile -Encoding UTF8

    Remove-Item (Join-Path $LogsDir 'start-error.txt') -Force -ErrorAction SilentlyContinue
    Write-Host ''
    Write-Host '抖音受控桥已启动。' -ForegroundColor Green
    Write-Host "私密 MCP 地址：$publicMcpUrl" -ForegroundColor Cyan
    Write-Host '地址已复制到剪贴板；其中包含访问令牌，请勿转发或截图公开。Quick Tunnel 地址每次启动可能变化，变化后请重新连接。第一次在专用浏览器里扫码登录抖音。'
    Write-Host '关闭桥：双击 STOP_BRIDGE.cmd。'
    Start-Process $ConnectHtml
}
catch {
    if ($tunnelProcess -and -not $tunnelProcess.HasExited) {
        Stop-Process -Id $tunnelProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if ($mcpProcess -and -not $mcpProcess.HasExited) {
        Stop-Process -Id $mcpProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if ($startedBrowserThisRun) {
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
            ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe') -and
            $_.CommandLine -and
            $_.CommandLine.Contains($ProfileDir)
        } | ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
    $message = @(
        '启动失败。',
        ('时间：' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')),
        ('错误：' + $_.Exception.Message),
        '',
        '请双击 DIAGNOSE.cmd，或打开 logs\start-transcript.log。'
    ) -join [Environment]::NewLine
    $message | Set-Content -Path (Join-Path $LogsDir 'start-error.txt') -Encoding UTF8
    Write-Host ''
    Write-Host $message -ForegroundColor Red
    exit 1
}
finally {
    if ($TranscriptStarted) { try { Stop-Transcript | Out-Null } catch { } }
}
