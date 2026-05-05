param(
    [int]$Port = 8080
)

$ErrorActionPreference = "Stop"

function Get-PythonCommand {
    if (Get-Command py -ErrorAction SilentlyContinue) {
        try {
            & py -3 --version 2>$null 1>$null
            if ($LASTEXITCODE -eq 0) {
                return "py -3"
            }
        }
        catch {
            # Ignore failed launcher detection and continue fallback checks.
        }
    }
    if (Get-Command python -ErrorAction SilentlyContinue) {
        try {
            & python --version 2>$null 1>$null
            if ($LASTEXITCODE -eq 0) {
                return "python"
            }
        }
        catch {
            # Ignore failed launcher detection and return null below.
        }
    }
    return $null
}

$pythonCommand = Get-PythonCommand
if (-not $pythonCommand) {
    Write-Host "Python was not found. Install Python 3 and retry." -ForegroundColor Red
    Write-Host "Download: https://www.python.org/downloads/" -ForegroundColor Yellow
    exit 1
}

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

Write-Host "Serving '$projectRoot' on http://localhost:$Port" -ForegroundColor Green
Write-Host "Press Ctrl+C to stop the server." -ForegroundColor Cyan
Write-Host ""

if ($pythonCommand -eq "py -3") {
    py -3 -m http.server $Port
}
else {
    python -m http.server $Port
}
