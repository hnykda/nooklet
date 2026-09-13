#!/bin/bash
# Does the desktop app pick up a NEW web client on its next launch, when an OLDER client's service
# worker and precache are already installed in its WebKit store? (docs/bugs-inbox/desktop-shell.md,
# B-532.) The owner's app was "way behind": a build from today, still showing a client from days ago.
#
#   tools/probes/desktop-sw-update.sh <old-web-dist> <old-label> <new-web-dist> <new-label> <out-dir>
#
# What it does, against a DEVTEST build of the app only (bundle id must end in `.devtest`):
#   1. wipes that devtest app's WebKit store, so the run starts with no service worker;
#   2. copies both client builds and stamps each index.html with a fixed, visible label naming the
#      build and its `index-*.js` — the only way to SEE which shell a release WKWebView is running;
#   3. serves OLD (nooklet serve on 6421, behind tools/probes/logging-proxy.mjs on 6420), launches
#      the app, lets the service worker install and precache, quits the app normally;
#   4. serves NEW, launches the app twice more (quit in between), screenshotting each launch early
#      and late. Every request the webview makes is logged with its sec-fetch-dest, per phase.
#
# Reading the result: the label in the screenshots is what the window runs. `dest=empty` requests for
# /static/* are the service worker filling a precache; `dest=script` ones are the page itself.
#
# Needs (env, all with defaults for this repo's m11 scratch): SCR, APP (the devtest .app), SIDECAR
# (a built apps/desktop/sidecar: node + server.mjs), DATA (a COPY of a graph), TOOL (compiled
# tools/probes/desktop-window.swift). Never point DATA at ~/.nooklet/default or anything at 6100.
set -euo pipefail

OLD_WEB=$1 OLD_LABEL=$2 NEW_WEB=$3 NEW_LABEL=$4 OUT=$5
SCR=${SCR:-/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m11c}
APP=${APP:-$SCR/target/release/bundle/macos/nooklet.app}
SIDECAR=${SIDECAR:-$SCR/sidecar}
DATA=${DATA:-$SCR/data}
TOOL=${TOOL:-$SCR/desktop-window}
HERE=$(cd "$(dirname "$0")" && pwd)
PROXY_PORT=6420 SERVER_PORT=6421
EARLY=${EARLY:-8} LATE=${LATE:-40}

BUNDLE_ID=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$APP/Contents/Info.plist")
case "$BUNDLE_ID" in
*.devtest) ;;
*) echo "refusing: $APP is $BUNDLE_ID, not a .devtest build" >&2; exit 1 ;;
esac
case "$DATA" in
"$HOME/.nooklet/default"*) echo "refusing: DATA is the real graph" >&2; exit 1 ;;
esac

mkdir -p "$OUT"
LOG=$OUT/requests.log
: >"$LOG"
PIDS=()
cleanup() {
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT

phase() {
  echo "=== $* ===" | tee -a "$LOG"
}

stamp() { # <dist> <label> <dest>
  rm -rf "$3"
  cp -R "$1" "$3"
  local js
  js=$(grep -o 'index-[A-Za-z0-9_-]*\.js' "$3/index.html" | head -1)
  python3 - "$3/index.html" "$2 · $js" <<'PY'
import sys
path, label = sys.argv[1], sys.argv[2]
html = open(path).read()
tag = ('<div id="probe-build-label" style="position:fixed;left:8px;bottom:8px;z-index:2147483647;'
       'background:#b00020;color:#fff;font:600 15px/1.3 -apple-system,sans-serif;padding:5px 10px;'
       f'border-radius:5px;pointer-events:none">shell: {label}</div>')
open(path, "w").write(html.replace("</body>", tag + "</body>", 1))
PY
  echo "stamped $3 as '$2 · $js'"
}

server_pid=""
serve() { # <web-dir>
  if [ -n "$server_pid" ]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
  NOOKLET_DATA=$DATA NOOKLET_SQLITE_VEC_PATH=$SIDECAR/vec0.dylib ESBUILD_BINARY_PATH=$SIDECAR/esbuild \
    NODE_ENV=production "$SIDECAR/node" "$SIDECAR/server.mjs" serve --data "$DATA" \
    --port $SERVER_PORT --web "$1" --no-mirror >>"$OUT/server.log" 2>&1 &
  server_pid=$!
  PIDS+=("$server_pid")
  for _ in $(seq 1 150); do
    curl -s -m 1 "http://127.0.0.1:$SERVER_PORT/healthz" >/dev/null && break
    sleep 0.2
  done
  echo "serving $1 (pid $server_pid)" | tee -a "$LOG"
}

launch() { # <shot-prefix>
  local front
  front=$("$TOOL" frontmost 0)
  NOOKLET_PORT=$PROXY_PORT NOOKLET_DATA=$DATA "$APP/Contents/MacOS/nooklet-desktop" >>"$OUT/app.log" 2>&1 &
  local app=$!
  PIDS+=("$app")
  # The launch takes the keyboard; give it straight back to whoever had it (see desktop-window.swift).
  sleep 1.5
  [ "$front" -gt 0 ] && [ "$front" != "$app" ] && "$TOOL" give-back "$front" || true
  sleep "$EARLY"
  "$TOOL" shot "$app" "$OUT/$1-early.png" || true
  sleep $((LATE - EARLY))
  "$TOOL" shot "$app" "$OUT/$1-late.png" || true
  "$TOOL" quit "$app"
  kill "$app" 2>/dev/null || true
  sleep 2
}

rm -rf "$HOME/Library/WebKit/$BUNDLE_ID" "$HOME/Library/Caches/$BUNDLE_ID" "$HOME/Library/HTTPStorages/$BUNDLE_ID"
stamp "$OLD_WEB" "$OLD_LABEL" "$OUT/web-old"
stamp "$NEW_WEB" "$NEW_LABEL" "$OUT/web-new"

node "$HERE/logging-proxy.mjs" $PROXY_PORT $SERVER_PORT "$LOG" >/dev/null 2>&1 &
PIDS+=("$!")

phase "1 old client, fresh store"
serve "$OUT/web-old"
launch 1-old-fresh

phase "2 new client served, first launch"
serve "$OUT/web-new"
launch 2-new-launch1

phase "3 new client served, second launch"
launch 3-new-launch2

phase "4 new client served, third launch"
launch 4-new-launch3

echo
echo "--- per phase: sw.js, index-*.js and document requests ---"
grep -E '^===|serving|GET /sw\.js|index-[A-Za-z0-9_-]*\.js|dest=document' "$LOG" | sed -E 's/^[0-9T:.-]+Z //'
echo
echo "screenshots: $OUT/*.png"
