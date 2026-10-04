#!/bin/bash
# Phone UI probe (B-646/B-648/B-651) on a PRIVATE headless Simulator. Never opens Simulator.app,
# never uses `booted` or `shutdown all`.
#
#   xcrun simctl create phone-ui-probe "iPhone 17" com.apple.CoreSimulator.SimRuntime.iOS-26-5
#   xcrun simctl boot <udid>
#   pnpm ios:sync
#   UDID=<udid> OUT=<dir> [OVERLAY=1] [STEPS=slash,task,props] tools/probes/phone-ui/run.sh
#   xcrun simctl delete <udid>
#
# OVERLAY=1 injects event-overlay.js into the built public/index.html (gitignored build output):
# run `pnpm ios:sync` afterwards to put the plain app back.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
PUB="$ROOT/apps/web/ios/App/App/public"
: "${UDID:?}" "${OUT:?}"
DERIVED=${DERIVED:-$OUT/derived}
mkdir -p "$OUT"
if [ "${OVERLAY:-0}" = 1 ]; then
  cp "$ROOT/tools/probes/phone-ui/event-overlay.js" "$PUB/probe-overlay.js"
  grep -q probe-overlay "$PUB/index.html" ||
    perl -0pi -e "s|<head>|<head><script>window.PROBE_LINES=${OVERLAY_LINES:-40}</script><script src=/probe-overlay.js></script>|" "$PUB/index.html"
fi
(cd "$ROOT/apps/web/ios/App" && xcodebuild -project App.xcodeproj -scheme App -sdk iphonesimulator \
  -configuration Debug -destination "id=$UDID" -derivedDataPath "$DERIVED" build -quiet)
xcrun simctl terminate "$UDID" sh.nooklet.app 2>/dev/null || true
xcrun simctl uninstall "$UDID" sh.nooklet.app 2>/dev/null || true
xcrun simctl install "$UDID" "$DERIVED/Build/Products/Debug-iphonesimulator/App.app"
cd "$ROOT/tools/probes/phone-ui"
TEST_RUNNER_SHOT_DIR="$OUT" TEST_RUNNER_STEPS="${STEPS:-slash,task,props}" \
  xcodebuild test -project PhoneUIProbe.xcodeproj -scheme PhoneUIProbeTests \
  -destination "id=$UDID" -derivedDataPath "$DERIVED-tests" 2>&1 | grep -E "error|passed|failed|XCTAssert" || true
ls "$OUT"/*.png
