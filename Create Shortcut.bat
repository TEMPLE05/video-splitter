@echo off
setlocal
cd /d "%~dp0"

echo.
echo    Creating a Video Splitter shortcut
echo    ==========================================
echo.

if not exist "assets\icon.ico" (
    echo    assets\icon.ico is missing, so the shortcut would have
    echo    no icon. Re-download the project and try again.
    echo.
    pause
    exit /b 1
)

rem The shortcut runs launch.vbs through wscript.exe: it starts the server if
rem it is not running (with no console window), then opens the app. Targeting
rem an executable is also what lets Windows pin it and show the icon.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$dir = '%~dp0'.TrimEnd('\');" ^
  "$lnk = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Video Splitter.lnk'));" ^
  "$lnk.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe';" ^
  "$lnk.Arguments = '\"' + (Join-Path $dir 'launch.vbs') + '\"';" ^
  "$lnk.WorkingDirectory = $dir;" ^
  "$lnk.IconLocation = (Join-Path $dir 'assets\icon.ico') + ',0';" ^
  "$lnk.Description = 'Sort and cut your saved videos';" ^
  "$lnk.WindowStyle = 1;" ^
  "$lnk.Save();" ^
  "Write-Host '   Done. Video Splitter is on your Desktop.'"

if errorlevel 1 (
    echo.
    echo    Could not create the shortcut.
    echo.
    pause
    exit /b 1
)

echo.
echo    To pin it: right-click the Desktop shortcut,
echo    then Pin to taskbar. If you do not see that option,
echo    try Show more options first on Windows 11.
echo.
pause
