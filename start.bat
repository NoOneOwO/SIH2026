@echo off
REM DamSafe Twin - local starter (Windows)
REM Backend :8000 + Frontend :3000. Uses backend\.venv if present, else system python.
echo ============================================
echo   DamSafe Twin - Starting all services
echo ============================================
echo.

set ROOT=%~dp0
if exist "%ROOT%backend\.venv\Scripts\python.exe" (
  set PY=%ROOT%backend\.venv\Scripts\python.exe
) else (
  set PY=python
)

echo [1/2] Starting backend (port 8000)...
start "DamSafe Backend" cmd /c "cd /d "%ROOT%backend" && "%PY%" -m uvicorn app.main:app --host 127.0.0.1 --port 8000"

echo [2/2] Starting frontend (port 3000)...
start "DamSafe Frontend" cmd /c "cd /d "%ROOT%frontend" && npm run dev -- --host localhost --port 3000"

echo.
echo ============================================
echo   Backend:  http://127.0.0.1:8000/health  docs: http://127.0.0.1:8000/api/docs
echo   Frontend: http://localhost:3000
echo   Full stack (Docker): cd infra ^&^& docker compose up --build
echo ============================================
echo.
pause
