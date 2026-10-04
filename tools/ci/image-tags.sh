#!/bin/sh
# Writes the image tags for this pipeline to .image-tags (one per line), for the buildx plugin's
# `tags_file`: always the immutable `sha-<8 chars>`, plus the git tag on a tag pipeline. Never
# `latest` — deployments pin a sha tag.
set -eu
: "${CI_COMMIT_SHA:?CI_COMMIT_SHA is not set}"
sha8=$(printf '%s' "$CI_COMMIT_SHA" | cut -c1-8)
printf 'sha-%s\n' "$sha8" > .image-tags
if [ -n "${CI_COMMIT_TAG:-}" ]; then
  # Docker tags allow [A-Za-z0-9_.-]; anything else in a git tag name becomes "-".
  printf '%s\n' "$CI_COMMIT_TAG" | tr -c 'A-Za-z0-9_.\n-' '-' >> .image-tags
fi
cat .image-tags
