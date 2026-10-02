@echo off
cd /d "%~dp0"
node --experimental-strip-types scripts/start.ts
if errorlevel 1 pause
