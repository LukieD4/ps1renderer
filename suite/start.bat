@echo off
REM start.bat - launches scene-gen's local static server and opens it
REM in the default browser. Double-click this file instead of running
REM `node serve.js` by hand. Requires Node.js to be installed and on PATH.

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js was not found on PATH. Install it from https://nodejs.org
    echo then re-run this file.
    pause
    exit /b 1
)

start "" http://localhost:8420/index.html
node tools/scene-gen/serve.js 8420