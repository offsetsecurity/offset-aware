param(
    [switch]$Unattended
)

# Ensure we are in the correct directory (crucial when run as Administrator)
# Require Administrator privileges
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "ERROR: This setup script must be run as Administrator!" -ForegroundColor Red
    Write-Host "Please right-click setup.bat and select 'Run as Administrator'." -ForegroundColor Yellow
    Read-Host "Press Enter to exit..." | Out-Null
    exit
}

$script:ScriptDir = $PSScriptRoot
Set-Location -Path $script:ScriptDir

$script:TargetDir = "C:\Program Files\Offset Security\ISO Training Portal"

# Where the portal keeps what it owns: the database, the sessions, the uploaded
# certificates, its own HTTPS certificate and the logs.
#
# Not TargetDir. Program Files is for program files: an uninstall or a repair
# may empty it, backup software skips it as re-installable, and hardened
# machines refuse writes to it. Every training record used to sit there, which
# is a lost-records incident waiting for the first person who reinstalls.
$script:DataDir = Join-Path $env:ProgramData "Offset Security\ISO Training Portal"

# Rotate installer.log once it passes this size (matches the 5 MB used by logger.js).
$script:MaxLogSize = 5MB
# Total-size budget per log location (live log + its archives), matching logger.js
# (3 x MaxLogSize). Oldest *.old.log archives are purged first when over budget.
$script:MaxLogsBudget = 3 * $script:MaxLogSize

function Rotate-LogFile {
    param([string]$LogPath)
    # If the log has grown past the threshold, archive it to *.old.log
    # (overwriting any previous archive) so a fresh file starts on the next write.
    if (Test-Path $LogPath) {
        try {
            if ((Get-Item $LogPath).Length -gt $script:MaxLogSize) {
                $archivePath = [System.IO.Path]::ChangeExtension($LogPath, ".old.log")
                Move-Item -Path $LogPath -Destination $archivePath -Force -ErrorAction SilentlyContinue
                # Only a rotation can push a location over budget, so enforce it
                # here rather than on every single write.
                Enforce-LogsBudget -Directory (Split-Path $LogPath -Parent) -BaseName ([System.IO.Path]::GetFileNameWithoutExtension($LogPath))
            }
        } catch { }
    }
}

function Enforce-LogsBudget {
    param([string]$Directory, [string]$BaseName)
    # Delete the oldest *.old.log archives until the combined size of the live log
    # and its archives is back under the budget. The live *.log is never deleted.
    try {
        $liveLog = Join-Path $Directory "$BaseName.log"
        $archives = @(Get-ChildItem -Path $Directory -Filter "$BaseName.old.log" -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime)
        $total = 0
        if (Test-Path $liveLog) { $total += (Get-Item $liveLog).Length }
        foreach ($a in $archives) { $total += $a.Length }
        foreach ($archive in $archives) {
            if ($total -le $script:MaxLogsBudget) { break }
            $size = $archive.Length
            Remove-Item -Path $archive.FullName -Force -ErrorAction SilentlyContinue
            $total -= $size
        }
    } catch { }
}

function Write-Log {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $logLine = "[$timestamp] $Message"
    # Log to both places if TargetDir exists
    $scriptLog = "$script:ScriptDir\installer.log"
    Rotate-LogFile $scriptLog
    Add-Content -Path $scriptLog -Value $logLine
    if (Test-Path $script:TargetDir) {
        $targetLog = "$script:TargetDir\installer.log"
        Rotate-LogFile $targetLog
        Add-Content -Path $targetLog -Value $logLine -ErrorAction SilentlyContinue
    }
}
Write-Log "--- Starting Offset Aware Installation Wizard ---"

# 1. Node.js Detection & Prompt (Using basic WinForms just for the initial check before WPF loads)
# The portal needs Node.js 24 or newer. Node.js 20 stopped receiving security
# fixes in April 2026, so an older Node.js is offered an upgrade, not accepted.
$RequiredNodeMajor = 24
$PinnedNodeVersion = "v24.21.0"
Add-Type -AssemblyName System.Windows.Forms
$nodeVersion = $null
$nodeMajor = 0
try {
    $nodeVersion = node -v 2>$null
    if ($nodeVersion -match '^v(\d+)\.') { $nodeMajor = [int]$Matches[1] }
} catch { }
if ($nodeMajor -gt 0) { Write-Log "Found Node.js $nodeVersion." }

if ($nodeMajor -lt $RequiredNodeMajor) {
    [System.Windows.Forms.Application]::EnableVisualStyles()
    if ($nodeMajor -eq 0) {
        $question = "You do not have Node.js installed. Do you wish to install Node.js $RequiredNodeMajor automatically now?"
    } else {
        $question = "This server has Node.js $nodeVersion. The portal needs Node.js $RequiredNodeMajor or newer, because older versions no longer receive security fixes.`n`nInstall Node.js $RequiredNodeMajor now? It replaces the current version for every program on this server that uses Node.js."
    }
    $result = [System.Windows.Forms.MessageBox]::Show($question, "Node.js $RequiredNodeMajor Required", [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question)
    if ($result -ne [System.Windows.Forms.DialogResult]::Yes) {
        Write-Log "Setup stopped: Node.js $RequiredNodeMajor is required and was not installed."
        exit 1
    }

    # Resolve the latest Node.js 24 LTS from the official dist index.
    # index.json is sorted newest-first; LTS entries carry a non-false "lts"
    # codename ("Krypton" for 24), so the first matching entry is the newest.
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $ltsVersion = $null
    try {
        Write-Log "Querying nodejs.org for the latest v$RequiredNodeMajor LTS release..."
        $releases = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json" -UseBasicParsing -TimeoutSec 30
        $ltsVersion = ($releases | Where-Object { $_.version -like "v$RequiredNodeMajor.*" -and $_.lts } | Select-Object -First 1).version
    } catch {
        Write-Log "WARNING: Could not query the Node.js release index: $($_.Exception.Message)"
    }

    # Fall back to a known-good pinned version if the lookup failed or returned nothing.
    if ([string]::IsNullOrWhiteSpace($ltsVersion)) {
        $ltsVersion = $PinnedNodeVersion
        Write-Log "Falling back to pinned Node.js version $ltsVersion."
    } else {
        Write-Log "Latest Node.js v$RequiredNodeMajor LTS resolved to $ltsVersion."
    }

    # Detect the OS architecture so we fetch the matching Node.js MSI.
    # Prefer RuntimeInformation.OSArchitecture (reports the OS, not the process,
    # so a 32-bit PowerShell host on 64-bit Windows still resolves correctly).
    $osArch = $null
    $archName = $null
    try {
        $archName = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
        switch ($archName) {
            "X64"   { $osArch = "x64" }
            "Arm64" { $osArch = "arm64" }
        }
    } catch { }

    # Fall back to environment variables on hosts without RuntimeInformation.
    # PROCESSOR_ARCHITEW6432 is set when a 32-bit process runs on 64-bit Windows.
    if ([string]::IsNullOrEmpty($osArch)) {
        $envArch = $env:PROCESSOR_ARCHITEW6432
        if ([string]::IsNullOrEmpty($envArch)) { $envArch = $env:PROCESSOR_ARCHITECTURE }
        switch ($envArch) {
            "AMD64" { $osArch = "x64" }
            "ARM64" { $osArch = "arm64" }
        }
        if (-not $archName) { $archName = $envArch }
    }

    # Node.js 24 is built for 64-bit Windows only (x64 and arm64). There is no
    # 32-bit build, so a 32-bit Windows cannot run the portal.
    if ([string]::IsNullOrEmpty($osArch)) {
        Write-Log "ERROR: Unsupported CPU architecture '$archName' for Node.js $RequiredNodeMajor."
        [System.Windows.Forms.MessageBox]::Show("This server's architecture ($archName) is not supported. Node.js $RequiredNodeMajor needs 64-bit Windows (x64 or ARM64).", "Unsupported Architecture", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
        exit 1
    }
    Write-Log "Detected OS architecture: $osArch."

    $downloadUrl = "https://nodejs.org/dist/$ltsVersion/node-$ltsVersion-$osArch.msi"
    $installerPath = "$env:TEMP\node-installer.msi"

    # Download the MSI with retries so a transient network hiccup doesn't abort setup.
    $downloaded = $false
    for ($attempt = 1; $attempt -le 3 -and -not $downloaded; $attempt++) {
        try {
            Write-Log "Downloading Node.js from $downloadUrl (attempt $attempt of 3)..."
            if (Test-Path $installerPath) { Remove-Item $installerPath -Force -ErrorAction SilentlyContinue }
            Invoke-WebRequest -Uri $downloadUrl -OutFile $installerPath -UseBasicParsing -TimeoutSec 300
            # Sanity-check the size: real Node.js MSIs are ~23-27 MB, so anything
            # under 10 MB is a truncated or bogus download that msiexec would choke on.
            if ((Test-Path $installerPath) -and ((Get-Item $installerPath).Length -ge 10MB)) {
                $downloaded = $true
            } else {
                throw "Downloaded file is missing or suspiciously small (expected at least 10 MB)."
            }
        } catch {
            Write-Log "WARNING: Node.js download attempt $attempt failed: $($_.Exception.Message)"
            if ($attempt -lt 3) { Start-Sleep -Seconds 3 }
        }
    }

    if (-not $downloaded) {
        Write-Log "ERROR: Failed to download Node.js after 3 attempts."
        [System.Windows.Forms.MessageBox]::Show("Could not download Node.js from nodejs.org. Please check your internet connection, or install Node.js $RequiredNodeMajor LTS manually and re-run setup.", "Download Failed", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
        exit 1
    }

    Write-Log "Installing Node.js $ltsVersion silently..."
    $process = Start-Process -FilePath "msiexec.exe" -ArgumentList "/i `"$installerPath`" /passive" -Wait -PassThru
    if ($process.ExitCode -eq 0) {
        Write-Log "Node.js $ltsVersion installed successfully."
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
        # Another copy of Node.js earlier on the PATH (nvm, a zip copy) would
        # still win, and the portal would run on the old one. Check, and say so.
        $nodeAfter = $null
        try { $nodeAfter = node -v 2>$null } catch { }
        if (-not ($nodeAfter -match '^v(\d+)\.' -and [int]$Matches[1] -ge $RequiredNodeMajor)) {
            Write-Log "ERROR: After installing, 'node -v' reports '$nodeAfter', not Node.js $RequiredNodeMajor."
            [System.Windows.Forms.MessageBox]::Show("Node.js $ltsVersion was installed, but this server still runs '$nodeAfter' when it starts Node.js. Another copy of Node.js comes first on the PATH. Remove it, or put C:\Program Files\nodejs first, then run setup again.", "Old Node.js Still In Use", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
            exit 1
        }
    } else {
        Write-Log "ERROR: Node.js installer exited with code $($process.ExitCode)."
        [System.Windows.Forms.MessageBox]::Show("Node.js installation failed (exit code $($process.ExitCode)). Setup will exit.", "Error", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
        exit 1
    }
}

# 2. WPF Assembly & XAML
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$licenseText = ""
if (Test-Path "$script:ScriptDir\LICENSE.md") {
    $licenseText = Get-Content "$script:ScriptDir\LICENSE.md" -Raw
    $licenseText = $licenseText -replace "&", "&amp;" -replace "<", "&lt;" -replace ">", "&gt;" -replace "`"", "&quot;" -replace "'", "&apos;"
} else {
    $licenseText = "License file not found."
}

[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Offset Security - Enterprise Setup Wizard" Height="650" Width="900" 
        WindowStartupLocation="CenterScreen" ResizeMode="NoResize"
        FontFamily="Segoe UI" Background="White">
    <Grid>
        <Grid.ColumnDefinitions>
            <ColumnDefinition Width="280" />
            <ColumnDefinition Width="*" />
        </Grid.ColumnDefinitions>

        <!-- Sidebar -->
        <Border Grid.Column="0" Background="#F8FAFC" BorderBrush="#E2E8F0" BorderThickness="0,0,1,0">
            <StackPanel Margin="25,30,25,25">
                <Image x:Name="imgLogo" Height="42" HorizontalAlignment="Left" Margin="0,0,0,12" Visibility="Collapsed" />
                <TextBlock x:Name="lblBrandTitle" Text="Offset Security" FontSize="18" FontWeight="Bold" Foreground="#2563EB" />
                <TextBlock Text="Enterprise Setup Wizard" FontSize="16" Foreground="#0F172A" Margin="0,5,0,4" />
                <TextBlock Text="Offset Risk. Enable Growth." FontSize="11" Foreground="#64748B" Margin="0,0,0,20" />
                
                <Rectangle Height="1" Fill="#E2E8F0" Margin="0,0,0,20" />
                
                <TextBlock x:Name="lblStep1" Text="1. License Agreement" FontSize="14" FontWeight="SemiBold" Foreground="#2563EB" Margin="0,10,0,10" />
                <TextBlock x:Name="lblStep2" Text="2. Configuration" FontSize="14" Foreground="#94A3B8" Margin="0,10,0,10" />
                <TextBlock x:Name="lblStep3" Text="3. Administrator" FontSize="14" Foreground="#94A3B8" Margin="0,10,0,10" />
                <TextBlock x:Name="lblStep4" Text="4. Installation" FontSize="14" Foreground="#94A3B8" Margin="0,10,0,10" />
            </StackPanel>
        </Border>

        <!-- Main Content Area -->
        <Grid Grid.Column="1" Margin="40,30,40,20">
            <Grid.RowDefinitions>
                <RowDefinition Height="*" />
                <RowDefinition Height="Auto" />
            </Grid.RowDefinitions>

            <!-- STEP 1: EULA -->
            <Grid x:Name="gridStep1" Visibility="Visible">
                <StackPanel>
                    <TextBlock Text="End User License Agreement" FontSize="22" FontWeight="Bold" Foreground="#0F172A" Margin="0,0,0,10" />
                    <TextBlock Text="Please read and accept the terms of the Offset Security License Agreement before continuing." FontSize="14" Foreground="#64748B" Margin="0,0,0,20" TextWrapping="Wrap" />
                    
                    <Border BorderBrush="#CBD5E1" BorderThickness="1" CornerRadius="4" Height="320" Background="#F8FAFC">
                        <ScrollViewer VerticalScrollBarVisibility="Auto" Padding="15">
                            <TextBlock Text="$licenseText" TextWrapping="Wrap" FontFamily="Segoe UI" FontSize="13" Foreground="#334155" LineHeight="20" />
                        </ScrollViewer>
                    </Border>
                    
                    <CheckBox x:Name="chkAcceptEula" Content="I accept the terms of the License Agreement" FontSize="14" Margin="0,20,0,0" />
                </StackPanel>
            </Grid>

            <!-- STEP 2: Configuration -->
            <Grid x:Name="gridStep2" Visibility="Collapsed">
                <StackPanel>
                    <TextBlock Text="Network Configuration" FontSize="22" FontWeight="Bold" Foreground="#0F172A" Margin="0,0,0,10" />
                    <TextBlock Text="Configure the foundational settings for your on-premise portal." FontSize="14" Foreground="#64748B" Margin="0,0,0,30" TextWrapping="Wrap" />
                    
                    <TextBlock Text="Network Port" FontWeight="SemiBold" FontSize="14" Foreground="#0F172A" Margin="0,0,0,5" />
                    <TextBlock Text="The portal answers on one port on this server. 3000 is the usual one, and the box below is already filled in with the first port nothing else is using - so you can accept it, or type any other port you prefer. Whatever you choose is the address your staff will use." FontSize="12" Foreground="#94A3B8" Margin="0,0,0,5" TextWrapping="Wrap" />
                    <TextBox x:Name="txtPort" Text="3000" FontSize="14" Padding="5" Height="32" Width="100" HorizontalAlignment="Left" Margin="0,0,0,20" BorderBrush="#CBD5E1" />

                    <TextBlock Text="Server Address" FontWeight="SemiBold" FontSize="14" Foreground="#0F172A" Margin="0,0,0,5" />
                    <TextBlock Text="The hostname or IP address employees use to reach this server. It is combined with the port above to build the login links in emails. Use a DNS name or static IP if you have one." FontSize="12" Foreground="#94A3B8" Margin="0,0,0,5" TextWrapping="Wrap" />
                    <TextBox x:Name="txtServerAddress" FontSize="14" Padding="5" Height="32" Width="360" HorizontalAlignment="Left" Margin="0,0,0,20" BorderBrush="#CBD5E1" />
                </StackPanel>
            </Grid>

            <!-- STEP 3: Administrator -->
            <Grid x:Name="gridStep3" Visibility="Collapsed">
                <StackPanel>
                    <TextBlock Text="Administrator Account" FontSize="22" FontWeight="Bold" Foreground="#0F172A" Margin="0,0,0,10" />
                    <TextBlock Text="Create the master account that will manage all training modules and settings." FontSize="14" Foreground="#64748B" Margin="0,0,0,30" TextWrapping="Wrap" />
                    
                    <TextBlock Text="Admin ID (e.g. admin)" FontWeight="SemiBold" FontSize="14" Foreground="#0F172A" Margin="0,0,0,5" />
                    <TextBox x:Name="txtAdminId" FontSize="14" Padding="5" Height="32" Margin="0,0,0,20" BorderBrush="#CBD5E1" />
                    
                    <TextBlock Text="Full Name" FontWeight="SemiBold" FontSize="14" Foreground="#0F172A" Margin="0,0,0,5" />
                    <TextBox x:Name="txtAdminName" FontSize="14" Padding="5" Height="32" Margin="0,0,0,20" BorderBrush="#CBD5E1" />
                    
                    <TextBlock Text="Email Address" FontWeight="SemiBold" FontSize="14" Foreground="#0F172A" Margin="0,0,0,5" />
                    <TextBox x:Name="txtAdminEmail" FontSize="14" Padding="5" Height="32" Margin="0,0,0,20" BorderBrush="#CBD5E1" />
                    
                    <TextBlock Text="Secure Password (Min 8 chars)" FontWeight="SemiBold" FontSize="14" Foreground="#0F172A" Margin="0,0,0,5" />
                    <PasswordBox x:Name="txtAdminPassword" FontSize="14" Padding="5" Height="32" Margin="0,0,0,20" BorderBrush="#CBD5E1" />
                </StackPanel>
            </Grid>

            <!-- STEP 4: Installation -->
            <Grid x:Name="gridStep4" Visibility="Collapsed">
                <StackPanel VerticalAlignment="Center" HorizontalAlignment="Center">
                    <TextBlock Text="Configuring Your Portal" FontSize="22" FontWeight="Bold" Foreground="#0F172A" HorizontalAlignment="Center" Margin="0,0,0,20" />
                    <ProgressBar x:Name="progressBar" Width="400" Height="25" IsIndeterminate="True" Foreground="#2563EB" Margin="0,0,0,20" />
                    <TextBlock x:Name="lblStatus" Text="Preparing installation..." FontSize="14" Foreground="#64748B" HorizontalAlignment="Center" />
                </StackPanel>
            </Grid>

            <!-- Navigation Buttons -->
            <Grid Grid.Row="1" Margin="0,20,0,0">
                <Grid.ColumnDefinitions>
                    <ColumnDefinition Width="*" />
                    <ColumnDefinition Width="Auto" />
                    <ColumnDefinition Width="Auto" />
                </Grid.ColumnDefinitions>
                
                <Button x:Name="btnBack" Grid.Column="1" Content="Back" Width="100" Height="40" Margin="0,0,10,0" Background="#E2E8F0" BorderThickness="0" FontSize="14" Visibility="Collapsed" />
                <Button x:Name="btnNext" Grid.Column="2" Content="Next" Width="120" Height="40" Background="#2563EB" Foreground="White" BorderThickness="0" FontSize="14" FontWeight="Bold" IsEnabled="False" />
            </Grid>
        </Grid>
    </Grid>
</Window>
"@

$reader = (New-Object System.Xml.XmlNodeReader $xaml)
$window = [System.Windows.Markup.XamlReader]::Load($reader)

# Map Controls
$btnNext = $window.FindName("btnNext")
$btnBack = $window.FindName("btnBack")
$chkAcceptEula = $window.FindName("chkAcceptEula")

$gridStep1 = $window.FindName("gridStep1")
$gridStep2 = $window.FindName("gridStep2")
$gridStep3 = $window.FindName("gridStep3")
$gridStep4 = $window.FindName("gridStep4")

$lblStep1 = $window.FindName("lblStep1")
$lblStep2 = $window.FindName("lblStep2")
$lblStep3 = $window.FindName("lblStep3")
$lblStep4 = $window.FindName("lblStep4")

$txtPort = $window.FindName("txtPort")
$txtServerAddress = $window.FindName("txtServerAddress")
# Pre-fill the server address with this machine's hostname; the admin can
# override it with a DNS name or static IP their employees will actually use.
if ($txtServerAddress -ne $null -and [string]::IsNullOrWhiteSpace($txtServerAddress.Text)) {
    $txtServerAddress.Text = $env:COMPUTERNAME
}
$txtAdminId = $window.FindName("txtAdminId")
$txtAdminName = $window.FindName("txtAdminName")
$txtAdminEmail = $window.FindName("txtAdminEmail")
$txtAdminPassword = $window.FindName("txtAdminPassword")
$lblStatus = $window.FindName("lblStatus")

# Show the Offset Security logo in the sidebar; keep the text title as fallback
# if the image is missing or fails to load.
$imgLogo = $window.FindName("imgLogo")
$lblBrandTitle = $window.FindName("lblBrandTitle")
$logoPath = Join-Path $script:ScriptDir "public\logo.png"
if (Test-Path $logoPath) {
    try {
        $logoBitmap = New-Object System.Windows.Media.Imaging.BitmapImage
        $logoBitmap.BeginInit()
        $logoBitmap.UriSource = New-Object System.Uri($logoPath)
        $logoBitmap.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
        $logoBitmap.EndInit()
        $imgLogo.Source = $logoBitmap
        $imgLogo.Visibility = "Visible"
        $lblBrandTitle.Visibility = "Collapsed"
    } catch { }
}

$script:currentStep = 1
# Tracks whether the wizard's installation steps (Step 4) actually completed.
# The post-dialog service-installation phase runs only when this is true, so
# closing the window early (X button) or a failed Step 4 will not install the service.
$script:InstallCompleted = $false

# Helper for Step Highlighting
function Update-StepUI {
    $lblStep1.Foreground = "#94A3B8"; $lblStep1.FontWeight = "Normal"
    $lblStep2.Foreground = "#94A3B8"; $lblStep2.FontWeight = "Normal"
    $lblStep3.Foreground = "#94A3B8"; $lblStep3.FontWeight = "Normal"
    $lblStep4.Foreground = "#94A3B8"; $lblStep4.FontWeight = "Normal"

    if ($script:currentStep -eq 1) { $lblStep1.Foreground = "#2563EB"; $lblStep1.FontWeight = "SemiBold" }
    if ($script:currentStep -eq 2) { $lblStep2.Foreground = "#2563EB"; $lblStep2.FontWeight = "SemiBold" }
    if ($script:currentStep -eq 3) { $lblStep3.Foreground = "#2563EB"; $lblStep3.FontWeight = "SemiBold" }
    if ($script:currentStep -eq 4) { $lblStep4.Foreground = "#2563EB"; $lblStep4.FontWeight = "SemiBold" }
}

# EULA Checkbox Event
$chkAcceptEula.Add_Checked({
    if ($script:currentStep -eq 1) { $btnNext.IsEnabled = $true }
})
$chkAcceptEula.Add_Unchecked({
    if ($script:currentStep -eq 1) { $btnNext.IsEnabled = $false }
})

# Async UI updater
function DoEvents {
    $frame = New-Object System.Windows.Threading.DispatcherFrame
    [System.Windows.Threading.Dispatcher]::CurrentDispatcher.BeginInvoke(
        [System.Windows.Threading.DispatcherPriority]::Background,
        [System.Action] { $frame.Continue = $false }
    ) | Out-Null
    [System.Windows.Threading.Dispatcher]::PushFrame($frame)
}

# The first port from $Start upward that nothing is listening on.
#
# The hint used to read "ensure no other applications are bound to this port",
# which is work handed to the administrator that the installer can simply do.
# Installing onto a busy port produces a tidy install that never starts, and
# the reason is buried in a log.
function Get-FirstFreePort {
    param([int]$Start = 3000)
    $port = $Start
    while ($port -lt 65535) {
        $busy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if (-not $busy) { return $port }
        $port++
    }
    return $Start
}

$txtPort.Text = [string](Get-FirstFreePort 3000)
if ($txtPort.Text -ne "3000") { Write-Log "Port 3000 is in use; offering $($txtPort.Text) instead." }

# Navigation Logic
$btnBack.Add_Click({
    if ($script:currentStep -eq 2) {
        $gridStep2.Visibility = "Collapsed"
        $gridStep1.Visibility = "Visible"
        $btnBack.Visibility = "Collapsed"
        $btnNext.IsEnabled = $chkAcceptEula.IsChecked
        $script:currentStep = 1
        Update-StepUI
    }
    elseif ($script:currentStep -eq 3) {
        $gridStep3.Visibility = "Collapsed"
        $gridStep2.Visibility = "Visible"
        $btnNext.Content = "Next"
        $script:currentStep = 2
        Update-StepUI
    }
})

$btnNext.Add_Click({
    if ($script:currentStep -eq 1) {
        $gridStep1.Visibility = "Collapsed"
        $gridStep2.Visibility = "Visible"
        $btnBack.Visibility = "Visible"
        $btnNext.IsEnabled = $true
        $script:currentStep = 2
        Update-StepUI
    }
    elseif ($script:currentStep -eq 2) {
        $chosen = 0
        if (-not [int]::TryParse($txtPort.Text.Trim(), [ref]$chosen) -or $chosen -lt 1024 -or $chosen -gt 65535) {
            [System.Windows.MessageBox]::Show("Enter a port between 1024 and 65535.`r`n`r`nPorts below 1024 are reserved for Windows itself.", "Offset Aware") | Out-Null
            return
        }
        if (Get-NetTCPConnection -LocalPort $chosen -State Listen -ErrorAction SilentlyContinue) {
            $free = Get-FirstFreePort $chosen
            $answer = [System.Windows.MessageBox]::Show(
                "Something is already listening on port $chosen.`r`n`r`nThe portal would install and then fail to start. Port $free is free.`r`n`r`nUse $chosen anyway?",
                "Offset Aware",
                [System.Windows.MessageBoxButton]::YesNo,
                [System.Windows.MessageBoxImage]::Warning)
            if ($answer -ne [System.Windows.MessageBoxResult]::Yes) { $txtPort.Text = [string]$free; return }
        }
        $gridStep2.Visibility = "Collapsed"
        $gridStep3.Visibility = "Visible"
        $btnNext.Content = "Install"
        $script:currentStep = 3
        Update-StepUI
    }
    elseif ($script:currentStep -eq 3) {
        if ([string]::IsNullOrWhiteSpace($txtAdminId.Text) -or [string]::IsNullOrWhiteSpace($txtAdminName.Text) -or [string]::IsNullOrWhiteSpace($txtAdminEmail.Text)) {
            [System.Windows.MessageBox]::Show("Please fill out all Administrator fields.", "Validation Error")
            return
        }
        if ($txtAdminPassword.Password.Length -lt 8) {
            [System.Windows.MessageBox]::Show("Password must be at least 8 characters.", "Validation Error")
            return
        }

        # Enter Step 4 (Installation)
        $gridStep3.Visibility = "Collapsed"
        $gridStep4.Visibility = "Visible"
        $btnNext.Visibility = "Collapsed"
        $btnBack.Visibility = "Collapsed"
        $script:currentStep = 4
        Update-StepUI
        DoEvents

        # Execute Install Logic
        Write-Log "User accepted EULA and provided configuration. Starting background installation steps."
        
        $lblStatus.Text = "Copying files to Program Files..."
        DoEvents
        if ($script:ScriptDir -ne $script:TargetDir) {
            Write-Log "Copying core files from $script:ScriptDir to permanent directory $script:TargetDir"
            if (-not (Test-Path $script:TargetDir)) {
                New-Item -ItemType Directory -Force -Path $script:TargetDir | Out-Null
            }
            Copy-Item -Path "$script:ScriptDir\*" -Destination $script:TargetDir -Recurse -Force
        }
        
        $lblStatus.Text = "Preparing the data folder..."
        DoEvents
        Write-Log "Data folder: $script:DataDir"
        foreach ($sub in @("", "uploads", "logs", "certs")) {
            $p = if ($sub) { Join-Path $script:DataDir $sub } else { $script:DataDir }
            if (-not (Test-Path $p)) { New-Item -ItemType Directory -Force -Path $p | Out-Null }
        }

        # An upgrade from a copy installed before the data moved: bring the
        # records across rather than starting the new folder empty, which would
        # look to the customer exactly like losing every training record.
        $moved = 0
        foreach ($f in @("database.sqlite", "sessions.sqlite", "cert.pem", "key.pem")) {
            $old = Join-Path $script:TargetDir $f
            $new = If ($f -like "*.pem") { Join-Path $script:DataDir "certs\$f" } Else { Join-Path $script:DataDir $f }
            if ((Test-Path $old) -and (-not (Test-Path $new))) {
                Move-Item -Path $old -Destination $new -Force
                Write-Log "Moved $f to the data folder."
                $moved++
            }
        }
        foreach ($d in @("uploads", "logs")) {
            $old = Join-Path $script:TargetDir $d
            if (Test-Path $old) {
                $items = Get-ChildItem -Path $old -Force -ErrorAction SilentlyContinue
                if ($items) {
                    Move-Item -Path "$old\*" -Destination (Join-Path $script:DataDir $d) -Force -ErrorAction SilentlyContinue
                    Write-Log "Moved the $d folder to the data folder."
                    $moved++
                }
            }
        }
        if ($moved -gt 0) { Write-Log "Upgrade: $moved item(s) moved out of Program Files." }

        # Everything started from here on - init_admin.js below, and the
        # service - reads these. They are written into .env further down too,
        # for anyone who starts the portal by hand.
        $env:DB_PATH = Join-Path $script:DataDir "database.sqlite"
        $env:UPLOADS_DIR = Join-Path $script:DataDir "uploads"
        $env:CERT_DIR = Join-Path $script:DataDir "certs"
        $env:LOG_DIR = Join-Path $script:DataDir "logs"

        $lblStatus.Text = "Downloading NPM dependencies..."
        DoEvents
        Write-Log "Running 'npm install' in $script:TargetDir..."
        $procNpm = Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"npm install`"" -WorkingDirectory $script:TargetDir -Wait -NoNewWindow -PassThru
        if ($procNpm.ExitCode -ne 0) {
            Write-Log "ERROR: 'npm install' failed with exit code $($procNpm.ExitCode)."
            [System.Windows.MessageBox]::Show("NPM Install failed. Check terminal.", "Installation Error")
            $window.Close()
            exit 1
        }
        Write-Log "'npm install' completed successfully."

        $lblStatus.Text = "Initializing internal database..."
        DoEvents
        
        Write-Log "Running init_admin.js to configure database..."
        $argsList = "init_admin.js `"$($txtAdminId.Text)`" `"$($txtAdminName.Text)`" `"$($txtAdminEmail.Text)`" `"$($txtAdminPassword.Password)`" `"$($txtPort.Text)`""
        $procInit = Start-Process -FilePath "node" -ArgumentList $argsList -WorkingDirectory $script:TargetDir -Wait -NoNewWindow -PassThru
        if ($procInit.ExitCode -ne 0) {
            Write-Log "ERROR: Database configuration (init_admin.js) failed with exit code $($procInit.ExitCode)."
            [System.Windows.MessageBox]::Show("Database configuration failed.", "Installation Error")
            $window.Close()
            exit 1
        }
        Write-Log "Database initialization successful."

        $lblStatus.Text = "Configuring local firewall..."
        DoEvents
        Write-Log "Opening Windows Firewall for TCP Port $($txtPort.Text)..."
        New-NetFirewallRule -DisplayName "ISO Training Portal (Port $($txtPort.Text))" -Direction Inbound -LocalPort $txtPort.Text -Protocol TCP -Action Allow -ErrorAction SilentlyContinue | Out-Null
        Write-Log "Firewall rule created."

        $lblStatus.Text = "Installation Successful!"
        DoEvents
        Start-Sleep -Seconds 1
        
        $script:InstallCompleted = $true
        [System.Windows.MessageBox]::Show("Enterprise Portal successfully configured! The background Windows Service will now be installed.", "Configuration Complete")
        $window.Close()
    }
})

$window.ShowDialog() | Out-Null

# Only install/start the Windows Service if the wizard actually finished its
# installation steps. Otherwise the target directory may be empty or missing,
# and running install_service.js there would fail and leave a half-installed state.
if (-not $script:InstallCompleted) {
    Write-Log "Setup wizard was closed before installation completed. Skipping service installation."
    Write-Host "Setup was cancelled before completion. No service was installed." -ForegroundColor Yellow
    exit 1
}

$finalPort = "3000"
if ($txtPort -ne $null) {
    $finalPort = $txtPort.Text
}

# Determine the base URL used for login links in employee emails. Falls back to
# the machine hostname if the admin left the Server Address field blank.
$serverAddress = $env:COMPUTERNAME
if ($txtServerAddress -ne $null -and -not [string]::IsNullOrWhiteSpace($txtServerAddress.Text)) {
    $serverAddress = $txtServerAddress.Text.Trim()
}
# People paste whole addresses. Keep only the host: "https://portal.corp:3000/"
# becomes "portal.corp", so the link is not built as https://https://...:3000/:3000.
$serverAddress = $serverAddress -replace '^[a-zA-Z]+://', ''
$serverAddress = ($serverAddress -split '[/?#]')[0]
if ($serverAddress -match '^(\[[^\]]+\])(:\d+)?$') { $serverAddress = $Matches[1] }
else { $serverAddress = $serverAddress -replace ':\d+$', '' }
if ([string]::IsNullOrWhiteSpace($serverAddress)) { $serverAddress = $env:COMPUTERNAME }
if ($finalPort -eq "443") {
    $portalUrl = "https://${serverAddress}"
} else {
    $portalUrl = "https://${serverAddress}:${finalPort}"
}

Write-Host "Configuring Production Environment..." -ForegroundColor Cyan
Write-Log "Generating secure SESSION_SECRET and writing to .env file..."
Write-Log "Portal URL for employee email links set to $portalUrl"
# 32 random bytes from Windows' cryptographic generator, as hex.
$secretBytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($secretBytes)
$randomStr = -join ($secretBytes | ForEach-Object { $_.ToString('x2') })

# Keep the secret a re-run already had. Writing a fresh one signs every
# employee out mid-course, for no reason: this file is rewritten on every
# upgrade, and the secret only protects the sign-in cookie.
$existingEnv = "$script:TargetDir\.env"
if (Test-Path $existingEnv) {
    $old = (Get-Content $existingEnv | Where-Object { $_ -match '^SESSION_SECRET=.+' } | Select-Object -First 1)
    if ($old) {
        $randomStr = $old.Substring("SESSION_SECRET=".Length)
        Write-Log "Kept the SESSION_SECRET this install already had."
    }
}

# The paths go in here as well as into the service, so the portal lands in the
# same place however somebody starts it.
$envLines = @(
    "SESSION_SECRET=$randomStr",
    "PORT=$finalPort",
    "PORTAL_URL=$portalUrl",
    "DB_PATH=$(Join-Path $script:DataDir 'database.sqlite')",
    "UPLOADS_DIR=$(Join-Path $script:DataDir 'uploads')",
    "CERT_DIR=$(Join-Path $script:DataDir 'certs')",
    "LOG_DIR=$(Join-Path $script:DataDir 'logs')"
)
Set-Content -Path $existingEnv -Value ($envLines -join "`n")

Write-Host "Installing and Starting Background Service..." -ForegroundColor Cyan
Write-Log "Running install_service.js to register the background Windows Service..."
$procSvc = Start-Process -FilePath "node" -ArgumentList "install_service.js" -WorkingDirectory $script:TargetDir -Wait -NoNewWindow -PassThru
if ($procSvc.ExitCode -ne 0) {
    Write-Log "ERROR: Failed to install background service (Exit Code $($procSvc.ExitCode))."
} else {
    # node-windows asks the service manager to start it and then exits, so
    # "installed" does not mean "running". It was not running on a machine
    # where this was trusted: the service sat stopped with no log files at
    # all, and the installer opened a browser at nothing.
    Write-Log "Making sure the service is running..."
    $svcName = 'isotrainingportal.exe'
    $deadline = (Get-Date).AddSeconds(60)
    $svcRunning = $false
    while ((Get-Date) -lt $deadline) {
        $svc = Get-Service -Name $svcName -ErrorAction SilentlyContinue
        if ($svc -and $svc.Status -eq 'Running') { $svcRunning = $true; break }
        if ($svc -and $svc.Status -eq 'Stopped') {
            # A service created a moment ago can refuse to start for a second
            # or two, so this is tried rather than done once.
            Start-Service -Name $svcName -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 2
    }
    if ($svcRunning) {
        Write-Log "Service is running."
    } else {
        Write-Log "WARNING: the service did not start. The portal is installed but not running."
        [System.Windows.Forms.MessageBox]::Show(
            "The portal is installed, but its background service did not start.`r`n`r`nOpen Services, find 'ISO Training Portal', and start it. If it will not start, the reason is in:`r`n$($script:DataDir)\logs\runtime.log",
            "Offset Aware",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
    }

    Write-Log "--- Installation Wizard Completed Successfully ---"
    Write-Host "Success! Portal is now running in the background." -ForegroundColor Green
    
    # Create Desktop Shortcut (.lnk file for App Mode)
    $WshShell = New-Object -comObject WScript.Shell
    $Shortcut = $WshShell.CreateShortcut("$([Environment]::GetFolderPath('Desktop'))\Offset Aware.lnk")
    
    $edgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    if (Test-Path $edgePath) {
        $Shortcut.TargetPath = $edgePath
        $Shortcut.Arguments = "--app=https://localhost:$finalPort"
    } else {
        $Shortcut.TargetPath = "explorer.exe"
        $Shortcut.Arguments = "https://localhost:$finalPort"
    }
    
    $Shortcut.IconLocation = "shell32.dll, 14"
    $Shortcut.Save()
    Write-Log "Desktop shortcut 'Offset Aware' created."

    # Start menu, so it can be found by typing its name, and so the uninstaller
    # is somewhere a person would look for it.
    $startMenu = Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs\Offset Aware"
    New-Item -ItemType Directory -Force -Path $startMenu | Out-Null
    $sm = $WshShell.CreateShortcut((Join-Path $startMenu "Offset Aware.lnk"))
    $sm.TargetPath = $Shortcut.TargetPath
    $sm.Arguments = $Shortcut.Arguments
    $sm.IconLocation = "shell32.dll, 14"
    $sm.Save()
    $smU = $WshShell.CreateShortcut((Join-Path $startMenu "Uninstall Offset Aware.lnk"))
    $smU.TargetPath = "powershell.exe"
    $smU.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $script:TargetDir 'uninstall.ps1')`""
    $smU.IconLocation = "shell32.dll, 31"
    $smU.Save()
    Write-Log "Start menu shortcuts created."

    # Settings -> Apps. Without this the portal cannot be uninstalled the way
    # every other program on the machine is: the only way out was a .bat file
    # inside Program Files that a customer had no reason to know about. An
    # administrator who cannot uninstall software will not approve installing
    # it in the first place.
    try {
        $version = "1.0.0"
        $pkg = Join-Path $script:TargetDir "package.json"
        if (Test-Path $pkg) { $version = (Get-Content $pkg -Raw | ConvertFrom-Json).version }
        $sizeKb = 0
        try {
            $sizeKb = [int]((Get-ChildItem $script:TargetDir -Recurse -File -ErrorAction SilentlyContinue |
                Measure-Object -Property Length -Sum).Sum / 1KB)
        } catch { }

        $key = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\ISOTrainingPortal"
        New-Item -Path $key -Force | Out-Null
        $uninstaller = Join-Path $script:TargetDir "uninstall.ps1"
        Set-ItemProperty $key "DisplayName"          "Offset Aware"
        Set-ItemProperty $key "DisplayVersion"       $version
        Set-ItemProperty $key "Publisher"            "Offset Security"
        Set-ItemProperty $key "InstallLocation"      $script:TargetDir
        Set-ItemProperty $key "DisplayIcon"          "shell32.dll,14"
        Set-ItemProperty $key "UninstallString"      "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$uninstaller`""
        Set-ItemProperty $key "QuietUninstallString" "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$uninstaller`" -Silent"
        Set-ItemProperty $key "URLInfoAbout"         "https://offsetsecurity.net"
        Set-ItemProperty $key "NoModify"             1 -Type DWord
        Set-ItemProperty $key "NoRepair"             1 -Type DWord
        if ($sizeKb -gt 0) { Set-ItemProperty $key "EstimatedSize" $sizeKb -Type DWord }
        Write-Log "Registered in Settings -> Apps (version $version, ${sizeKb} KB)."
    } catch {
        Write-Log "WARNING: could not register in Settings -> Apps: $($_.Exception.Message)"
    }

    # Confirm completion to the user. The dialog blocks until they click OK,
    # which also gives the freshly-registered service a moment to finish booting.
    Write-Log "Installation finished. Prompting user to launch the portal."
    [System.Windows.Forms.MessageBox]::Show(
        "Installation finished!`r`n`r`nA shortcut to Offset Aware has been created on your desktop.`r`n`r`nClick OK to open it.",
        "Offset Aware",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null

    # Wait until it actually answers. Two seconds used to be the whole plan,
    # and a first start has a database to open and a certificate to make.
    Write-Log "Waiting for the portal to answer on port $finalPort..."
    $answered = $false
    $waitUntil = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $waitUntil) {
        try {
            $client = New-Object System.Net.Sockets.TcpClient
            $client.Connect('127.0.0.1', [int]$finalPort)
            $client.Close()
            $answered = $true
            break
        } catch {
            Start-Sleep -Seconds 2
        }
    }
    if ($answered) {
        Write-Log "The portal is answering on port $finalPort."
    } else {
        Write-Log "WARNING: nothing is answering on port $finalPort after 90 seconds."
    }

    Write-Log "Launching portal in browser..."
    if (Test-Path $edgePath) {
        Start-Process $edgePath -ArgumentList "--app=https://localhost:$finalPort"
    } else {
        Start-Process "https://localhost:$finalPort"
    }
}
