#!/usr/bin/env bash
# NEXORA Hub — local dev launcher
# Loads .env, then starts server.js with Node 18+.
# Usage: ./start.sh [--port 3001]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

if [[ -f "$ENV_FILE" ]]; then
  # Export every non-comment, non-empty line from .env
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  echo "[nexora] ✅  Loaded .env from $ENV_FILE"
else
  echo "[nexora] ⚠️   No .env found — starting without custom env vars"
fi

PORT="${PORT:-3001}"
echo "[nexora] 🚀  Starting on port $PORT …"
exec node "$SCRIPT_DIR/server.js"
