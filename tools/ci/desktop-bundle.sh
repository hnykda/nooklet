#!/usr/bin/env bash
# Builds the desktop app for THIS runner's platform and copies the installers into dist/ with
# release names. Run by .github/workflows/release.yml after `pnpm install`; runs locally too:
#
#   tools/ci/desktop-bundle.sh 0.1.0 macos-arm64 app,dmg
#
# Arguments: <label version> <platform label> <tauri bundles>
#
# macOS signing and notarization switch on by themselves when the secrets exist (RELEASING.md,
# "Secrets"): APPLE_CERTIFICATE (base64 .p12), APPLE_CERTIFICATE_PASSWORD, APPLE_SIGNING_IDENTITY,
# and for notarization APPLE_ID + APPLE_PASSWORD (app-specific password) + APPLE_TEAM_ID. Without
# them the .app is ad-hoc signed and the user has to clear quarantine (docs/guide/getting-started.md).
set -euo pipefail
version="$1"
label="$2"
bundles="$3"
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

# Tauri treats a SET-but-empty APPLE_* variable as configured and then fails to sign or notarize
# with it; a workflow passes empty strings for absent secrets, so drop those first.
for v in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID; do
  if [ -z "${!v:-}" ]; then unset "$v"; fi
done

# 1. The sidecar: server, official Node, sqlite-vec, esbuild and the web client for this platform.
pnpm --filter @nooklet/desktop run sidecar

# 2. With a signing identity, sign the sidecar's own executables first. Tauri signs the app's
#    main binary but not executables shipped as resources, and notarization rejects any unsigned
#    or non-hardened Mach-O inside the bundle. Node needs JIT entitlements to run at all under the
#    hardened runtime (apps/desktop/src-tauri/sidecar.entitlements).
if [ "$(uname -s)" = "Darwin" ] && [ -n "${APPLE_CERTIFICATE:-}" ]; then
  : "${APPLE_SIGNING_IDENTITY:?APPLE_SIGNING_IDENTITY is required with APPLE_CERTIFICATE}"
  keychain="$RUNNER_TEMP/nooklet-signing.keychain-db"
  kc_pass="$(openssl rand -hex 16)"
  printf '%s' "$APPLE_CERTIFICATE" | base64 --decode > "$RUNNER_TEMP/cert.p12"
  security create-keychain -p "$kc_pass" "$keychain"
  security set-keychain-settings -lut 21600 "$keychain"
  security unlock-keychain -p "$kc_pass" "$keychain"
  security import "$RUNNER_TEMP/cert.p12" -k "$keychain" -P "${APPLE_CERTIFICATE_PASSWORD:-}" \
    -T /usr/bin/codesign
  security set-key-partition-list -S apple-tool:,apple: -s -k "$kc_pass" "$keychain" >/dev/null
  # Prepend ours to the search list, keeping the existing ones (one path per word: split on purpose).
  # shellcheck disable=SC2046
  security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')
  rm -f "$RUNNER_TEMP/cert.p12"
  for f in apps/desktop/sidecar/node apps/desktop/sidecar/esbuild apps/desktop/sidecar/vec0.dylib; do
    codesign --force --timestamp --options runtime \
      --entitlements apps/desktop/src-tauri/sidecar.entitlements \
      --sign "$APPLE_SIGNING_IDENTITY" "$f"
  done
  # Tauri would import APPLE_CERTIFICATE into a keychain of its own; it is already in ours.
  unset APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD
  echo "signing: on (identity from APPLE_SIGNING_IDENTITY)"
else
  unset APPLE_SIGNING_IDENTITY
  echo "signing: off (no APPLE_CERTIFICATE): unsigned build"
fi

# 3. The bundles.
pnpm --filter @nooklet/desktop exec tauri build --bundles "$bundles"

# 4. Release names. One installer per format; anything else in bundle/ is left behind.
out="$root/dist"
mkdir -p "$out"
b="apps/desktop/src-tauri/target/release/bundle"
copy() { # <glob dir> <pattern> <dest name>
  local found
  found=$(find "$1" -maxdepth 1 -name "$2" 2>/dev/null | head -n1)
  if [ -z "$found" ]; then echo "no $2 in $1" >&2; exit 1; fi
  cp "$found" "$out/$3"
  echo "dist/$3"
}
case "$label" in
  macos-*)
    copy "$b/dmg" '*.dmg' "nooklet-$version-$label.dmg"
    ;;
  linux-*)
    copy "$b/appimage" '*.AppImage' "nooklet-$version-$label.AppImage"
    copy "$b/deb" '*.deb' "nooklet-$version-$label.deb"
    ;;
  windows-*)
    copy "$b/nsis" '*-setup.exe' "nooklet-$version-$label-setup.exe"
    ;;
  *) echo "unknown platform label $label" >&2; exit 1 ;;
esac
