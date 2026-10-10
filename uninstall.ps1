# Removes Offset Aware (formerly the ISO Training Portal) from this machine.
#
# This is what "Uninstall" in Settings -> Apps runs. It used to be a .bat file
# sitting inside the program folder, which meant a customer had to know it was
# there, find it and run it as administrator. Nobody uninstalls software that
# way.
#
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1            # asks
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Silent    # does not
#
# The training records are deliberately left behind. They are somebody's
# compliance evidence, an uninstall is not the moment to destroy them, and
# -DeleteData exists for when that really is what is wanted.

[CmdletBinding()]
param(
    [switch]$Silent,
    [switch]$DeleteData
)

$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$DataDir = Join-Path $env:ProgramData "Offset Security\ISO Training Portal"
$RegKey = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\ISOTrainingPortal"

# Administrator, or the service and the registry entry both refuse.
$admin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
    # Not $args: PowerShell already owns that name, and shadowing an automatic
    # variable is a bug waiting for whoever edits this next.
    $relaunch = "-NoProfile -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`""
    if ($Silent) { $relaunch += " -Silent" }
    if ($DeleteData) { $relaunch += " -DeleteData" }
    Start-Process powershell.exe -ArgumentList $relaunch -Verb RunAs
    exit
}

if (-not $Silent) {
    Write-Host ""
    Write-Host "  Uninstalling Offset Aware" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Your training records are NOT removed. They stay in:"
    Write-Host "    $DataDir"
    Write-Host ""
    $answer = Read-Host "  Continue? (y/N)"
    if ($answer -notmatch '^(y|yes)$') { Write-Host "  Nothing was changed."; exit }
}

# 1. The service. node-windows names it after the display name; stopping it
#    first means the uninstall is not racing a running process for the files.
Write-Host "  stopping the service..."
& sc.exe stop "isotrainingportal.exe" 2>&1 | Out-Null
Start-Sleep -Seconds 2
if (Test-Path (Join-Path $here "uninstall_service.js")) {
    & node (Join-Path $here "uninstall_service.js") 2>&1 | Out-Null
}
# node-windows leaves the service behind if its own uninstall fails, and a
# dead service in the list is the kind of thing that fails an audit.
& sc.exe delete "isotrainingportal.exe" 2>&1 | Out-Null

# 2. The way in.
Write-Host "  removing shortcuts..."
foreach ($name in @("Offset Aware", "ISO Training Portal")) {
    Remove-Item "$([Environment]::GetFolderPath('Desktop'))\$name.lnk" -Force -ErrorAction SilentlyContinue
    Remove-Item "$env:PUBLIC\Desktop\$name.lnk" -Force -ErrorAction SilentlyContinue
    Remove-Item "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\$name" -Recurse -Force -ErrorAction SilentlyContinue
}

# 3. The hole it opened in the firewall.
Write-Host "  removing the firewall rule..."
Get-NetFirewallRule -DisplayName "ISO Training Portal*" -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue

# 4. Its entry in Settings -> Apps.
Remove-Item $RegKey -Recurse -Force -ErrorAction SilentlyContinue

# 5. The records, only when asked in as many words.
if ($DeleteData) {
    Write-Host "  deleting the training records..." -ForegroundColor Yellow
    Remove-Item $DataDir -Recurse -Force -ErrorAction SilentlyContinue
}

# 6. The program folder, which cannot delete itself while this script runs
#    from inside it. A scheduled one-shot removes it a few seconds later.
$leftover = $here
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
    "-NoProfile", "-Command",
    "Start-Sleep -Seconds 5; Remove-Item -LiteralPath '$leftover' -Recurse -Force -ErrorAction SilentlyContinue"
)

if (-not $Silent) {
    Write-Host ""
    Write-Host "  Done." -ForegroundColor Green
    Write-Host ""
    if (-not $DeleteData) {
        Write-Host "  Your training records are still in:"
        Write-Host "    $DataDir"
        Write-Host "  Delete that folder to remove them. There is no undo."
        Write-Host ""
    }
    Read-Host "  Press Enter to close" | Out-Null
}
