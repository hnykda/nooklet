#!/usr/bin/env bash
# Does `nooklet token revoke` take effect against a RUNNING server, for the API and for /sync?
# Usage: revoke-check.sh <datadir> <port>
set -euo pipefail
D=$1; PORT=$2
cd "$(dirname "$0")/../../../packages/server"
n() { NOOKLET_DATA="$D" pnpm exec tsx src/cli.ts "$@" --data "$D" --graph default; }
TOK=$(n token create --label curlrev --scope write --sync 2>&1 | grep -o 'nk_[0-9a-f]*')
code() { curl -s -o /dev/null -w "%{http_code}" -X POST -H "authorization: Bearer $TOK" -H content-type:application/json -d '{}' "http://127.0.0.1:$PORT/g/default/$1"; }
echo "before revoke: api=$(code api/v1/graph.overview) sync-pull=$(code sync/pull)"
ID=$(n token list | grep curlrev | grep active | awk '{print $1}')
n token revoke "$ID"
n token list | grep curlrev
echo "after revoke:  api=$(code api/v1/graph.overview) sync-pull=$(code sync/pull)"
