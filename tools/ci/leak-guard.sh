#!/bin/sh
# Leak guard: gitleaks over (1) the checked-out tree and (2) the commits this push or pull request
# adds. Run by .woodpecker/leak-guard.yaml inside the gitleaks image; runs locally too:
#
#   docker run --rm -v "$PWD:/repo" -w /repo --entrypoint sh zricethezav/gitleaks:v8.28.0 tools/ci/leak-guard.sh
#
# Why not the whole history every time: history is immutable, so an old finding would fail every
# pipeline forever; (1) still catches anything present now and (2) catches a secret that a push adds
# and removes again within its own commits. Scanning all history is a one-off, by hand:
#   gitleaks git . --config .gitleaks.toml --redact
#
# All logic lives here rather than in the pipeline YAML because Woodpecker substitutes `$VAR` in
# YAML commands before the shell sees them.
set -eu

CONFIG=.gitleaks.toml
git config --global --add safe.directory "$(pwd)"

echo "== tree"
gitleaks dir . --config "$CONFIG" --redact --no-banner

# Woodpecker may clone shallowly; the range below needs real ancestry.
git fetch --quiet --unshallow 2>/dev/null || true

range=""
case "${CI_PIPELINE_EVENT:-}" in
  pull_request|pull_request_closed)
    if [ -n "${CI_COMMIT_TARGET_BRANCH:-}" ] \
      && git fetch --quiet origin "$CI_COMMIT_TARGET_BRANCH" 2>/dev/null; then
      range="FETCH_HEAD..HEAD"
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
[ -n "$range" ] || range="-1 HEAD"

echo "== commits: $range"
gitleaks git . --config "$CONFIG" --redact --no-banner --log-opts="$range"
