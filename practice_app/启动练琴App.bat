@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-practice-app.ps1" %*
if errorlevel 1 (
  echo.
  echo Could not start Piano Practice App. See the message above.
  pause
)
endlocal
