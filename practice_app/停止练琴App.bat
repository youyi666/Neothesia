@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-practice-app.ps1"
if errorlevel 1 (
  echo.
  echo Could not stop Piano Practice App. See the message above.
  pause
)
endlocal
