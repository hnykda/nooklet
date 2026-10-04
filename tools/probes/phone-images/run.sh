#!/bin/bash
# Phone images + slash probe (B-682, B-683, B-684) on a PRIVATE headless Simulator, the real app
# connected to a scratch server. Never opens Simulator.app, never uses `booted` or `shutdown all`.
#
#   xcrun simctl create phone-images-probe "iPhone 17" com.apple.CoreSimulator.SimRuntime.iOS-26-5
#   xcrun simctl boot <udid>
#   xcrun simctl addmedia <udid> some.png          # what the photo picker offers
#   nooklet serve --data <scratch> --port 6481     # then seed today's journal through the API
#   pnpm ios:sync
#   UDID=<udid> OUT=<dir> GRAPH_BASE=http://127.0.0.1:6481/g/default TOKEN=nk_… \
#     [STEPS=slash,picker] tools/probes/phone-images/run.sh
#   pnpm ios:sync && xcrun simctl delete <udid>
#
# Injects, into the built public/index.html (gitignored build output): the localStorage state
# `connectToGraph` leaves behind (as ../capacitor-network/seed-real-app.sh does) and overlay.js.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
PUB="$ROOT/apps/web/ios/App/App/public"
: "${UDID:?}" "${OUT:?}" "${GRAPH_BASE:?}" "${TOKEN:?}"
DERIVED=${DERIVED:-$OUT/derived}
mkdir -p "$OUT"
cp "$ROOT/tools/probes/phone-images/overlay.js" "$PUB/probe-overlay.js"
SEED="<script>if(!localStorage.getItem('nooklet.graphs')){localStorage.setItem('nooklet.graphs',JSON.stringify([{id:'probe-entry',label:'probe server',kind:'remote',baseUrl:'$GRAPH_BASE',token:'$TOKEN'}]));localStorage.setItem('nooklet.activeGraphId','probe-entry');}</script>"
grep -q probe-overlay "$PUB/index.html" ||
  perl -0pi -e "s|<head>|<head>$SEED<script src=/probe-overlay.js></script>|" "$PUB/index.html"
(cd "$ROOT/apps/web/ios/App" && xcodebuild -project App.xcodeproj -scheme App -sdk iphonesimulator \
  -configuration Debug -destination "id=$UDID" -derivedDataPath "$DERIVED" build -quiet)
xcrun simctl terminate "$UDID" sh.nooklet.app 2>/dev/null || true
xcrun simctl uninstall "$UDID" sh.nooklet.app 2>/dev/null || true
xcrun simctl install "$UDID" "$DERIVED/Build/Products/Debug-iphonesimulator/App.app"
cd "$ROOT/tools/probes/phone-images"
TEST_RUNNER_SHOT_DIR="$OUT" TEST_RUNNER_STEPS="${STEPS:-slash,picker}" \
  xcodebuild test -project PhoneUIProbe.xcodeproj -scheme PhoneUIProbeTests \
  -destination "id=$UDID" -derivedDataPath "$DERIVED-tests" 2>&1 | grep -E "error|passed|failed|XCTAssert" || true
ls "$OUT"/*.png
