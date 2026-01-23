@echo off
setlocal

REM Double-click launcher for Tree (Windows)
REM This calls start_tree.ps1 and bypasses execution policy for this run.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_tree.ps1"

endlocal
