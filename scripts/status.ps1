[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Root = Split-Path -Parent $PSScriptRoot
$urlFile = Join-Path $Root 'runtime\PUBLIC_MCP_URL.txt'
$tokenFile = Join-Path $Root 'runtime\MCP_ACCESS_TOKEN.txt'
try {
    if (-not (Test-Path $tokenFile)) { throw '缺少访问令牌。' }
    $token = (Get-Content -LiteralPath $tokenFile -Raw -Encoding UTF8).Trim()
    $result = Invoke-RestMethod -Uri 'http://127.0.0.1:31337/healthz/details' `
        -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 3
    $result | ConvertTo-Json -Depth 5
    if (Test-Path $urlFile) {
        $url = (Get-Content $urlFile -Raw).Trim()
        Write-Host "公开 MCP 地址：$url" -ForegroundColor Cyan
        try { Set-Clipboard -Value $url } catch { }
        Write-Host '地址已复制到剪贴板。'
    }
    Start-Process ("http://127.0.0.1:31337/status?access_token=" + [Uri]::EscapeDataString($token))
}
catch { Write-Host '本地 MCP 当前没有运行。请双击 START_BRIDGE.cmd。' -ForegroundColor Yellow }
