@echo off
title Offset Aware - Automated Updater
color 0B
echo ========================================================
echo        OFFSET AWARE - AUTOMATED UPDATER
echo ========================================================
echo.
echo Launching Update Engine...
powershell.exe -ExecutionPolicy Bypass -File "%~dp0update.ps1"
pause
