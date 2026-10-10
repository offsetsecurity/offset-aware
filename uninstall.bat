@echo off
:: Kept so that anyone who knew about this file, or wrote it into a runbook,
:: still has it working. The removal itself lives in uninstall.ps1, which is
:: also what Settings -> Apps runs, so there is one way out and not two that
:: drift apart.
::
:: It asks for administrator rights itself.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
