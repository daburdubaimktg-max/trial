@echo off
rem Double-click this file to start Nova on Windows.
title Nova
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS installer from https://nodejs.org, run it, then double-click this file again.
  pause
  exit /b 1
)

echo Checking Nova's components. The first run downloads them and takes a few minutes...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo Setup did not finish. Check your internet connection and try again.
  pause
  exit /b 1
)

echo Starting Nova. Keep this window open while you use it.
call npm start
if errorlevel 1 pause
