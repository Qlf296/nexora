#!/usr/bin/env bash
# NEXORA Hub — VPS deployment helper
# Run this from your Mac: ./deploy-vps.sh
#
# Prerequisites on the VPS (already installed per your setup):
#   - Docker + Docker Compose
#   - Git
#   - ~/Halim-AI cloned from https://github.com/Qlf296/nexora.git
#
# Usage:
#   chmod +x deploy-vps.sh
#   ./deploy-vps.sh root@2.29.137.252

set -euo pipefail

VPS="${1:-root@2.29.137.252}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌ No .env file found at $ENV_FILE"
  echo "   Create it first with your 5 API keys."
  exit 1
fi

echo "🚀 Deploying NEXORA Hub to $VPS …"
echo ""

# Step 1: Copy .env to VPS
echo "[1/3] Copying .env to VPS …"
scp "$ENV_FILE" "$VPS:~/Halim-AI/nexora-hub/.env"
ssh "$VPS" "chmod 600 ~/Halim-AI/nexora-hub/.env"
echo "      ✅ .env copied and secured (chmod 600)"

# Step 2: Pull latest code on VPS
echo "[2/3] Pulling latest code on VPS …"
ssh "$VPS" '
  set -e
  cd ~/Halim-AI
  git fetch origin nexora-clean
  git checkout nexora-clean
  git pull origin nexora-clean
  echo "      ✅ Code updated — $(git log --oneline -1)"
'

# Step 3: Build and start the container
echo "[3/3] Building and starting Docker container …"
ssh "$VPS" '
  set -e
  cd ~/Halim-AI/nexora-hub
  docker compose down --remove-orphans 2>/dev/null || true
  docker compose up -d --build
  sleep 3
  docker compose ps
  echo ""
  echo "      ✅ Container status:"
  docker ps --filter name=nexora-hub --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
'

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎉  NEXORA Hub deployed!"
echo "    Local:     http://2.29.137.252:3001"
echo "    Tailscale: http://<tailscale-ip>:3001"
echo "    Health:    curl http://2.29.137.252:3001/healthz"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
