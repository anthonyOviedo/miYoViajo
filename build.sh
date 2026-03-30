#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "[miYoViajo] Construyendo bundle público (sin controles de edición)..."
npm run build:public

echo "[miYoViajo] Construyendo bundle admin (con controles de edición)..."
npm run build:admin

echo "[miYoViajo] ✓ dist-public/ y dist-admin/ listos"
