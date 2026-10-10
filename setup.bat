@echo off
start /min powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0setup.ps1"
exit
