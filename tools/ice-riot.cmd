@echo off
rem ICE RIOT - double-click launcher for the game server.
rem Any arguments are passed through, e.g.:  ice-riot.cmd --port 9000   or   ice-riot.cmd --serve
setlocal
title ICE RIOT server
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ICE RIOT] Node.js was not found. Install Node 20 or newer from https://nodejs.org
  echo            then double-click this file again.
  echo.
  pause
  exit /b 1
)

echo [ICE RIOT] Starting the server in "%CD%"  (Ctrl+C to stop)
echo.
node server\server.js %*
set "RC=%ERRORLEVEL%"

rem -1073741510 = 0xC000013A: the window was closed / Ctrl+C. Not an error.
if "%RC%"=="-1073741510" set "RC=0"

if not "%RC%"=="0" (
  echo.
  echo [ICE RIOT] The server stopped with exit code %RC%.
  echo            Port busy? Try: tools\ice-riot.cmd --port 8766
  echo            Host checklist: powershell -ExecutionPolicy Bypass -File tools\setup.ps1
  echo.
  pause
)
endlocal & exit /b %RC%
