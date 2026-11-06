@echo off
rem DT Distribution local test: Avaris DS service + local web server. Needs Node.js 22.5 or newer (https://nodejs.org).
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this again.& pause & exit /b 1)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)" || (echo Node.js 22.5 or newer is needed. Install the LTS version from https://nodejs.org.& pause & exit /b 1)
echo Stopping an earlier local test if one is still open...
node tools\stop-local.js 8016 8090
echo Preparing the web front end...
node tools\build-frontend.js --if-changed || (echo Building the front end failed. & pause & exit /b 1)
set "DATA_DIR=%~dp0local\data"
set "AUTH_URL=http://210.13.55.114:9903/api/user/auth/me"
start "Avaris DS service" cmd /k node service\src\server.js
start "DT Distribution local web" cmd /k node local\devserver.js
timeout /t 3 /nobreak >nul
start "" http://localhost:8090
echo The DT Distribution local test is running at http://localhost:8090 . Close the two new windows to stop it.
