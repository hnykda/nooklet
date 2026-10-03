#!/bin/bash
# The real app on the iOS Simulator, HEADLESS: local-only, then add a server graph, then switch
# back (B-611/B-612). Drives the WKWebView through sim-driver.js (no tap automation exists here),
# relaunches with simctl, screenshots each state. Uses ONLY the device you pass (create your own:
# `xcrun simctl create local-graphs-$RANDOM "iPhone 17" <runtime>`; never `booted`), and never
# opens Simulator.app.
#
#   pnpm ios:sync
#   UDID=<your device> GRAPH_URL=http://127.0.0.1:6338/g/simg TOKEN=nk_... OUT=<dir> \
#     tools/probes/local-graphs/sim-run.sh
#
# Edits apps/web/ios/App/App/public/index.html (gitignored build output): run `pnpm ios:sync`
# afterwards to put the plain app back.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
PUB="$ROOT/apps/web/ios/App/App/public"
DERIVED=${DERIVED:-$OUT/derived}
: "${UDID:?}" "${GRAPH_URL:?}" "${TOKEN:?}" "${OUT:?}"
NOTE=${NOTE:-"SIM LOCAL NOTE $(date +%s)"}
PAUSE_MS=${PAUSE_MS:-8000}
mkdir -p "$OUT"

cp "$ROOT/tools/probes/local-graphs/sim-driver.js" "$PUB/lgsim-driver.js"
CFG="<script>window.LG_SIM={note:'$NOTE',graphUrl:'$GRAPH_URL',token:'$TOKEN',pauseMs:$PAUSE_MS};</script><script src=\"/lgsim-driver.js\"></script>"
grep -q lgsim-driver "$PUB/index.html" || perl -0pi -e "s|<head>|<head>$CFG|" "$PUB/index.html"

cd "$ROOT/apps/web/ios/App"
xcodebuild -project App.xcodeproj -scheme App -sdk iphonesimulator -configuration Debug \
  -destination "id=$UDID" -derivedDataPath "$DERIVED" build -quiet
APP="$DERIVED/Build/Products/Debug-iphonesimulator/App.app"
xcrun simctl terminate "$UDID" sh.nooklet.app 2>/dev/null || true
xcrun simctl uninstall "$UDID" sh.nooklet.app 2>/dev/null || true
xcrun simctl install "$UDID" "$APP"

shot() { xcrun simctl io "$UDID" screenshot "$OUT/$1.png" >/dev/null 2>&1; echo "shot $1"; }
echo "note: $NOTE"
xcrun simctl launch "$UDID" sh.nooklet.app >/dev/null
sleep 12; shot 1-local-note-typed
# A real relaunch: the process is killed and started again.
xcrun simctl terminate "$UDID" sh.nooklet.app
xcrun simctl launch "$UDID" sh.nooklet.app >/dev/null
sleep 6; shot 2-relaunched-local
sleep $((PAUSE_MS / 1000 + 10)); shot 3-server-graph
sleep $((PAUSE_MS / 1000)); shot 4-switcher-both-graphs
sleep $((PAUSE_MS / 1000 + 8)); shot 5-back-on-local
