$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Split-Path -Parent $PSScriptRoot
$RuntimeDir = Join-Path $Root 'runtime'
$LogsDir = Join-Path $Root 'logs'
$VenvDir = Join-Path $RuntimeDir 'transcript-venv'
$PythonFile = Join-Path $RuntimeDir 'TRANSCRIPT_PYTHON.txt'
$LogFile = Join-Path $LogsDir 'transcript-install.log'
$ErrorFile = Join-Path $LogsDir 'transcript-install-error.txt'
New-Item -ItemType Directory -Force -Path $RuntimeDir, $LogsDir | Out-Null

try { Start-Transcript -Path $LogFile -Append -Force | Out-Null } catch { }

function Find-Python {
    $managedRoots = @(
        (Join-Path $env:APPDATA 'uv\python\cpython-3.12*-windows-x86_64-none\python.exe'),
        (Join-Path $env:APPDATA 'uv\python\cpython-3.11*-windows-x86_64-none\python.exe'),
        (Join-Path $env:USERPROFILE '.local\bin\python3.11.exe')
    )
    foreach ($pattern in $managedRoots) {
        $candidate = Get-Item -Path $pattern -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($candidate) { return $candidate.FullName }
    }
    $uv = Get-Command uv.exe -ErrorAction SilentlyContinue
    if ($uv) {
        foreach ($version in @('3.12', '3.11', '3.10')) {
            $candidate = (& $uv.Source python find $version 2>$null | Select-Object -First 1)
            if ($LASTEXITCODE -eq 0 -and $candidate -and (Test-Path $candidate)) {
                return [string]$candidate
            }
        }
    }
    $py = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($py) {
        foreach ($version in @('3.12', '3.11', '3.10')) {
            $candidate = (& $py.Source "-V:$version" -c "import sys; print(sys.executable)" 2>$null | Select-Object -First 1)
            if ($LASTEXITCODE -eq 0 -and $candidate -and (Test-Path $candidate)) {
                return [string]$candidate
            }
        }
    }
    foreach ($name in @('python.exe', 'python3.exe')) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd) {
            & $cmd.Source -c "import sys; print(sys.version_info[:2])" 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) { return [string]$cmd.Source }
        }
    }
    return $null
}

function Invoke-BasePython($base, $arguments) {
    & $base @arguments
    return $LASTEXITCODE
}

try {
    $base = Find-Python
    if (-not $base) {
        $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
        if ($winget) {
            Write-Host 'Python 3.10-3.12 was not found. Installing Python 3.12...' -ForegroundColor Cyan
            & $winget.Source install --id Python.Python.3.12 --exact --accept-source-agreements --accept-package-agreements
            if ($LASTEXITCODE -ne 0) { throw "winget failed to install Python (exit code $LASTEXITCODE)." }
            $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path', 'User')
            $base = Find-Python
        }
    }
    if (-not $base) {
        throw 'Python 3.10-3.12 was not found. Install Python and run INSTALL_TRANSCRIPT.cmd again.'
    }

    if (-not (Test-Path (Join-Path $VenvDir 'Scripts\python.exe'))) {
        Write-Host 'Creating the isolated transcript environment...' -ForegroundColor Cyan
        $code = Invoke-BasePython $base @('-m', 'venv', $VenvDir)
        if ($code -ne 0) { throw "Failed to create the Python virtual environment (exit code $code)." }
    }

    $VenvPython = Join-Path $VenvDir 'Scripts\python.exe'
    $mirrors = @(
        @('https://pypi.org/simple', ''),
        @('https://pypi.tuna.tsinghua.edu.cn/simple', 'pypi.tuna.tsinghua.edu.cn'),
        @('https://mirrors.aliyun.com/pypi/simple', 'mirrors.aliyun.com')
    )
    $installed = $false
    foreach ($mirror in $mirrors) {
        Write-Host ("Installing faster-whisper from " + $mirror[0] + "...") -ForegroundColor Cyan
        $pipArgs = @(
            '-m', 'pip', 'install', '--disable-pip-version-check', '--no-warn-script-location',
            'faster-whisper==1.2.1', '-i', $mirror[0]
        )
        if ($mirror[1]) { $pipArgs += @('--trusted-host', $mirror[1]) }
        & $VenvPython @pipArgs
        if ($LASTEXITCODE -eq 0) { $installed = $true; break }
    }
    if (-not $installed) {
        throw 'faster-whisper installation failed. Check the network/proxy and logs\transcript-install.log.'
    }

    & $VenvPython -c "import faster_whisper, av, ctranslate2; print('faster-whisper runtime OK')"
    if ($LASTEXITCODE -ne 0) { throw 'Transcript environment import verification failed.' }

    [System.IO.File]::WriteAllText(
        $PythonFile,
        $VenvPython + [Environment]::NewLine,
        (New-Object System.Text.UTF8Encoding($false))
    )
    Remove-Item -LiteralPath $ErrorFile -Force -ErrorAction SilentlyContinue
    Write-Host ''
    Write-Host 'Local transcript component installed successfully.' -ForegroundColor Green
    Write-Host 'The first transcription downloads a model; later runs reuse the local cache.'
    Write-Host 'GPU inference falls back to CPU int8 if CUDA inference is unavailable.'
    exit 0
}
catch {
    $message = @(
        'Local transcript component installation failed.',
        ('Time: ' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')),
        ('Error: ' + $_.Exception.Message),
        '',
        'Full log: logs\transcript-install.log'
    ) -join [Environment]::NewLine
    $message | Set-Content -LiteralPath $ErrorFile -Encoding UTF8
    Write-Host $message -ForegroundColor Red
    exit 1
}
finally {
    try { Stop-Transcript | Out-Null } catch { }
}
