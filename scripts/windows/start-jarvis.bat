@echo off
title JARVIS — Local Autonomous AI OS
cd /d "%~dp0..\.."

:: Ensure Ollama local inference daemon is running if installed
where ollama >nul 2>nul
if %errorlevel%==0 (
    start "" /B ollama serve >nul 2>nul
)

:: Launch compiled Tauri native desktop app if available, else start local Node backend + browser
if exist "src-tauri\target\release\jarvis-desktop.exe" (
    start "" "src-tauri\target\release\jarvis-desktop.exe"
    exit /b 0
)

set NODE_ENV=production
start "" "http://127.0.0.1:3000"
npx tsx server.ts
