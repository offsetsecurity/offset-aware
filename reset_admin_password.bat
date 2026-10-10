@echo off
title Reset Admin Password
color 0E
cd /d "%~dp0"

:: The portal's database is only writable by administrators, so this asks for
:: that itself rather than failing with a permissions error the person has to
:: interpret.
net session >nul 2>&1
if errorlevel 1 (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo ========================================================
echo        OFFSET AWARE - PASSWORD RESET UTILITY
echo ========================================================
echo.
echo Use this utility if you have been locked out of your Administrator account.
echo.

:: The installer brings its own Node.js, so use that. The older zip install has
:: none beside it and relies on the one on the machine. No parentheses in
:: this block: the install folder can contain them.
set "NODE_EXE=node"
if exist "%~dp0node.exe" set "NODE_EXE=%~dp0node.exe"

"%NODE_EXE%" reset_admin_password.js

echo.
pause
