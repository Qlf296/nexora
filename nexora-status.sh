#!/usr/bin/env bash
# nexora-status.sh — full healthcheck of the NEXORA 24/7 ecosystem.
# Usage: bash nexora-status.sh
MASTER_KEY="sk-nexora-local-1234"
LITELLM_PORT=31140
OLLAMA_PORT=11434

echo "=== NEXORA Status ==="
echo ""

echo "-- launchd daemons --"
for label in com.nexora.ollama com.nexora.litellm; do
  LINE=$(launchctl list 2>/dev/null | grep "$label" || true)
  if [ -n "$LINE" ]; then
    echo "$label: LOADED  ->  $LINE"
  else
    echo "$label: NOT LOADED (run launchd/install-daemons.sh)"
  fi
done
echo ""

echo "-- Ollama (port $OLLAMA_PORT) --"
if curl -s -o /dev/null -w "HTTP %{http_code}\n" "http://localhost:$OLLAMA_PORT" 2>/dev/null; then
  :
else
  echo "unreachable"
fi
echo ""

echo "-- LiteLLM proxy healthcheck (port $LITELLM_PORT) --"
HEALTH=$(curl -s "http://localhost:$LITELLM_PORT/health" 2>/dev/null || echo "")
if [ -n "$HEALTH" ]; then
  echo "$HEALTH"
else
  echo "unreachable — check /tmp/nexora-litellm.error.log"
fi
echo ""

echo "-- Test completion against nexora-main --"
RESP=$(curl -s "http://localhost:$LITELLM_PORT/v1/chat/completions" \
  -H "Authorization: Bearer $MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"nexora-main","messages":[{"role":"user","content":"ping"}],"max_tokens":10}' \
  2>/dev/null || echo "")
if [ -n "$RESP" ]; then
  echo "$RESP"
else
  echo "no response"
fi
echo ""

echo "-- Tailscale --"
if command -v tailscale >/dev/null 2>&1; then
  TS_IP=$(tailscale ip -4 2>/dev/null || echo "")
  if [ -n "$TS_IP" ]; then
    echo "Tailscale IP: $TS_IP"
    echo "Remote URL (iOS / Mac distant): http://$TS_IP:$LITELLM_PORT/v1"
  else
    echo "Tailscale installed but not connected — run: sudo tailscale up"
  fi
else
  echo "Tailscale not installed — run setup-tailscale.sh"
fi
echo ""
echo "Local URL (ce Mac): http://localhost:$LITELLM_PORT/v1"
echo ""
echo "=== End of status ==="
