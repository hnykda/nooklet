#!/bin/bash
# B-647: screenshots of the page-icon picker in Mobile Safari on the iOS Simulator, at phone width.
# Headless: your OWN device only (create one: `xcrun simctl create icon-picker "iPhone 16"
# <runtime>`), never Simulator.app, never `booted`.
#
# Serves a COPY of apps/web/dist with driver.js injected (the real build is untouched), on PORT,
# with its own throwaway data dir, seeds one page, opens it twice (browsing, then searching
# "rocket") and screenshots each.
#
#   pnpm --filter @nooklet/web build
#   UDID=<device> PORT=6431 OUT=<dir> tools/probes/icon-picker-sim/run.sh
set -euo pipefail
: "${UDID:?}" "${PORT:?}" "${OUT:?}"
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$OUT"
WEB="$OUT/web"
DATA="$OUT/data"
rm -rf "$WEB" && cp -R "$ROOT/apps/web/dist" "$WEB" && mkdir -p "$DATA"
cp "$ROOT/tools/probes/icon-picker-sim/driver.js" "$WEB/icon-picker-sim.js"
perl -0pi -e 's|<head>|<head><script src="/icon-picker-sim.js"></script>|' "$WEB/index.html"

(cd "$ROOT" && NOOKLET_DATA="$DATA" pnpm nooklet serve --data "$DATA" --port "$PORT" --web "$WEB" \
  >"$OUT/serve.log" 2>&1) &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true; pkill -f "serve --data $DATA" 2>/dev/null || true' EXIT
for _ in $(seq 60); do curl -sf "http://127.0.0.1:$PORT/g/default/" >/dev/null && break; sleep 1; done

BASE="http://127.0.0.1:$PORT/g/default"
TOKEN=$(curl -s "$BASE/" | grep -o '"token":"nk_[0-9a-f]*"' | cut -d'"' -f4)
api() { curl -sf -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "$2" "$BASE/api/v1/$1" >/dev/null; }
api page.create '{"name":"Icon Picker Sim","if_exists":"return"}'
api page.append '{"page":"Icon Picker Sim","markdown":"- a block on the page"}'

xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null
shot() { xcrun simctl io "$UDID" screenshot "$OUT/$1.png" >/dev/null 2>&1; echo "shot $OUT/$1.png"; }
xcrun simctl openurl "$UDID" "$BASE/page/Icon%20Picker%20Sim#picker"
sleep 15; shot picker-browse
xcrun simctl openurl "$UDID" "$BASE/page/Icon%20Picker%20Sim?s=2#picker=rocket"
sleep 10; shot picker-search-rocket
