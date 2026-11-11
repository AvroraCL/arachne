@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0Arachne.exe" "%~dp0resources\workspace\workbench\console\scripts\release-mcp.mjs" %*
exit /b %errorlevel%
