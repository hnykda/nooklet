#!/bin/bash
# Phone input probe (B-662, B-664, B-661, B-684, B-705, B-706) on a PRIVATE headless Simulator,
# the real app connected to a scratch server. Never opens Simulator.app, never uses `booted` or
# `shutdown all`.
#
#   xcrun simctl create phone-input-probe "iPhone 17" com.apple.CoreSimulator.SimRuntime.iOS-26-5
#   xcrun simctl boot <udid>
#   NOOKLET_DATA=<scratch> nooklet serve --port 6521        # empty graph: today is a draft
#   pnpm ios:sync
#   UDID=<udid> OUT=<dir> GRAPH_BASE=http://127.0.0.1:6521/g/default TOKEN=nk_… \
#     STEPS=enter,blockslash,marker,hide [SMALL=1] [SECOND_BASE=… SECOND_TOKEN=…] \
#     tools/probes/phone-input/run.sh
#   pnpm ios:sync && xcrun simctl delete <udid>
#
# Each run reinstalls the app (fresh replica). Between runs, delete today's journal page through
# the API to get its empty draft back. Injects, into the built public/index.html (gitignored build
# output): the localStorage state `connectToGraph` leaves behind (as ../capacitor-network/
# seed-real-app.sh does) and overlay.js.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
PUB="$ROOT/apps/web/ios/App/App/public"
: "${UDID:?}" "${OUT:?}" "${GRAPH_BASE:?}" "${TOKEN:?}"
DERIVED=${DERIVED:-$OUT/../derived}
mkdir -p "$OUT"
cp "$ROOT/tools/probes/phone-input/overlay.js" "$PUB/probe-overlay.js"
if [ -n "${SMALL:-}" ]; then SMALL_JS="window.PROBE_SMALL_FIELD=true;"; else SMALL_JS="window.PROBE_SMALL_FIELD=false;"; fi
SEED="<script>${SMALL_JS}if(!localStorage.getItem('nooklet.graphs')){localStorage.setItem('nooklet.graphs',JSON.stringify([{id:'probe-entry',label:'probe server',kind:'remote',baseUrl:'$GRAPH_BASE',token:'$TOKEN'}]));localStorage.setItem('nooklet.activeGraphId','probe-entry');}</script>"
# Re-seed on every run (SMALL may differ): drop an earlier injection first.
perl -0pi -e 's|<script>window\.PROBE_SMALL_FIELD.*?</script><script src=/probe-overlay\.js></script>||s' "$PUB/index.html"
perl -0pi -e "s|<head>|<head>$SEED<script src=/probe-overlay.js></script>|" "$PUB/index.html"
(cd "$ROOT/apps/web/ios/App" && xcodebuild -project App.xcodeproj -scheme App -sdk iphonesimulator \
  -configuration Debug -destination "id=$UDID" -derivedDataPath "$DERIVED" build -quiet)
xcrun simctl terminate "$UDID" sh.nooklet.app 2>/dev/null || true
xcrun simctl uninstall "$UDID" sh.nooklet.app 2>/dev/null || true
xcrun simctl install "$UDID" "$DERIVED/Build/Products/Debug-iphonesimulator/App.app"
cd "$ROOT/tools/probes/phone-input"
TEST_RUNNER_SHOT_DIR="$OUT" TEST_RUNNER_STEPS="${STEPS:?}" \
  TEST_RUNNER_SECOND_BASE="${SECOND_BASE:-}" TEST_RUNNER_SECOND_TOKEN="${SECOND_TOKEN:-}" \
  xcodebuild test -project PhoneUIProbe.xcodeproj -scheme PhoneUIProbeTests \
  -destination "id=$UDID" -derivedDataPath "$DERIVED-tests" 2>&1 | grep -E "error|passed|failed|XCTAssert|PROBE" || true
ls "$OUT"/*.png
