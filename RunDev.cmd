@echo off
rem Wrapper only â€” logic is in actions\RunDev.mjs (guidelines/repository-commands.md).
setlocal
cd /d "%~dp0"
node "%~dp0actions\RunDev.mjs" %*
if errorlevel 1 (
  if not defined AC_NO_PAUSE pause
  exit /b 1
)
exit /b 0

