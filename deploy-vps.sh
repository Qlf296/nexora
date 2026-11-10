#!/usr/bin/env bash
# NEXORA Hub — 24/7 VPS deployment (Hetzner, Ubuntu, Tailscale 100.121.35.82)
#
# WHERE TO RUN THIS: on the VPS itself, via SSH, from the project root (~/Halim-AI).
# Claude cannot execute this remotely — there is no SSH/VPS connector available in
# this session, so this script is meant to be copy-pasted into your own terminal.
#
# WHAT THIS ACTUALLY DOES (corrects two wrong assumptions in the original ask):
#   - There is no aiRouter.js / providerRegistry.js anywhere in the project. The
#     routing logic is nexora-hub/server.js (pickModel/handleChat), and the real
#     multi-provider wiring lives in litellm-config.yaml, read by a SEPARATE
#     LiteLLM proxy process — not inside nexora-hub.
#   - nexora-hub/package.json has zero dependencies ("dependencies": {}), so
#     `npm install` is a no-op there. The actual providers currently configured
#     in litellm-config.yaml are Groq, Gemini, and Ollama (free tier) plus
#     Claude/Anthropic (pro tier) — NOT OpenRouter, SambaNova, or NVIDIA NIM.
#     Those three aren't wired up anywhere in this repo; say the word and I'll
#     add deployment entries for them once you have their API keys.
#   - The existing LiteLLM setup (launchd/start-litellm.sh) is macOS-only
#     (launchd doesn't exist on Linux), so it can't be reused as-is on this
#     Ubuntu VPS. This script runs LiteLLM as a second Docker container instead,
#     alongside nexora-hub, both with restart: unless-stopped.
#   - This script now clones/syncs from https://github.com/Qlf296/nexora.git
#     (step 1.5) before building, instead of just assuming ~/Halim-AI already
#     has the latest code. That was the actual cause of the Utrecht team-
#     availability schedule being missing on the deployed dashboard: nothing
#     ever pulled new commits onto the VPS. Safe to re-run any time — it
#     clones on first run, then fetch + hard-reset to origin/main on every
#     later run. .env is untracked and is never touched by the sync.
set -euo pipefail

### 1) Docker Engine + Compose plugin ###
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
  echo ">>> Log out/in (or run: newgrp docker) so the group change applies, then re-run this script."
  exit 0
fi
sudo systemctl enable --now docker

### 1.5) Sync code from git — keeps the VPS up to date with origin/main ###
#     (Qlf296/nexora on GitHub). This is what was missing before: the script
#     used to just `cd` into an existing checkout and never pulled new code,
#     so VPS re-runs kept redeploying stale files even after local commits.
NEXORA_REPO="https://github.com/Qlf296/nexora.git"
NEXORA_DIR="$HOME/Halim-AI"

if [ ! -d "$NEXORA_DIR/.git" ]; then
  echo ">>> Cloning $NEXORA_REPO into $NEXORA_DIR ..."
  git clone "$NEXORA_REPO" "$NEXORA_DIR"
else
  echo ">>> Syncing $NEXORA_DIR with origin/main ..."
  cd "$NEXORA_DIR"
  git fetch origin
  git reset --hard origin/main
  echo ">>> NOTE: 'git reset --hard' overwrote any local edits to tracked files"
  echo "    (e.g. manual litellm-config.yaml tweaks made directly on the VPS)."
  echo "    .env is untracked by git, so it is never touched by this sync."
fi

cd "$NEXORA_DIR"

### 2) Secrets — .env next to docker-compose.yml, never committed to git ###
if [ ! -f .env ]; then
  cat > .env <<'EOF'
GROQ_API_KEY=replace-me
GEMINI_API_KEY=replace-me
ANTHROPIC_API_KEY=replace-me
LITELLM_MASTER_KEY=replace-with-a-long-random-secret
EOF
  chmod 600 .env
  echo ">>> Created .env — edit it with real keys first: nano .env"
  echo ">>> Also rotate LITELLM_MASTER_KEY away from the repo default (sk-nexora-local-1234)."
  exit 0
fi

### 3) Add a litellm service to docker-compose.yml (one-time, idempotent) ###
if ! grep -q "^  litellm:" docker-compose.yml; then
  cat >> docker-compose.yml <<'YAML'

  litellm:
    image: ghcr.io/berriai/litellm:main-latest
    restart: unless-stopped
    env_file:
      - path: .env
        required: true
    volumes:
      - ./litellm-config.yaml:/app/config.yaml:ro
    command: ["--config", "/app/config.yaml", "--port", "4000"]
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:4000/health/liveliness"]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 15s
YAML
  echo ">>> Added litellm service to docker-compose.yml."
fi

### 4) Point nexora-hub at the litellm container instead of host.docker.internal ###
sed -i 's#LITELLM_BASE_URL: \${LITELLM_BASE_URL:-http://host.docker.internal:31140}#LITELLM_BASE_URL: ${LITELLM_BASE_URL:-http://litellm:4000}#' docker-compose.yml

echo ">>> NOTE: litellm-config.yaml has a model deployment for Ollama"
echo "    (ollama/llama3.1, api_base from OLLAMA_API_BASE). There is no Ollama"
echo "    running on this VPS. Either install Ollama here too, or comment out"
echo "    that block (lines defining model_name: nexora-free / model: ollama/llama3.1)"
echo "    in litellm-config.yaml before continuing, so LiteLLM doesn't trip on it."
read -p "Press Enter once litellm-config.yaml is fine to use as-is... "

### 5) Build and launch both services — restart: unless-stopped = survives reboot & SSH logout ###
docker compose up -d --build litellm nexora-hub

### 6) Verify ###
sleep 5
docker compose ps
curl -fsS http://localhost:4000/health/liveliness && echo " <- litellm OK" || echo " !! litellm not responding yet, check: docker compose logs litellm"
curl -fsS http://localhost:3001/healthz && echo " <- nexora-hub OK" || echo " !! nexora-hub not responding yet, check: docker compose logs nexora-hub"

echo ""
echo ">>> If both checks above are OK, the dashboard is reachable at:"
echo "    http://100.121.35.82:3001   (over Tailscale)"
echo "    http://<VPS-public-IP>:3001 (if port 3001 is open on the Hetzner firewall)"
