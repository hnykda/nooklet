#!/usr/bin/env bash
# Start a scratch `nooklet serve` for the device-readiness sweep (docs/review/2026-10-03-sweep-devices.md).
# Usage: serve.sh <datadir> <port> [host] [allow-host]  — logs to <datadir>/server.log, pid to <datadir>/server.pid
# A non-127.0.0.1 host (e.g. this Mac's LAN IP) makes every browser a NON-loopback client, so the
# server hands out no token automatically — the real situation for a phone or a second Mac.
set -euo pipefail
DATA=$1; PORT=$2; HOST=${3:-127.0.0.1}; ALLOW=${4:-}
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$ROOT/packages/server"
EXTRA=()
if [ "$HOST" != "127.0.0.1" ]; then EXTRA=(--host "$HOST" --allow-host "${ALLOW:-$HOST}"); elif [ -n "$ALLOW" ]; then EXTRA=(--allow-host "$ALLOW"); fi
NOOKLET_DATA="$DATA" nohup pnpm exec tsx src/cli.ts serve --data "$DATA" --port "$PORT" --web "$ROOT/apps/web/dist" ${EXTRA[@]+"${EXTRA[@]}"} >>"$DATA/server.log" 2>&1 &
echo $! > "$DATA/server.pid"
for i in $(seq 1 120); do
  curl -sf "http://$HOST:$PORT/healthz" >/dev/null && { echo "up on $HOST:$PORT"; exit 0; }
  sleep 0.5
done
echo "server did not come up"; tail -30 "$DATA/server.log"; exit 1
