param(
    [string]$S3Bucket = "baffledcat.com",
    [string]$S3Prefix = "highpersonic3/",
    [switch]$SkipUpload
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

function Get-LatestExportDir {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ExportRoot
    )

    if (-not (Test-Path -LiteralPath $ExportRoot)) {
        return $null
    }

    $latest = Get-ChildItem -LiteralPath $ExportRoot -Directory |
        Where-Object { $_.Name -match '^Version\d+$' } |
        Sort-Object { [int]($_.Name -replace '^Version', '') } -Descending |
        Select-Object -First 1

    if (-not $latest) {
        return $null
    }
    return $latest.FullName
}

function Normalize-S3Prefix {
    param(
        [string]$Prefix
    )

    $normalized = ""
    if ($null -ne $Prefix) {
        $normalized = $Prefix.Trim()
    }
    if ($normalized.StartsWith("/")) {
        $normalized = $normalized.TrimStart("/")
    }
    if ($normalized -and -not $normalized.EndsWith("/")) {
        $normalized += "/"
    }
    return $normalized
}

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)]
        [scriptblock]$Command,
        [Parameter(Mandatory = $true)]
        [string]$ErrorMessage
    )

    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw $ErrorMessage
    }
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
if ($exitCode -ne 0) {
    Wait-ForEnter
    exit $exitCode
}

if ($SkipUpload) {
    Write-Host ""
    Write-Host "Skipping S3 upload because -SkipUpload was provided." -ForegroundColor Yellow
    Wait-ForEnter
    exit 0
}

if (-not $S3Bucket) {
    Write-Host ""
    Write-Host "S3 bucket not provided." -ForegroundColor Red
    Wait-ForEnter
    exit 1
}

if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "AWS CLI was not found. Install AWS CLI v2 and retry." -ForegroundColor Red
    Wait-ForEnter
    exit 1
}

$exportRoot = Join-Path $projectRoot "Export"
$exportDir = Get-LatestExportDir -ExportRoot $exportRoot
if (-not $exportDir) {
    Write-Host ""
    Write-Host "Could not find exported Version folder under '$exportRoot'." -ForegroundColor Red
    Wait-ForEnter
    exit 1
}

$normalizedPrefix = Normalize-S3Prefix -Prefix $S3Prefix
$s3Base = "s3://$S3Bucket/$normalizedPrefix"
$indexPath = Join-Path $exportDir "index.html"
$s3Index = "$s3Base" + "index.html"

Write-Host ""
Write-Host "Uploading export to $s3Base" -ForegroundColor Cyan
Write-Host "Source: $exportDir"

try {
    Write-Host ""
    Write-Host "1/3 Upload long-cache assets..." -ForegroundColor Green
    Invoke-CheckedCommand -Command {
        aws s3 sync "$exportDir" "$s3Base" --delete --cache-control "public, max-age=31536000, immutable" --exclude "index.html" --exclude "*.js"
    } -ErrorMessage "Failed uploading long-cache assets."

    Write-Host ""
    Write-Host "2/3 Upload index.html with 60s cache..." -ForegroundColor Green
    Invoke-CheckedCommand -Command {
        aws s3 cp "$indexPath" "$s3Index" --cache-control "public, max-age=60"
    } -ErrorMessage "Failed uploading index.html."

    Write-Host ""
    Write-Host "3/3 Upload JS files with 60s cache..." -ForegroundColor Green
    Invoke-CheckedCommand -Command {
        aws s3 sync "$exportDir" "$s3Base" --exclude "*" --include "*.js" --cache-control "public, max-age=60"
    } -ErrorMessage "Failed uploading JavaScript files."

    Write-Host ""
    Write-Host "Upload complete." -ForegroundColor Green
}
catch {
    Write-Host ""
    Write-Host $_.Exception.Message -ForegroundColor Red
    Wait-ForEnter
    exit 1
}

Wait-ForEnter
exit 0
