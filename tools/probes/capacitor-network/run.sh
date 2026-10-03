#!/bin/bash
# Runs the capacitor-network probe on the iOS Simulator. Prereqs: `pnpm ios:sync` has run once
# (so App/App has capacitor.config.json), a booted simulator, a nooklet server reachable at BASE,
# and log-server.mjs listening at LOG.
#
#   BASE=http://192.168.1.5:6311 TOKEN=nk_... LOG=http://192.168.1.5:6312 OUT=shot.png \
#     tools/probes/capacitor-network/run.sh
#
# Swaps the probe into apps/web/ios/App/App/public (gitignored build output) — run `pnpm ios:sync`
# afterwards to put the real app back.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
PUB="$ROOT/apps/web/ios/App/App/public"
DERIVED=${DERIVED:-/tmp/nooklet-probe-derived}
: "${BASE:?}" "${TOKEN:?}" "${LOG:?}" "${OUT:=probe.png}"

rm -rf "$PUB"
mkdir -p "$PUB"
cp "$ROOT/tools/probes/capacitor-network/index.html" "$ROOT/tools/probes/capacitor-network/worker.js" "$PUB/"
printf 'const BASE=%s;const TOKEN=%s;const LOG=%s;\n' "\"$BASE\"" "\"$TOKEN\"" "\"$LOG\"" > "$PUB/config.js"

cd "$ROOT/apps/web/ios/App"
xcodebuild -project App.xcodeproj -scheme App -sdk iphonesimulator -configuration Debug \
  -derivedDataPath "$DERIVED" build -quiet
APP="$DERIVED/Build/Products/Debug-iphonesimulator/App.app"
xcrun simctl terminate booted sh.nooklet.app 2>/dev/null || true
xcrun simctl uninstall booted sh.nooklet.app 2>/dev/null || true
xcrun simctl install booted "$APP"
xcrun simctl launch booted sh.nooklet.app
sleep "${WAIT:-25}"
xcrun simctl io booted screenshot "$OUT"
