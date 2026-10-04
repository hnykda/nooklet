#!/bin/sh
# Probe: what tools/ci/image-tags.sh writes for main, a release tag, a prerelease tag and an odd
# tag name. Run from anywhere: sh tools/probes/image-tags-cases.sh
# Expected: main -> sha only; v0.1.0 -> sha, v0.1.0, latest; v0.2.0-rc.1 -> no latest.
set -eu
script="$(cd "$(dirname "$0")/../ci" && pwd)/image-tags.sh"
tmp=$(mktemp -d)
cd "$tmp"
for t in "" v0.1.0 v0.2.0-rc.1 "weird/tag"; do
  echo "-- CI_COMMIT_TAG=[$t]"
  CI_COMMIT_SHA=0123456789abcdef CI_COMMIT_TAG="$t" sh "$script" | sed 's/^/   /'
done
rm -rf "$tmp"
