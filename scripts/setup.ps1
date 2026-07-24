$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Split-Path -Parent $PSScriptRoot
$ToolsDir = Join-Path $Root 'tools'
$RuntimeDir = Join-Path $Root 'runtime'
$LogsDir = Join-Path $Root 'logs'
$CloudflaredExe = Join-Path $ToolsDir 'cloudflared.exe'

New-Item -ItemType Directory -Force -Path $ToolsDir, $RuntimeDir, $LogsDir | Out-Null
$TranscriptStarted = $false
try {
    Start-Transcript -Path (Join-Path $LogsDir 'setup-transcript.log') -Append -Force | Out-Null
    $TranscriptStarted = $true
}
catch { }

function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

function Ensure-Node {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        $winget = Get-Command winget -ErrorAction SilentlyContinue
        if (-not $winget) {
            Start-Process 'https://nodejs.org/'
            throw '没有检测到 Node.js。已打开 Node.js 官网；安装 LTS 后重新运行 START_HERE_SETUP.cmd。'
        }
        Write-Host '正在安装 Node.js LTS……' -ForegroundColor Cyan
        & winget install --id OpenJS.NodeJS.LTS --exact --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) { throw "winget 安装 Node.js 失败，错误代码 $LASTEXITCODE。" }
        Refresh-Path
    }

    $versionText = (& node --version).Trim().TrimStart('v')
    $major = [int]($versionText.Split('.')[0])
    if ($major -lt 20) { throw "Node.js 版本过低（$versionText），需要 20 或更高版本。" }
    Write-Host "Node.js $versionText 已就绪。" -ForegroundColor Green
}

function Test-BundledRuntime {
    $required = @(
        (Join-Path $Root 'node_modules\playwright-core\package.json'),
        (Join-Path $Root 'node_modules\express\package.json'),
        (Join-Path $Root 'node_modules\zod\package.json'),
        (Join-Path $Root 'node_modules\@modelcontextprotocol\sdk\package.json'),
        (Join-Path $Root 'dist\index.js')
    )
    foreach ($item in $required) { if (-not (Test-Path $item)) { return $false } }
    Push-Location $Root
    try {
        & node -e "Promise.all([import('playwright-core'),import('express'),import('zod'),import('@modelcontextprotocol/sdk/server/mcp.js')]).then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})"
        return ($LASTEXITCODE -eq 0)
    }
    finally { Pop-Location }
}

function Ensure-ProjectRuntime {
    Write-Host '正在检查 Node.js 依赖和构建结果……' -ForegroundColor Cyan
    if (Test-BundledRuntime) {
        Write-Host '依赖和构建结果已就绪。' -ForegroundColor Green
        return
    }
    Push-Location $Root
    try {
        Write-Host '根据 package-lock.json 执行 npm ci……' -ForegroundColor Cyan
        & npm ci
        if ($LASTEXITCODE -ne 0) { throw "npm ci 失败，错误代码 $LASTEXITCODE。" }
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build 失败，错误代码 $LASTEXITCODE。" }
    }
    finally { Pop-Location }
    if (-not (Test-BundledRuntime)) { throw '依赖安装或 TypeScript 构建完成后自检仍未通过。' }
    Write-Host '依赖安装和构建完成。' -ForegroundColor Green
}

function Test-Cloudflared([string]$Path) {
    if (-not $Path -or -not (Test-Path $Path)) { return $false }
    try {
        & $Path --version | Out-Null
        return ($LASTEXITCODE -eq 0)
    }
    catch { return $false }
}

function Find-ExistingCloudflared {
    $command = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
    if ($command -and (Test-Cloudflared $command.Source)) { return $command.Source }

    $candidates = @(
        "$env:ProgramFiles\cloudflared\cloudflared.exe",
        "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe",
        "$env:LOCALAPPDATA\Programs\cloudflared\cloudflared.exe",
        "$env:USERPROFILE\.cloudflared\cloudflared.exe",
        (Join-Path $Root 'tools\cloudflared-windows-amd64.exe')
    )
    foreach ($candidate in $candidates) {
        if (Test-Cloudflared $candidate) { return $candidate }
    }

    return $null
}

function Ensure-Cloudflared {
    if (Test-Cloudflared $CloudflaredExe) {
        Write-Host 'Cloudflare Tunnel 客户端已就绪。' -ForegroundColor Green
        return
    }

    Write-Host '正在查找已安装的 cloudflared……' -ForegroundColor Cyan
    $found = Find-ExistingCloudflared
    if ($found) {
        Copy-Item $found $CloudflaredExe -Force
        Write-Host "已复用：$found" -ForegroundColor Green
        return
    }

    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        Write-Host '没有找到旧文件，尝试通过 winget 安装 cloudflared……' -ForegroundColor Cyan
        & winget install --id Cloudflare.cloudflared --exact --accept-source-agreements --accept-package-agreements
        Refresh-Path
        $found = Find-ExistingCloudflared
        if ($LASTEXITCODE -eq 0 -and $found) {
            Copy-Item $found $CloudflaredExe -Force
            Write-Host 'cloudflared 安装完成。' -ForegroundColor Green
            return
        }
    }

    Start-Process 'https://github.com/cloudflare/cloudflared/releases/latest'
    throw '没有找到 cloudflared.exe。已打开 Cloudflare 官方发布页：下载 cloudflared-windows-amd64.exe，改名为 cloudflared.exe，放进 tools 文件夹后重新运行。'
}

try {
    Ensure-Node
    Ensure-ProjectRuntime
    Ensure-Cloudflared

    $privateConfigDir = Join-Path $Root 'runtime\private-config'
    New-Item -ItemType Directory -Path $privateConfigDir -Force | Out-Null

    Write-Host ''
    Write-Host '配置完成。默认使用 Cloudflare Quick Tunnel，不需要 Cloudflare 账号或 Tunnel ID。' -ForegroundColor Green
    Write-Host '以后双击 START_BRIDGE.cmd 即可启动。首次启动后，会自动把公开 MCP 地址复制到剪贴板。'
    Write-Host '长教程/知识视频需要本地字幕时，再双击 INSTALL_TRANSCRIPT.cmd；这一步可稍后做。' -ForegroundColor Yellow
    Write-Host '首次连接后直接告诉 AI“请帮我完成抖音首次配置”。AI 会识别当前登录账号、询问别名和权限，再写入不会进入 Git 的 runtime\private-config。' -ForegroundColor Yellow
    Write-Host '安装器不会创建占位配置，也不会覆盖已有私有配置。' -ForegroundColor Yellow
    Remove-Item (Join-Path $LogsDir 'setup-error.txt') -Force -ErrorAction SilentlyContinue
    Write-Host ''
    $startNow = Read-Host '现在启动吗？直接回车表示启动，输入 n 暂不启动'
    if ($startNow -ne 'n') { & (Join-Path $PSScriptRoot 'start.ps1') }
}
catch {
    $message = @(
        '首次安装失败。',
        ('时间：' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')),
        ('错误：' + $_.Exception.Message),
        '',
        '请双击 DIAGNOSE.cmd，或打开 logs\setup-transcript.log。'
    ) -join [Environment]::NewLine
    $message | Set-Content -Path (Join-Path $LogsDir 'setup-error.txt') -Encoding UTF8
    Write-Host ''
    Write-Host $message -ForegroundColor Red
    exit 1
}
finally {
    if ($TranscriptStarted) { try { Stop-Transcript | Out-Null } catch { } }
}
