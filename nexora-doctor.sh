#!/usr/bin/env bash
# NEXORA Doctor — environment report
# Usage: bash nexora-doctor.sh
# (Run this with the same shell/venv you intend to use for LiteLLM, so
#  the Python/pip checks reflect the right environment.)

echo "=== NEXORA Doctor — environment report ==="
echo ""

echo "-- System --"
echo "macOS arch: $(uname -m)"
sw_vers 2>/dev/null || true
echo ""

echo "-- Python --"
if command -v python3 >/dev/null 2>&1; then
  echo "python3: $(command -v python3)"
  python3 --version
else
  echo "python3: NOT FOUND"
fi
if command -v pip3 >/dev/null 2>&1; then
  pip3 --version
else
  echo "pip3: NOT FOUND"
fi
echo ""

echo "-- Rust toolchain (only needed as a fallback for source builds) --"
if command -v rustc >/dev/null 2>&1; then
  rustc --version
else
  echo "rustc: not installed (fine as long as prebuilt wheels install successfully)"
fi
echo ""

echo "-- Node / pnpm (required for OpenClaw / NEXORA core) --"
command -v node >/dev/null 2>&1 && node --version || echo "node: NOT FOUND"
command -v pnpm >/dev/null 2>&1 && pnpm --version || echo "pnpm: NOT FOUND"
echo ""

echo "-- yt-dlp (yt-transcript extension) --"
command -v yt-dlp >/dev/null 2>&1 && yt-dlp --version || echo "yt-dlp: NOT FOUND"
echo ""

echo "-- LiteLLM (in the currently active Python environment) --"
python3 -c "import litellm; print('litellm:', litellm.__version__)" 2>/dev/null \
  || echo "litellm: NOT INSTALLED in current environment"
echo ""

echo "-- Key Rust-backed Python packages --"
for pkg in pydantic-core orjson tiktoken fastuuid; do
  python3 -c "import importlib.metadata as m; print('$pkg:', m.version('$pkg'))" 2>/dev/null \
    || echo "$pkg: NOT INSTALLED"
done
echo ""

echo "-- LiteLLM proxy server status (localhost:4000) --"
if command -v curl >/dev/null 2>&1; then
  CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:4000/health/liveliness 2>/dev/null)
  if [ -n "$CODE" ] && [ "$CODE" != "000" ]; then
    echo "HTTP $CODE (proxy appears reachable)"
  else
    echo "Not reachable on :4000 (proxy not running, or not yet launched)"
  fi
else
  echo "curl not found, cannot check"
fi
echo ""

echo "-- OpenClaw config (~/.openclaw/config.json) --"
CONFIG="$HOME/.openclaw/config.json"
if [ -f "$CONFIG" ]; then
  echo "Found: $CONFIG"
  python3 - "$CONFIG" <<'PYEOF'
import json, sys
path = sys.argv[1]
with open(path) as f:
    cfg = json.load(f)
entries = cfg.get("plugins", {}).get("entries", {})
lancedb = entries.get("memory-lancedb", {})
print("memory-lancedb enabled:", lancedb.get("enabled", False))
print("Registered plugin entries:", list(entries.keys()) or "(none)")
PYEOF
else
  echo "NOT FOUND at $CONFIG"
fi
echo ""

echo "=== End of report ==="
