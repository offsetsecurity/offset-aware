# IT Operations Runbook & Maintenance Guide

This document provides standardized procedures for DevOps and IT Operations teams to manage Offset Aware.

## 1. Service Management

Offset Aware runs as a standard Windows Background Service. It is configured to start automatically when the host server boots.

### Checking Service Status
1. Open the Windows Start menu, type **Services**, and press Enter.
2. Locate the service named **`ISO Training Portal`**. (Offset Aware was called that, and the Windows service kept the name so upgrades find it.)
3. The `Status` column should say **Running**. 

### Restarting the Service
If the application hangs or you deploy a custom code patch, you must restart the background service.
1. In the **Services** snap-in, right-click **`ISO Training Portal`**.
2. Select **Restart**.

*(Alternatively, via PowerShell as Administrator)*:
```powershell
Restart-Service isotrainingportal.exe
```

## 2. Log Management & Troubleshooting

### Where things live
The program is in `C:\Program Files\Offset Security\Offset Aware` (or `...\ISO Training Portal` on a server that had it before the rename). Everything Aware owns — database, sessions, certificates and logs — is in the data folder, `C:\ProgramData\Offset Security\ISO Training Portal`. Only administrators of the server can open it: Windows asks for permission the first time. Back up the data folder; the program folder can be reinstalled.

### Application Logs
All application-level events (Logins, SMTP failures, User creation) are written to:
`C:\ProgramData\Offset Security\ISO Training Portal\logs\runtime.log`

### Service Daemon Logs (Fatal Crashes)
If the Node.js server experiences a fatal crash and the Windows Service stops, the error stack trace is captured by the daemon wrapper:
- **Error Log**: `C:\Program Files\Offset Security\Offset Aware\daemon\isotrainingportal.err.log`
- **Standard Output**: `C:\Program Files\Offset Security\Offset Aware\daemon\isotrainingportal.out.log`

### Common Issue: "Address already in use"
If the `.err.log` shows `Error: listen EADDRINUSE: address already in use`, it means another application on the server is already using the network port specified in the `.env` file. You must either kill the conflicting application or change the `PORT` variable in the `.env` file and restart the `ISO Training Portal` service.

## 3. Database Backups

Because the entire application relies on an embedded SQLite database, backups are extremely straightforward.

### Manual Backup Procedure
1. Stop the Windows Service: `Stop-Service isotrainingportal.exe`
2. Navigate to the data folder, `C:\ProgramData\Offset Security\ISO Training Portal\`.
3. Copy the whole folder to your secure backup location. `database.sqlite` holds every record; `certs` holds the HTTPS certificate.
4. Restart the Windows Service: `Start-Service isotrainingportal.exe`

### Automated Backups
It is highly recommended that IT teams configure a Windows Scheduled Task or enterprise backup solution (e.g., Veeam) to routinely copy the `database.sqlite` file during off-hours.

## 4. Emergency Admin Password Reset

If the primary Administrator forgets their password and cannot log in to manage Aware, a local IT Operator with access to the host server can reset the master admin password via the command line.

1. Open **Command Prompt** or **PowerShell** as Administrator.
2. Navigate to the application directory:
   ```powershell
   cd "C:\Program Files\Offset Security\Offset Aware"
   ```
3. Run the reset script:
   ```powershell
   .\reset_admin_password.bat
   ```
4. Follow the prompt to enter the Admin Username (e.g., `admin`) and the new password. The script will securely hash the new password and inject it directly into the database.
