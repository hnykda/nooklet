#!/bin/bash
# Does the server answer a CORS preflight from the Capacitor app's origin?
# The iOS shell loads from capacitor://localhost and calls the server at an absolute URL
# (data/bootstrap.ts apiBaseUrl), so every API/sync fetch with an Authorization header is
# cross-origin and needs a preflight answer. Run against a scratch server, never ~/.nooklet:
#
#   NOOKLET_DATA=$SCRATCH pnpm nooklet serve --port 6377 --data $SCRATCH &
#   NOOKLET_DATA=$SCRATCH pnpm nooklet token create --label probe --scope write --sync --data $SCRATCH
#   TOKEN=nk_... tools/probes/cors-preflight.sh
#
# Result on c322269 (2026-10-03, sweep-scope): the preflight got `404 Not Found` with no
# Access-Control-* header; a plain GET with the Origin header got 200 with no
# Access-Control-Allow-Origin. A browser engine enforcing CORS would block both.
set -euo pipefail
BASE=${BASE:-http://127.0.0.1:6377}
: "${TOKEN:?}"
echo "--- preflight"
curl -s -i -X OPTIONS "$BASE/g/default/sync/pull" \
  -H 'Origin: capacitor://localhost' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: authorization' | grep -i '^HTTP\|access-control' || true
echo "--- GET with Origin"
curl -s -i "$BASE/g/default/api/v1/graph.overview" \
  -H 'Origin: capacitor://localhost' -H "Authorization: Bearer $TOKEN" |
  grep -i '^HTTP\|access-control' || true
