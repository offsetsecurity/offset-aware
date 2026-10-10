<#
.SYNOPSIS
  Builds the Windows payload for Offset Aware.

.DESCRIPTION
  Produces dist\windows\OffsetTrainingPortal, the folder the Inno Setup script
  wraps into one .exe. Everything a customer needs is in it, including Node
  itself.

  Why Node is bundled, when the portal used to install it: the old installer
  asked permission to put Node 24 on the machine, replacing whatever version
  was already there for every other program on that server. That is a large
  thing to ask in order to run one web application, and administrators quite
  reasonably say no. A copy of Node inside the install folder is used by this
  product and nothing else.

  The dependencies are installed here rather than on the customer's machine.
  The old installer ran "npm install" during setup, so installing needed
  internet access and a working npm, and what a customer ended up running was
  whatever npm resolved that day.

.PARAMETER NodeExe
  The node.exe to bundle. Defaults to the one on PATH, which must be the
  version in .nvmrc - the customer gets exactly this binary.

.EXAMPLE
  pwsh deploy\windows\build.ps1
#>
[CmdletBinding()]
param(
  [string]$NodeExe = (Get-Command node).Source,
  [string]$OutDir = "",
  [ValidatePattern('^(\d+\.\d+\.\d+)?$')]
  [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$repo = Resolve-Path (Join-Path $PSScriptRoot "..\..")

$display = "Offset Aware"
$folder = "OffsetTrainingPortal"

# The customer gets exactly this node.exe, so it must be the pinned one.
$pinned = (Get-Content (Join-Path $repo ".nvmrc") -Raw).Trim()
$bundled = (& $NodeExe --version).Trim().TrimStart("v")
if ($bundled -ne $pinned) {
  throw "This would bundle Node $bundled, but .nvmrc pins $pinned. Pass -NodeExe with the path to an official node-v$pinned-win-x64\node.exe."
}

if (-not $Version) {
  $Version = (Get-Content (Join-Path $repo "package.json") -Raw | ConvertFrom-Json).version
}

if (-not $OutDir) { $OutDir = Join-Path $repo "dist\windows" }
$stage = Join-Path $OutDir $folder

Write-Host ""
Write-Host "  $display $Version, Node $bundled"
Write-Host ""

# -- 1. a clean staging folder ------------------------------------------------
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null

# -- 2. the application -------------------------------------------------------
# Named one by one. A copy of the whole folder would sweep in the test
# files, the deploy folder, the git history and whatever else is lying about.
Write-Host "  copying the application..."
$files = @(
  "server.js", "quizzes.js", "logger.js", "tls.js", "init_admin.js", "reset_admin_password.js", "reset_admin_password.bat",
  "install_service.js", "uninstall_service.js", "secure_folders.js",
  "package.json", "package-lock.json",
  "LICENSE.md", "INSTALLATION.txt", "SECURITY.md"
)
foreach ($f in $files) {
  $src = Join-Path $repo $f
  if (Test-Path $src) { Copy-Item $src $stage -Force }
}
# The version a customer sees on the Help page, and the one the update check
# compares, is the version of this build.
$pkgPath = Join-Path $stage "package.json"
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$pkg.version = $Version
$pkg | ConvertTo-Json -Depth 20 | Set-Content $pkgPath -Encoding utf8
Copy-Item (Join-Path $repo "public") $stage -Recurse -Force
# The training videos stay out of the installer. Setup asks which modules the
# administrator wants and downloads only those (portal.iss), so the installer
# stays small however many courses there are.
Get-ChildItem (Join-Path $stage "public\training") -Filter *.mp4 -ErrorAction SilentlyContinue | Remove-Item -Force
Copy-Item (Join-Path $repo "docs") $stage -Recurse -Force
# Not uninstall.ps1: this build has a real uninstaller, registered in
# Settings -> Apps, and shipping a script that removes things a different way
# gives a customer two answers to one question.

# -- 3. the dependencies, built against the Node that ships -------------------
# --omit=dev leaves out the test tools, which the server never loads and which
# a customer would be downloading for nothing.
Write-Host "  installing production dependencies..."
Push-Location $stage
try {
  $env:PATH = "$(Split-Path -Parent (Resolve-Path $NodeExe));$env:PATH"
  & npm install --omit=dev --no-audit --no-fund --loglevel=error 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
}
finally { Pop-Location }

# -- 4. Node itself -----------------------------------------------------------
Copy-Item $NodeExe (Join-Path $stage "node.exe") -Force

# -- 5. does it all load with that Node? --------------------------------------
# sqlite3 is a native module: it is compiled against one Node version and
# refuses to load in another. Better to find that here than on a customer's
# server, which is where it was found last time.
Write-Host "  checking every dependency loads..."
Push-Location $stage
try {
  & (Join-Path $stage "node.exe") -e "const { dependencies } = require('./package.json'); for (const name of Object.keys(dependencies)) require(name); const sqlite3 = require('sqlite3'); new sqlite3.Database(':memory:').close();"
  if ($LASTEXITCODE -ne 0) { throw "A dependency does not load with Node $bundled. The install would not start." }
}
finally { Pop-Location }

# -- 6. the settings template -------------------------------------------------
# SESSION_SECRET is left blank on purpose: the installer fills it with a fresh
# random value, so no two installs share a key.
$dataDir = "C:\ProgramData\Offset Security\ISO Training Portal"
@"
# Settings for $display. Written when it was installed.
#
# Keep this file. Without the same SESSION_SECRET everybody is signed out on
# the next start.

NODE_ENV=production

# The port the portal answers on. Chosen during installation; changing it here
# means restarting the service afterwards, and letting the new port through
# the firewall.
PORT=3000

# The address staff use, put in the emails that send them their sign-in.
PORTAL_URL=https://localhost:3000

# Where the portal keeps what it owns. Not under Program Files: that folder is
# meant to be re-installable, and these are somebody's training records.
DB_PATH=$dataDir\database.sqlite
UPLOADS_DIR=$dataDir\uploads
CERT_DIR=$dataDir\certs
LOG_DIR=$dataDir\logs

# Filled in during installation.
SESSION_SECRET=
"@ | Set-Content (Join-Path $stage "env.template") -Encoding utf8

# -- 7. what the shortcut runs ------------------------------------------------
# A .vbs, because node always takes a console window and there is no windowless
# node.exe. A shortcut that runs node directly puts a black window on screen
# that a person is entitled to close.
@"
' Opens the portal in the default browser, with no console window.
Dim shell, url
Set shell = CreateObject("WScript.Shell")
url = shell.RegRead("HKLM\SOFTWARE\Offset Security\ISO Training Portal\Url")
shell.Run url, 1, False
"@ | Set-Content (Join-Path $stage "open.vbs") -Encoding ascii

$size = "{0:N1}" -f ((Get-ChildItem $stage -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)
Write-Host ""
Write-Host "  bundle: $size MB, Node $bundled"
Write-Host "  at:     $stage"
Write-Host ""
