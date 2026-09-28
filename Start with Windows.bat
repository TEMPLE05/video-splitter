@echo off
setlocal
title Video Splitter - start with Windows
cd /d "%~dp0"

echo.
echo    Video Splitter - start with Windows
echo    ==========================================
echo.
echo    This makes the server start quietly when you log in, so the
echo    app icon just works instead of saying the server is not running.
echo.
echo    Run this again to turn it back off.
echo.

rem Toggles a shortcut in the Startup folder. It points at wscript.exe running
rem start-hidden.vbs, so nothing appears on screen at login.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$dir = '%~dp0'.TrimEnd('\');" ^
  "$startup = [Environment]::GetFolderPath('Startup');" ^
  "$lnk = Join-Path $startup 'Video Splitter server.lnk';" ^
  "if (Test-Path $lnk) {" ^
  "  Remove-Item $lnk -Force;" ^
  "  Write-Host '   Turned OFF. The server will no longer start at login.';" ^
  "} else {" ^
  "  $ws = New-Object -ComObject WScript.Shell;" ^
  "  $s = $ws.CreateShortcut($lnk);" ^
  "  $s.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe';" ^
  "  $s.Arguments = '\"' + (Join-Path $dir 'start-hidden.vbs') + '\"';" ^
  "  $s.WorkingDirectory = $dir;" ^
  "  $s.IconLocation = (Join-Path $dir 'assets\icon.ico') + ',0';" ^
  "  $s.Description = 'Runs the Video Splitter server in the background';" ^
  "  $s.Save();" ^
  "  Write-Host '   Turned ON. The server will start quietly at login.';" ^
  "}"

echo.
echo    Starting it now as well, so you do not have to reboot.
echo.

netstat -an | findstr ":5174" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo    Already running.
) else (
    start "" wscript.exe "%~dp0start-hidden.vbs"
    echo    Started in the background.
)

echo.
echo    To stop it, run Stop Video Splitter.bat
echo.
pause
