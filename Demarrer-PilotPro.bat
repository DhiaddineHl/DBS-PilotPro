@echo off
title PilotPro - Serveur DBS Fashion
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js n est pas installe sur ce PC.
  echo  Telechargez la version LTS sur https://nodejs.org puis relancez ce fichier.
  echo.
  pause
  exit /b
)
node server.js
pause
