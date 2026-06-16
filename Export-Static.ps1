param()

$ErrorActionPreference = "Stop"

function Get-PythonCommand {
    if (Get-Command py -ErrorAction SilentlyContinue) {
        try {
            & py -3 --version 2>$null 1>$null
            if ($LASTEXITCODE -eq 0) {
                return "py -3"
            }
        }
        catch { }
    }
    if (Get-Command python -ErrorAction SilentlyContinue) {
        try {
            & python --version 2>$null 1>$null
            if ($LASTEXITCODE -eq 0) {
                return "python"
            }
        }
        catch { }
    }
    return $null
}

function Wait-ForEnter {
    Write-Host ""
    Read-Host "Press Enter to close"
}

$pythonCommand = Get-PythonCommand
if (-not $pythonCommand) {
    Write-Host "Python was not found. Install Python 3 and retry." -ForegroundColor Red
    Wait-ForEnter
    exit 1
}

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

if ($pythonCommand -eq "py -3") {
    py -3 export-static.py
}
else {
    python export-static.py
}

$exitCode = $LASTEXITCODE
Wait-ForEnter
exit $exitCode
