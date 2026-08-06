@echo off
setlocal
cd /d "%~dp0"

title Restaurant POS Server - do not close during service

where node >nul 2>&1
if errorlevel 1 (
    echo Node.js is not installed. Run 1-SETUP.bat first.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo Components are not installed yet. Run 1-SETUP.bat first.
    pause
    exit /b 1
)

if not exist ".env" (
    echo Configuration is missing. Run 1-SETUP.bat first.
    pause
    exit /b 1
)

echo.
echo ==========================================================
echo   Restaurant POS is starting
echo ==========================================================
echo.
echo   Keep this window OPEN while the restaurant is trading.
echo   Closing it stops every till.
echo.
echo   The address for other tills is printed below as "lan".
echo   Open it in Chrome on each tablet or PC.
echo.
echo   Press Ctrl+C to stop the server at end of day.
echo.
echo ----------------------------------------------------------
echo.

call npm start

echo.
echo ----------------------------------------------------------
echo   The POS server has stopped.
echo.
echo   If this was not intentional, read the message above and
echo   run 2-START-POS.bat again. No sales are lost - they are
echo   saved as they happen.
echo ----------------------------------------------------------
echo.
pause
