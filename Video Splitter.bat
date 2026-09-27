@echo off
setlocal
title Video Splitter
cd /d "%~dp0"

echo.
echo    Video Splitter
echo    ==========================================
echo.

rem --- Already running? Just bring it up rather than failing on a busy port.
netstat -an | findstr ":5174" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo    Already running. Opening it in your browser.
    start "" http://127.0.0.1:5174
    exit /b 0
)

rem --- Node is the one hard requirement.
where node >nul 2>&1
if errorlevel 1 (
    echo    Node.js is not installed, or not on your PATH.
    echo.
    echo    Install it from https://nodejs.org then run this again.
    echo.
    pause
    exit /b 1
)

rem --- FFmpeg is only needed for cutting, so warn but carry on.
where ffmpeg >nul 2>&1
if errorlevel 1 (
    echo    [!] FFmpeg was not found on your PATH.
    echo        Sorting will work. Cutting and removing audio will not.
    echo.
)

rem --- First run only. This is the one step that needs internet.
if not exist "node_modules" (
    echo    First run: installing dependencies.
    echo    This step needs an internet connection. It happens once.
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo    Install failed. Check your connection and try again.
        echo.
        pause
        exit /b 1
    )
    echo.
)

rem --- Build the interface if it is missing. Delete the dist folder to force
rem     a rebuild after changing the code.
if not exist "dist\index.html" (
    echo    Preparing the interface, one moment...
    call npm run build >nul 2>&1
    if errorlevel 1 (
        echo    Could not build the interface.
        echo.
        pause
        exit /b 1
    )
    echo.
)

echo    Running at http://127.0.0.1:5174
echo    Your browser opens as soon as it is ready.
echo.
echo    Keep this window open while you work.
echo    Close it, or press Ctrl+C, to stop.
echo    ==========================================
echo.

rem --- Poll until the server actually answers, then open the browser. Waiting
rem     on a fixed timer opens an error page when the first run is slow.
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "$u='http://127.0.0.1:5174'; for($i=0;$i -lt 60;$i++){ try { Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 1 | Out-Null; Start-Process $u; break } catch { Start-Sleep -Milliseconds 400 } }"

node server\index.js

echo.
echo    Stopped.
ping -n 4 127.0.0.1 >nul 2>&1
