@echo off
REM DamSafe Twin - E-drive starter (keeps C: clean)
set NPM_CONFIG_CACHE=E:\.caches\npm-cache
set PIP_CACHE_DIR=E:\.caches\pip-cache
set TEMP=E:\.tmp
set TMP=E:\.tmp
set VITE_CACHE_DIR=E:\.caches\vite

echo Starting backend (port 8000)...
start "DamSafe Backend" cmd /c "E:\DAMSafe-Twin-SIH-terrain-30-dams\backend\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000"
echo Starting frontend (port 3000)...
cd /d "E:\DAMSafe-Twin-SIH-terrain-30-dams\frontend"
start "DamSafe Frontend" cmd /c "npm run dev -- --host localhost --port 3000"
echo.
echo Frontend: http://localhost:3000
echo Backend:  http://127.0.0.1:8000/health  docs: http://127.0.0.1:8000/api/docs
