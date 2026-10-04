#!/bin/sh
# Asks the deployment side to roll out the images this pipeline just pushed, by starting a
# pipeline in the deployer's own infrastructure repo through the Woodpecker API, with variables
# BUILD_TARGET=nooklet and NOOKLET_TAG=sha-<8 chars>. What that pipeline does (and where) is the
# deployer's business; this repo only knows the two secret NAMES:
#
#   deploy_trigger_url    full API URL, e.g. https://<woodpecker>/api/repos/<infra repo id>/pipelines
#   deploy_trigger_token  a Woodpecker API token allowed to start that pipeline
#
# Both are exposed to push events on main only (see deploy/README.md, "CI and forks").
set -eu
: "${CI_COMMIT_SHA:?}"
: "${DEPLOY_TRIGGER_URL:?secret deploy_trigger_url is not set}"
: "${DEPLOY_TRIGGER_TOKEN:?secret deploy_trigger_token is not set}"
tag="sha-$(printf '%s' "$CI_COMMIT_SHA" | cut -c1-8)"
body=$(printf '{"branch":"main","variables":{"BUILD_TARGET":"nooklet","NOOKLET_TAG":"%s"}}' "$tag")
# The token goes in a header file, not argv, so it never shows in a process listing.
hdr=$(mktemp)
trap 'rm -f "$hdr"' EXIT
printf 'Authorization: Bearer %s\n' "$DEPLOY_TRIGGER_TOKEN" > "$hdr"
curl -fsS -X POST "$DEPLOY_TRIGGER_URL" -H @"$hdr" -H "Content-Type: application/json" \
  -d "$body" -o /dev/null
echo "deploy requested for $tag"
