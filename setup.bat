@echo off
REM EduNova X - Setup Script for Windows
SETLOCAL EnableDelayedExpansion

echo [32mStarting EduNova X Setup...[0m

REM 1. Check for Node.js
node -v >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [31mNode.js is not installed. Please install Node.js v20+.[0m
    exit /b 1
)

for /f "tokens=1,2,3 delims=v. " %%a in ('node -v') do set "NODE_VER=%%a"
if %NODE_VER% LSS 20 (
    echo [31mNode.js version must be v20 or higher. Current version: %NODE_VER%[0m
    exit /b 1
)

echo [32mNode.js version detected.[0m

REM 2. Install dependencies
echo [32mInstalling dependencies in root...[0m
call npm install

echo [32mInstalling dependencies in server...[0m
cd server && call npm install && cd ..

echo [32mInstalling dependencies in frontend...[0m
cd frontend && call npm install && cd ..

echo [32mInstalling dependencies in signaling...[0m
cd signaling && call npm install && cd ..

REM 3. AI Engine (Python)
echo [32mChecking AI Engine...[0m
python --version >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    cd ai_engine && python -m pip install -r requirements.txt && cd ..
) else (
    echo [33mPython not found, skipping AI Engine pip install.[0m
)

REM 4. Build Frontend
echo [32mBuilding Frontend...[0m
cd frontend && call npm run build && cd ..

REM 5. Native deps
echo [32mRebuilding native modules...[0m
cd server && call npm rebuild sharp && cd ..

echo [32mSetup Complete![0m
pause
