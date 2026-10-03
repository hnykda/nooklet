#!/bin/bash
# Runs the REAL app on the iOS Simulator already "connected" to a server, without tapping through
# ConnectView (no tap automation here): injects a script into the built public/index.html that
# writes the exact localStorage state `data/connect-graph.ts#connectToGraph` leaves behind
# (`nooklet.graphs` + `nooklet.activeGraphId`), once, then lets the app boot normally. Proves the
# post-connect path — boot, bootstrap pull, sync worker, live socket — against a real server
# through the real WKWebView. The connect form itself is covered by ConnectView.test.tsx.
#
#   pnpm ios:sync   # real build into public/
#   GRAPH_BASE=http://192.168.1.5:6377/g/default TOKEN=nk_... OUT=app.png \
#     tools/probes/capacitor-network/seed-real-app.sh
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
PUB="$ROOT/apps/web/ios/App/App/public"
DERIVED=${DERIVED:-/tmp/nooklet-probe-derived}
: "${GRAPH_BASE:?}" "${TOKEN:?}" "${OUT:=app.png}"

SEED="<script>if(!localStorage.getItem('nooklet.graphs')){localStorage.setItem('nooklet.graphs',JSON.stringify([{id:'probe-entry',label:'probe server',kind:'remote',baseUrl:'$GRAPH_BASE',token:'$TOKEN'}]));localStorage.setItem('nooklet.activeGraphId','probe-entry');}</script>"
# Insert right after <head> so it runs before the app's module script.
perl -0pi -e "s|<head>|<head>$SEED|" "$PUB/index.html"
grep -q "probe-entry" "$PUB/index.html"

cd "$ROOT/apps/web/ios/App"
xcodebuild -project App.xcodeproj -scheme App -sdk iphonesimulator -configuration Debug \
  -derivedDataPath "$DERIVED" build -quiet
APP="$DERIVED/Build/Products/Debug-iphonesimulator/App.app"
xcrun simctl terminate booted sh.nooklet.app 2>/dev/null || true
xcrun simctl uninstall booted sh.nooklet.app 2>/dev/null || true
xcrun simctl install booted "$APP"
xcrun simctl launch booted sh.nooklet.app
sleep "${WAIT:-20}"
xcrun simctl io booted screenshot "$OUT"
