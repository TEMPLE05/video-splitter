@echo off
setlocal
title Stop Video Splitter
cd /d "%~dp0"

echo.
echo    Stopping Video Splitter
echo    ==========================================
echo.

rem Only the process actually holding port 5174 is stopped, so other Node
rem programs you happen to be running are left alone.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$c = Get-NetTCPConnection -LocalPort 5174 -State Listen -ErrorAction SilentlyContinue;" ^
  "if ($c) {" ^
  "  $c | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force };" ^
  "  Write-Host '   Stopped.';" ^
  "} else {" ^
  "  Write-Host '   It was not running.';" ^
  "}"

echo.
ping -n 3 127.0.0.1 >nul 2>&1
