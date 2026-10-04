#!/bin/bash
# Proposal 006 Phase 1 on the iOS Simulator, headless (ADR 033). A fresh install, fixture text only:
#  1. first launch from a nooklet://capture link: no graph yet, the text is kept
#  2. "Just this device" (the driver's one tap), then the kept text is back on the capture screen
#  3. the App Intent's code path with the app CLOSED: -NookletDebugEnqueue runs
#     AddToNookletIntent.enqueue and exits before any web view; the file is in the container
#  4. a normal launch drains it into today's journal; the file is gone
#  5. a capture file appearing while the app is in the background drains on resume
#  6. quick actions (cold start, via -NookletDebugQuickAction: simctl cannot long-press)
#  7. "Open nooklet to add" (-NookletDebugOpenToAdd), and a link with a url and title
# Every link is delivered at a cold start (-NookletDebugOpenURL); a warm link needs a tap on iOS's
# "Open in nooklet?" prompt, which nothing here can make.
# Uses ONLY the device you pass, never `booted`, never opens Simulator.app, and shuts it down.
#
#   pnpm ios:sync
#   UDID=<device> OUT=<dir> tools/probes/phone-capture/sim-run.sh
#
# Edits apps/web/ios/App/App/public/index.html (gitignored build output): run `pnpm ios:sync`
# afterwards to put the plain app back.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
PUB="$ROOT/apps/web/ios/App/App/public"
: "${UDID:?}" "${OUT:?}"
PORT=${PORT:-6491}
DERIVED=${DERIVED:-$OUT/derived}
BUNDLE=sh.nooklet.app
mkdir -p "$OUT"
: >"$OUT/dumps.jsonl"
echo none >"$OUT/cmd"

cp "$ROOT/tools/probes/phone-capture/sim-driver.js" "$PUB/pcsim-driver.js"
CFG="<script>window.PC_SIM={host:'http://127.0.0.1:$PORT'};</script><script src=\"/pcsim-driver.js\"></script>"
grep -q pcsim-driver "$PUB/index.html" || perl -0pi -e "s|<head>|<head>$CFG|" "$PUB/index.html"

OUT="$OUT" PORT="$PORT" node "$ROOT/tools/probes/phone-capture/sim-host.mjs" >"$OUT/host.log" 2>&1 &
HOST_PID=$!
trap 'kill $HOST_PID 2>/dev/null || true; xcrun simctl shutdown "$UDID" 2>/dev/null || true' EXIT

cd "$ROOT/apps/web/ios/App"
xcodebuild -project App.xcodeproj -scheme App -sdk iphonesimulator -configuration Debug \
  -destination "id=$UDID" -derivedDataPath "$DERIVED" build -quiet CODE_SIGNING_ALLOWED=NO
APP="$DERIVED/Build/Products/Debug-iphonesimulator/App.app"
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null
xcrun simctl terminate "$UDID" $BUNDLE 2>/dev/null || true
xcrun simctl uninstall "$UDID" $BUNDLE 2>/dev/null || true
xcrun simctl install "$UDID" "$APP"

shot() { xcrun simctl io "$UDID" screenshot "$OUT/$1.png" >/dev/null 2>&1; echo "shot $1"; }
queue_dir() { echo "$(xcrun simctl get_app_container "$UDID" $BUNDLE data)/Library/Application Support/captures"; }
show_queue() {
  local d; d=$(queue_dir)
  echo "queue ($1):"
  if [ -d "$d" ]; then
    for f in "$d"/*.json; do [ -e "$f" ] && { echo "  $(basename "$f"): $(cat "$f")"; }; done
    [ -n "$(ls -A "$d" 2>/dev/null)" ] || echo "  (empty)"
  else
    echo "  (no folder)"
  fi
}
relaunch() { xcrun simctl terminate "$UDID" $BUNDLE 2>/dev/null || true; sleep 1; xcrun simctl launch "$UDID" $BUNDLE "$@" >/dev/null; }

echo "== 1. first launch from a capture link, no graph"
# Not `simctl openurl`: it stops at an "Open in nooklet?" prompt that nothing here can tap.
# -NookletDebugOpenURL hands the link over through Capacitor's open-URL proxy instead.
xcrun simctl launch "$UDID" $BUNDLE -NookletDebugOpenURL \
  "nooklet://capture?text=A%20thought%20before%20any%20graph%20exists" >/dev/null
sleep 14; shot 1-first-launch-no-graph

echo "== 2. set up 'Just this device', then the kept text is back"
echo setup >"$OUT/cmd"
relaunch
sleep 22; shot 2a-local-graph
relaunch -NookletDebugOpenURL "nooklet://capture"
sleep 12; shot 2b-draft-kept

echo "== 3. the intent's code path with the app closed"
xcrun simctl terminate "$UDID" $BUNDLE 2>/dev/null || true
sleep 1
xcrun simctl launch "$UDID" $BUNDLE -NookletDebugEnqueue "Added by the intent while nooklet was closed" \
  -NookletDebugExitAfterEnqueue YES >/dev/null
sleep 4
show_queue "after the intent ran, app not running"

echo "== 4. a normal launch drains it"
xcrun simctl launch "$UDID" $BUNDLE >/dev/null
sleep 14; shot 4-drained-on-launch
show_queue "after launch"

echo "== 5. a capture queued while backgrounded drains on resume"
xcrun simctl launch "$UDID" com.apple.Preferences >/dev/null
sleep 3
D=$(queue_dir); mkdir -p "$D"
ID=$(uuidgen | tr 'A-Z' 'a-z')
NOW=$(node -e 'console.log(new Date().toISOString())')
printf '{"created_at":"%s","url":"https://example.com/sprouts","title":"Sprouts/Growing/Sixth Try"}' "$NOW" >"$D/$ID.json"
show_queue "written while backgrounded"
xcrun simctl launch "$UDID" $BUNDLE >/dev/null
sleep 12; shot 5-drained-on-resume
show_queue "after resume"

echo "== 6. quick actions (cold start, debug launch argument)"
relaunch -NookletDebugQuickAction sh.nooklet.app.search
sleep 12; shot 6a-quick-action-search
relaunch -NookletDebugQuickAction sh.nooklet.app.today
sleep 12; shot 6b-quick-action-today
relaunch -NookletDebugQuickAction sh.nooklet.app.capture
sleep 12; shot 6c-quick-action-new-note

echo "== 7. Open nooklet to add, and a warm capture link"
relaunch -NookletDebugOpenToAdd "Edit me before saving"
sleep 12; shot 7a-open-to-add
relaunch -NookletDebugOpenURL "nooklet://capture?url=https%3A%2F%2Fexample.com%2Fa&title=An%20article"
sleep 12; shot 7b-link-with-title

echo "== dumps"
cat "$OUT/dumps.jsonl"
