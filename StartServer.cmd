@echo off
setlocal
cd /d "%~dp0"
if not defined PORT set "PORT=8080"
echo Serving on http://localhost:%PORT%/
echo Close this window or press Ctrl+C to stop.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0StartServer.ps1"
if errorlevel 1 (
  if not defined AC_NO_PAUSE pause
  exit /b 1
)
exit /b 0
