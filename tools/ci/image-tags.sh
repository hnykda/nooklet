#!/bin/sh
# Writes the image tags for this pipeline to .image-tags (one per line), for the buildx plugin's
# `tags_file`: always the immutable `sha-<8 chars>`; on a tag pipeline also the git tag (`v0.1.0`)
# and, for a final release tag (vX.Y.Z with no `-rc.1`-style suffix), `latest`. Never `latest`
# on main: deployments pin a sha tag, and `latest` means "the newest release" for people pulling
# the image by hand. Same scheme as the GHCR image (.github/workflows/release.yml).
set -eu
: "${CI_COMMIT_SHA:?CI_COMMIT_SHA is not set}"
sha8=$(printf '%s' "$CI_COMMIT_SHA" | cut -c1-8)
printf 'sha-%s\n' "$sha8" > .image-tags
if [ -n "${CI_COMMIT_TAG:-}" ]; then
  # Docker tags allow [A-Za-z0-9_.-]; anything else in a git tag name becomes "-".
  printf '%s\n' "$CI_COMMIT_TAG" | tr -c 'A-Za-z0-9_.\n-' '-' >> .image-tags
  if printf '%s' "$CI_COMMIT_TAG" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
    printf 'latest\n' >> .image-tags
  fi
fi
cat .image-tags
