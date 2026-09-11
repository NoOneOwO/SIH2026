#!/bin/bash
echo "============================================"
echo "  DamSafe Twin - Starting all services"
echo "============================================"
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "[1/2] Starting GeoLibre (3D Earth)..."
cd "$SCRIPT_DIR/../GeoLibre-main/GeoLibre-main/apps/geolibre-desktop"
npm run dev &
GEOLIBRE_PID=$!

echo "[2/2] Starting DamSafe Twin Frontend..."
cd "$SCRIPT_DIR"
npm run dev &
DAMSAFE_PID=$!

echo ""
echo "============================================"
echo "  All services started!"
echo "  DamSafe Twin:  http://localhost:3000"
echo "  GeoLibre:      http://localhost:5175"
echo "============================================"

wait $GEOLIBRE_PID $DAMSAFE_PID
