@echo off
setlocal
title Stop Video Splitter
cd /d "%~dp0"

echo.
echo    Stopping Video Splitter
echo    ==========================================
echo.

rem Only the process using port 5174 is stopped, so other Node programs you
rem happen to be running are left alone. netstat is asked rather than
rem Get-NetTCPConnection, which on some computers does not list the app's
rem port at all and so left it running. If neither finds it, the Node process
rem running server\index.js is stopped instead.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ids = @(netstat -ano | ForEach-Object { $p = @(($_ -split '\s+') | Where-Object { $_ }); if ($p.Count -ge 5 -and $p[1] -match ':5174$' -and $p[4] -ne '0') { [int]$p[4] } } | Select-Object -Unique);" ^
  "if (-not $ids.Count) { $ids = @(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'server.index\.js' } | ForEach-Object { $_.ProcessId }) };" ^
  "if ($ids.Count) {" ^
  "  $ids | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue };" ^
  "  Write-Host '   Stopped.';" ^
  "} else {" ^
  "  Write-Host '   It was not running.';" ^
  "}"

echo.
ping -n 3 127.0.0.1 >nul 2>&1
