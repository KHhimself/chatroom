@echo off
echo Starting chatroom server...

REM Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Error: Node.js not installed
    echo Please install Node.js: https://nodejs.org/
    pause
    exit /b 1
)

REM Check if dependencies are installed
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
)

REM Start server
echo Server starting at http://localhost:3000
call npm start
pause 