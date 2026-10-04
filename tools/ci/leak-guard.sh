#!/bin/sh
# Leak guard for CI: secrets and personal-infrastructure shapes in (1) the checked-out tree and
# (2) the commits this push or pull request adds. Run by .woodpecker/leak-guard.yaml inside the
# gitleaks image (alpine, root, has git); runs locally too:
#
#   docker run --rm -v "$PWD:/repo" -w /repo --entrypoint sh zricethezav/gitleaks:v8.28.0 tools/ci/leak-guard.sh
#
# Uses tools/leak-check.mjs (the repo's own shape rules + gitleaks with .gitleaks.toml) when it
# exists, else gitleaks alone. CI never has the owner's private denylist; that half of the guard is
# the local pre-commit hook.
#
# Why not the whole history every time: history is immutable, so an old finding would fail every
# pipeline forever. (1) still catches anything present now, and (2) catches a secret that a push
# adds and removes again within its own commits. A full-history scan is a one-off, by hand.
#
# All logic lives here rather than in the pipeline YAML because Woodpecker substitutes `$VAR` in
# YAML commands before the shell sees them.
set -eu

git config --global --add safe.directory "$(pwd)"
# Woodpecker may clone shallowly; the range below needs real ancestry.
git fetch --quiet --unshallow 2>/dev/null || true

range=""
case "${CI_PIPELINE_EVENT:-}" in
  pull_request|pull_request_closed)
    if [ -n "${CI_COMMIT_TARGET_BRANCH:-}" ] \
      && git fetch --quiet origin "$CI_COMMIT_TARGET_BRANCH" 2>/dev/null; then
      range="$(git rev-parse FETCH_HEAD)..HEAD"
    fi
    ;;
  *)
    prev="${CI_PREV_COMMIT_SHA:-}"
    if [ -n "$prev" ] && git merge-base --is-ancestor "$prev" HEAD 2>/dev/null; then
      range="$prev..HEAD"
    fi
    ;;
esac
# No usable base (first pipeline, force-push, local run): the newest commit alone.
if [ -z "$range" ]; then
  if git rev-parse --verify --quiet HEAD~1 >/dev/null; then range="HEAD~1..HEAD"; else range="HEAD"; fi
fi

if [ -f tools/leak-check.mjs ]; then
  command -v node >/dev/null || apk add --no-cache --quiet nodejs
  echo "== tree (leak-check.mjs)"
  node tools/leak-check.mjs --tree
  echo "== commits $range (leak-check.mjs)"
  node tools/leak-check.mjs --range "$range"
else
  echo "tools/leak-check.mjs not found: gitleaks only"
  config=""
  [ -f .gitleaks.toml ] && config="--config .gitleaks.toml"
  echo "== tree (gitleaks)"
  # shellcheck disable=SC2086
  gitleaks dir . $config --redact --no-banner
  echo "== commits $range (gitleaks)"
  # shellcheck disable=SC2086
  gitleaks git . $config --redact --no-banner --log-opts="$range"
fi
