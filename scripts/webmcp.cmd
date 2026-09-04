@echo off
where bun >nul 2>nul
if errorlevel 1 (
  echo webmcp: Bun is required. Install Bun, then retry. 1>&2
  exit /b 127
)

set "plugin_root=%CLAUDE_PLUGIN_ROOT%"
if not defined plugin_root set "plugin_root=%PLUGIN_ROOT%"
if not defined plugin_root set "plugin_root=%~dp0.."

bun "%plugin_root%\cli\webmcp.ts" %*
exit /b %errorlevel%
