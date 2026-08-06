@echo off
setlocal
cd /d "%~dp0"

echo.
echo ==========================================================
echo   Restaurant POS - first time setup
echo ==========================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo Node.js is not installed on this PC.
    echo.
    echo   1. Go to https://nodejs.org
    echo   2. Download the LTS version
    echo   3. Run the installer, clicking Next through the defaults
    echo   4. Close this window and run 1-SETUP.bat again
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node --version') do set NODEVER=%%v
echo Found Node.js %NODEVER%
echo.

echo Installing components. This takes a minute or two the first time...
echo.
call npm install
if errorlevel 1 (
    echo.
    echo Installation failed. The most common causes are no internet
    echo connection, or a firewall blocking npm.
    echo.
    pause
    exit /b 1
)

echo.
echo Preparing configuration...
call node scripts/setup.js
if errorlevel 1 (
    pause
    exit /b 1
)

echo.
echo Creating the workbook and your staff accounts...
echo.
call npm run seed
if errorlevel 1 (
    echo.
    echo Setup could not create the accounts. Read the message above.
    echo.
    pause
    exit /b 1
)

echo.
echo ==========================================================
echo   Setup complete.
echo.
echo   WRITE DOWN THE PINS SHOWN ABOVE. They are not shown again.
echo.
echo   Now run 2-START-POS.bat to start taking orders.
echo ==========================================================
echo.
pause
