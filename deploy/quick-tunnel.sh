#!/usr/bin/env bash
#
# Runs a Cloudflare quick tunnel for the Connect Four server and wires the
# hostname it is given back into the game server.
#
# A quick tunnel gets a NEW hostname every time it starts. The server checks
# Origin on the WebSocket upgrade (CSWSH defence), so a stale ALLOWED_ORIGINS
# means the page loads and the board never does — which looks like a broken
# game rather than a config mismatch. Hard-coding the hostname in the unit
# file makes every restart a manual edit; this publishes it instead.
#
# Run under systemd (connect-four-tunnel.service) so it is supervised. It was
# previously a bare background process, and when that shell died the public
# URL went to HTTP 530 with nothing to restart it.

set -uo pipefail

ORIGIN_ENV="${ORIGIN_ENV:-$HOME/.config/connect-four/origins.env}"
LOG="${TUNNEL_LOG:-$HOME/.cache/connect-four/tunnel.log}"
TARGET="${TARGET:-http://127.0.0.1:3000}"

mkdir -p "$(dirname "$ORIGIN_ENV")" "$(dirname "$LOG")"
: > "$LOG"

# --config /dev/null is load-bearing. Without it cloudflared reads
# ~/.cloudflared/config.yml and inherits that tunnel's ingress rules,
# including its trailing `http_status:404` catch-all, so every request 404s
# for no visible reason.
cloudflared tunnel --config /dev/null --no-autoupdate --url "$TARGET" \
  >>"$LOG" 2>&1 &
CFD_PID=$!

# Stop cloudflared when systemd stops us. Kill only our own child — never
# pkill cloudflared, there are other tunnels on this machine (eam-sync,
# tenantops, phone-agent) and killing them is someone else's outage.
trap 'kill "$CFD_PID" 2>/dev/null; exit 0' TERM INT

# Wait for the hostname to appear in the log.
HOSTNAME_URL=""
for _ in $(seq 1 60); do
  if ! kill -0 "$CFD_PID" 2>/dev/null; then
    echo "cloudflared exited before announcing a hostname; last log lines:" >&2
    tail -n 20 "$LOG" >&2
    exit 1
  fi
  HOSTNAME_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" \
    | head -n1 || true)
  [ -n "$HOSTNAME_URL" ] && break
  sleep 1
done

if [ -z "$HOSTNAME_URL" ]; then
  echo "timed out waiting for a quick-tunnel hostname; last log lines:" >&2
  tail -n 20 "$LOG" >&2
  kill "$CFD_PID" 2>/dev/null
  exit 1
fi

echo "quick tunnel up: $HOSTNAME_URL"

# Publish it, then restart the server so its Origin allowlist matches.
umask 022
printf 'ALLOWED_ORIGINS=%s\n' "$HOSTNAME_URL" > "$ORIGIN_ENV"
systemctl --user restart connect-four.service || \
  echo "warning: could not restart connect-four.service" >&2

# Drop any cached negative answer for the new name. cloudflared announces the
# hostname a moment before it is resolvable, so anything that looked it up in
# that window — a browser, a health check, a test — cached an NXDOMAIN and will
# keep reporting the URL as dead long after it works. Best effort only.
resolvectl flush-caches 2>/dev/null || true

wait "$CFD_PID"
