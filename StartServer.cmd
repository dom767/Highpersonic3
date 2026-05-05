@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%StartServer.ps1"

if not exist "%PS_SCRIPT%" (
  echo Could not find StartServer.ps1 next to this file.
  echo Expected: "%PS_SCRIPT%"
  pause
  exit /b 1
)

echo Starting local server...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
  echo Server exited successfully.
) else (
  echo Server exited with code %EXIT_CODE%.
)
pause

exit /b %EXIT_CODE%
