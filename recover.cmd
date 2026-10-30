@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\recover-codex.ps1" -Interactive
if errorlevel 1 pause
endlocal
