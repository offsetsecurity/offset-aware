# Require Administrator privileges
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "ERROR: This update script must be run as Administrator!" -ForegroundColor Red
    Write-Host "Please right-click update.bat and select 'Run as Administrator'." -ForegroundColor Yellow
    Read-Host "Press Enter to exit..." | Out-Null
    exit
}

$script:SourceDir = $PSScriptRoot
$script:TargetDir = "C:\Program Files\Offset Security\ISO Training Portal"

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "       OFFSET AWARE - UPDATER" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path $script:TargetDir)) {
    Write-Host "ERROR: Could not find existing installation at $script:TargetDir" -ForegroundColor Red
    Write-Host "Please run the full setup.bat installer for fresh installations." -ForegroundColor Yellow
    exit
}

Write-Host "[1/4] Stopping background service to release file locks..." -ForegroundColor Yellow
Stop-Service -DisplayName "ISO Training Portal" -ErrorAction SilentlyContinue | Out-Null
Start-Sleep -Seconds 2

Write-Host "[2/4] Hot-swapping core files to permanent directory..." -ForegroundColor Yellow
Write-Host "      (Strictly preserving database.sqlite and .env configuration)" -ForegroundColor DarkGray

# We grab all items in the root folder, but exclude the database and env files so we don't wipe data
Get-ChildItem -Path $script:SourceDir | Where-Object {
    $_.Name -ne 'database.sqlite' -and 
    $_.Name -ne '.env' -and
    $_.Name -ne 'logs'
} | Copy-Item -Destination $script:TargetDir -Recurse -Force

Write-Host "[3/4] Updating NPM Dependencies..." -ForegroundColor Yellow
$procNpm = Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"npm install`"" -WorkingDirectory $script:TargetDir -Wait -NoNewWindow -PassThru

Write-Host "[4/4] Restarting background service..." -ForegroundColor Yellow
Start-Service -DisplayName "ISO Training Portal" -ErrorAction SilentlyContinue | Out-Null
Start-Sleep -Seconds 2

Write-Host ""
Write-Host "========================================================" -ForegroundColor Green
Write-Host " UPDATE COMPLETE! The portal is running in the background." -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Green
Write-Host ""
Read-Host 'Press Enter to exit...' | Out-Null
