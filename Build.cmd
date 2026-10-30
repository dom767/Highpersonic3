@echo off
rem Wrapper only — logic is in actions\Build.mjs (AgentController docs/RepositoryCommands.md).
setlocal
cd /d "%~dp0"
node "%~dp0actions\Build.mjs" %*
if errorlevel 1 (
  if not defined AC_NO_PAUSE pause
  exit /b 1
)
exit /b 0
