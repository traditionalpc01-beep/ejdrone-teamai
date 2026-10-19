@echo off
rem double-click wrapper for ejdrone-setup.ps1 (keeps the window open on failure)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ejdrone-setup.ps1" %*
if errorlevel 1 echo [X] setup did not finish - please screenshot this window for the admin
pause
