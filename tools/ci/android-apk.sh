#!/usr/bin/env bash
# Builds the experimental Android APK into dist/. Run by .github/workflows/release.yml after
# `pnpm install`, with JDK 21 and an Android SDK (ANDROID_HOME) present.
#
#   tools/ci/android-apk.sh 0.1.0
#
# With the keystore secrets (RELEASING.md, "Secrets") it builds the release variant and signs it
# with apksigner: ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS,
# ANDROID_KEY_PASSWORD. Without them it builds the debug variant, which Gradle signs with a
# throwaway debug key: installable for testing, but a later properly signed APK cannot update it
# in place (uninstall first, which deletes the app's local data).
set -euo pipefail
version="$1"
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
: "${ANDROID_HOME:?ANDROID_HOME is not set (no Android SDK)}"

# The web build, copied into the Gradle project, plus capacitor.settings.gradle regenerated
# for this checkout's node_modules paths.
pnpm --filter @nooklet/web build
pnpm --filter @nooklet/web exec cap sync android

out="$root/dist"
mkdir -p "$out"
cd apps/web/android
chmod +x gradlew

if [ -n "${ANDROID_KEYSTORE_BASE64:-}" ]; then
  : "${ANDROID_KEYSTORE_PASSWORD:?}" "${ANDROID_KEY_ALIAS:?}"
  ./gradlew --no-daemon assembleRelease
  # Newest installed build-tools (version-named directories only).
  # shellcheck disable=SC2012
  bt="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -n1)"
  ks="${RUNNER_TEMP:-/tmp}/nooklet-release.jks"
  printf '%s' "$ANDROID_KEYSTORE_BASE64" | base64 --decode > "$ks"
  aligned="${RUNNER_TEMP:-/tmp}/aligned.apk"
  "$bt/zipalign" -f -p 4 app/build/outputs/apk/release/app-release-unsigned.apk "$aligned"
  dest="$out/nooklet-$version-android-experimental.apk"
  # Passwords through the environment, not argv, so they never show in a process listing.
  KS_PASS="$ANDROID_KEYSTORE_PASSWORD" KEY_PASS="${ANDROID_KEY_PASSWORD:-$ANDROID_KEYSTORE_PASSWORD}" \
    "$bt/apksigner" sign --ks "$ks" --ks-key-alias "$ANDROID_KEY_ALIAS" \
    --ks-pass env:KS_PASS --key-pass env:KEY_PASS --out "$dest" "$aligned"
  rm -f "$ks" "$aligned"
  # Prints the signing certificate's digests (public), so a tester can compare them.
  "$bt/apksigner" verify --print-certs "$dest"
  echo "signed: dist/$(basename "$dest")"
else
  echo "no ANDROID_KEYSTORE_BASE64: building the debug-signed APK instead"
  ./gradlew --no-daemon assembleDebug
  dest="$out/nooklet-$version-android-experimental-debug.apk"
  cp app/build/outputs/apk/debug/app-debug.apk "$dest"
  echo "debug-signed: dist/$(basename "$dest")"
fi
