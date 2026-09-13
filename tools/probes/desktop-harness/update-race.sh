#!/bin/bash
# Does the desktop app show a NEW client on the first launch after the server got one, with an OLDER
# client's service worker installed — and does it still when /api/session is slow? (B-532, B-537)
#
#   update-race.sh <old-dist> <old-label> <new-dist> <new-label> <out-dir>
#
# Runs a harness-wired devtest2 build (wire.py): wipes ITS WebKit store, serves OLD (nooklet serve on
# 6491 behind ../logging-proxy.mjs on 6421), launches, quits; serves NEW, launches twice more. Each
# launch is screenshotted early and late and asked, through the harness, which index-*.js it runs and
# whether it got there by a reload. Waits for 15 s of the person's idleness before each launch and hands
# the keyboard straight back after it.
#
# Env: DELAY_MS — hold /api/session that long from the NEW phases on (B-537: 2000). NEW_REV=1 — reverse
# index.html's precache revision in the NEW sw.js, so one build can play OLD and NEW. EARLY (6), LATE (30).
# HARNESS_DIR (probe dir, idle + desktop-window tools, data copy), APP, SIDECAR.
#
# Results 2026-09-13 (docs/bugs-inbox/desktop-shell.md B-537): OLD adadff1 -> NEW 43ca66d, no delay:
# first launch reloads onto NEW. OLD 43ca66d -> NEW 43ca66d+rev, 2 s delay: OLD for the whole session.
# OLD fix -> NEW fix+rev, 2 s delay: reload onto NEW at +1.1 s.
set -uo pipefail
pc() { python3 -c "import sys; sys.path.insert(0, sys.argv[1]); from drv import pc; print(pc(sys.argv[2]))" "$(dirname "$0")" "$1"; }
OLD_WEB=$1 OLD_LABEL=$2 NEW_WEB=$3 NEW_LABEL=$4 OUT=$5
V=${HARNESS_DIR:-/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m11c/verify}
export HARNESS_DIR=$V
APP=${APP:-$V/../verify-target/release/bundle/macos/nooklet.app}
SIDE=${SIDECAR:-$V/desktop/sidecar}  # a built apps/desktop/sidecar (node + server.mjs)
BUNDLE_ID=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$APP/Contents/Info.plist")
[ "$BUNDLE_ID" = com.nooklet.desktop.devtest2 ] || { echo "refusing: $BUNDLE_ID"; exit 1; }
DELAY_MS=${DELAY_MS:-0} EARLY=${EARLY:-6} LATE=${LATE:-30}
export NOOKLET_DATA=$V/data
mkdir -p "$OUT"; LOG=$OUT/requests.log; : >"$LOG"
server_pid="" proxy_pid="" app_pid=""
cleanup() { for p in $app_pid $proxy_pid $server_pid; do [ -n "$p" ] && kill "$p" 2>/dev/null; done; true; }
trap cleanup EXIT
stamp() { # <dist> <label> <dest> [bump]
  rm -rf "$3"; cp -R "$1" "$3"
  local js; js=$(grep -o 'index-[A-Za-z0-9_-]*\.js' "$3/index.html" | head -1)
  python3 - "$3" "$2 · $js" "${4:-}" <<'PY'
import sys, re
d, label, bump = sys.argv[1], sys.argv[2], sys.argv[3]
p = d + "/index.html"; h = open(p).read()
tag = ('<div id="probe-build-label" style="position:fixed;left:8px;bottom:8px;z-index:2147483647;background:#b00020;'
       'color:#fff;font:600 15px/1.3 -apple-system,sans-serif;padding:5px 10px;border-radius:5px;pointer-events:none">'
       f'shell: {label}</div>')
open(p, "w").write(h.replace("</body>", tag + "</body>", 1))
if bump:
    s = open(d + "/sw.js").read()
    s2 = re.sub(r'\{url:"index.html",revision:"([0-9a-f]+)"\}', lambda m: '{url:"index.html",revision:"' + m.group(1)[::-1] + '"}', s, count=1)
    assert s2 != s, "no index.html revision found"
    open(d + "/sw.js", "w").write(s2)
PY
  echo "stamped $3: $2 · $js ${4:+(index.html revision bumped)}"
}
serve() {
  [ -n "$server_pid" ] && { kill "$server_pid"; wait "$server_pid" 2>/dev/null; }
  NOOKLET_SQLITE_VEC_PATH=$SIDE/vec0.dylib ESBUILD_BINARY_PATH=$SIDE/esbuild NODE_ENV=production \
    "$SIDE/node" "$SIDE/server.mjs" serve --data "$V/data" --port 6491 --web "$1" --no-mirror >>"$OUT/server.log" 2>&1 &
  server_pid=$!
  for i in $(seq 1 150); do curl -s -m 1 http://127.0.0.1:6491/healthz >/dev/null && break; sleep 0.2; done
  echo "=== serving $1 (pid $server_pid)" | tee -a "$LOG"
}
proxy() { # <delay-ms>
  [ -n "$proxy_pid" ] && { kill "$proxy_pid"; wait "$proxy_pid" 2>/dev/null; }
  DELAY_RE='^/api/session' DELAY_MS=$1 node "$(dirname "$0")/../logging-proxy.mjs" 6421 6491 "$LOG" &
  proxy_pid=$!; sleep 0.5
}
launch() { # <name>
  for i in $(seq 1 900); do [ "$($V/idle)" -ge 15 ] && break; sleep 1; done
  local front; front=$($V/desktop-window frontmost 0)
  echo "=== launch $1 $(date -u +%H:%M:%S.%N)" | tee -a "$LOG"
  NOOKLET_PORT=6421 NOOKLET_PROBE_DIR=$V/probe "$APP/Contents/MacOS/nooklet-desktop" >>"$OUT/app.log" 2>&1 &
  app_pid=$!
  echo "$app_pid" > $V/pids/app
  for i in $(seq 1 10); do sleep 0.5; [ "$($V/desktop-window frontmost 0)" != "$front" ] && $V/desktop-window give-back "$front" >/dev/null; done
  sleep $((EARLY - 5))
  $V/desktop-window shot "$app_pid" "$OUT/$1-early.png" >/dev/null
  echo "  early: $(pc 'eval JSON.stringify({label: document.getElementById("probe-build-label")?.textContent ?? null, script: [...document.scripts].map(s => s.src).find(s => s.includes("/index-")), nav: performance.getEntriesByType("navigation")[0]?.type, t: Math.round(performance.now()), ctrl: !!navigator.serviceWorker.controller})')" | tee -a "$LOG"
  sleep $((LATE - EARLY))
  $V/desktop-window shot "$app_pid" "$OUT/$1-late.png" >/dev/null
  echo "  late:  $(pc 'eval JSON.stringify({label: document.getElementById("probe-build-label")?.textContent ?? null, script: [...document.scripts].map(s => s.src).find(s => s.includes("/index-")), nav: performance.getEntriesByType("navigation")[0]?.type, t: Math.round(performance.now()), ctrl: !!navigator.serviceWorker.controller})')" | tee -a "$LOG"
  $V/desktop-window quit "$app_pid" >/dev/null
  kill "$app_pid" 2>/dev/null; wait "$app_pid" 2>/dev/null; app_pid=""; rm -f $V/pids/app
  sleep 2
}
rm -rf "$HOME/Library/WebKit/$BUNDLE_ID" "$HOME/Library/Caches/$BUNDLE_ID" "$HOME/Library/HTTPStorages/$BUNDLE_ID"
stamp "$OLD_WEB" "$OLD_LABEL" "$OUT/web-old"
stamp "$NEW_WEB" "$NEW_LABEL" "$OUT/web-new" "${NEW_REV:-}"
proxy 0
serve "$OUT/web-old"; launch 1-old-fresh
serve "$OUT/web-new"; proxy "$DELAY_MS"; launch 2-new-launch1
launch 3-new-launch2
echo; grep -E '^===|early:|late:|GET /sw\.js|GET / |/api/session|index-[A-Za-z0-9_-]*\.js' "$LOG" | grep -v '^\s*$'
