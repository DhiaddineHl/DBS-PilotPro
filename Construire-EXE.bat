@echo off
title Construction PilotPro-Serveur.exe
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 ( echo Installez Node.js d abord : https://nodejs.org & pause & exit /b )
echo Construction de l executable Windows en cours...
echo (La premiere fois cela telecharge Node : patientez quelques minutes)
echo.
call npx --yes @yao-pkg/pkg@latest server.js --targets node18-win-x64 --output PilotPro-Serveur.exe
echo.
echo ============================================================
echo  Termine : PilotPro-Serveur.exe est cree dans ce dossier.
echo  Gardez les dossiers "public" et "data" a cote de l exe.
echo ============================================================
pause
