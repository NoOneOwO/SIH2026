@echo off
echo ============================================
echo   DamSafe Twin - Starting all services
echo ============================================
echo.

echo [1/2] Starting GeoLibre (3D Earth)...
cd /d "%~dp0..\GeoLibre-main\GeoLibre-main\apps\geolibre-desktop"
start "GeoLibre" cmd /c "npm run dev"

echo [2/2] Starting DamSafe Twin Frontend...
cd /d "%~dp0"
start "DamSafe Twin" cmd /c "npm run dev"

echo.
echo ============================================
echo   All services started!
echo   DamSafe Twin:  http://localhost:3000
echo   GeoLibre:      http://localhost:5175
echo ============================================
echo.
pause
