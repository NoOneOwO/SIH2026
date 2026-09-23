#!/bin/bash
# DamSafe Twin - local starter (Linux/macOS)
# Backend :8000 + Frontend :3000. Uses backend/.venv if present, else system python3.
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -x "$SCRIPT_DIR/backend/.venv/bin/python" ]; then
  PY="$SCRIPT_DIR/backend/.venv/bin/python"
else
  PY="python3"
fi

echo "[1/2] Starting backend (port 8000)..."
cd "$SCRIPT_DIR/backend" && "$PY" -m uvicorn app.main:app --host 127.0.0.1 --port 8000 &
API_PID=$!

echo "[2/2] Starting frontend (port 3000)..."
cd "$SCRIPT_DIR/frontend" && npm run dev -- --host localhost --port 3000 &
WEB_PID=$!

echo ""
echo "Backend:  http://127.0.0.1:8000/health  docs: http://127.0.0.1:8000/api/docs"
echo "Frontend: http://localhost:3000"
echo "Full stack (Docker): cd infra && docker compose up --build"

wait $API_PID $WEB_PID
