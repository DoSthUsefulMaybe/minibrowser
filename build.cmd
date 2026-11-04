@echo off
rem NOTE: keep this file pure ASCII - cmd.exe reads .bat with the local ANSI code page.
setlocal
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo [minibrowser] installing dependencies first...
  call npm install
  if errorlevel 1 goto fail
)

node build.js
if errorlevel 1 goto fail

echo.
echo Built. See dist\minibrowser\
pause
exit /b 0

:fail
echo.
echo Build failed.
pause
exit /b 1
