@echo off
rem NOTE: keep this file pure ASCII - cmd.exe reads .bat with the local ANSI code page.
setlocal
cd /d "%~dp0"

rem Some environments export this; it would make Electron run in Node mode.
set ELECTRON_RUN_AS_NODE=

if not exist "node_modules\electron\dist\electron.exe" (
  echo [minibrowser] first run, installing dependencies...
  call npm install
  if errorlevel 1 (
    echo [minibrowser] install failed, check your network and retry.
    pause
    exit /b 1
  )
)

rem Extra args are forwarded, e.g.  start.cmd --disable-gpu
start "" "node_modules\electron\dist\electron.exe" . %*
