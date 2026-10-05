#!/bin/bash
# Proposal 006 Phase 2 gate, docs/research/16-personal-team-app-groups.md: does a free Apple
# Personal Team get an App Group shared by an app and its Share Extension?
#
#   tools/probes/app-group-probe/run.sh build     # signed device build (-allowProvisioningUpdates)
#   DEVICE=<udid> tools/probes/app-group-probe/run.sh install   # install + launch with console
#   DEVICE=<udid> tools/probes/app-group-probe/run.sh files     # list the App Group container
#   DEVICE=<udid> tools/probes/app-group-probe/run.sh remove    # uninstall the probe
#
# The team id comes from $DEVELOPMENT_TEAM, else a gitignored signing.local.xcconfig next to this
# script, else the gitignored apps/web/ios/signing.local.xcconfig. Never commit it.
#
# Cost on a free account: two App IDs (app + extension) and two 7-day profiles. The App Group
# itself is not an App ID.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
DD="$HERE/build/dd"
APP="$DD/Build/Products/Debug-iphoneos/AppGroupProbe.app"
BUNDLE=sh.nooklet.probe.appgroup
GROUP=group.sh.nooklet.probe

case "${1:-}" in
build)
	CFG="$HERE/signing.local.xcconfig"
	[ -f "$CFG" ] || CFG="$ROOT/apps/web/ios/signing.local.xcconfig"
	TEAM=${DEVELOPMENT_TEAM:-$(sed -n 's/^DEVELOPMENT_TEAM *= *//p' "$CFG")}
	: "${TEAM:?set DEVELOPMENT_TEAM}"
	xcodebuild -project "$HERE/AppGroupProbe.xcodeproj" -scheme AppGroupProbe -configuration Debug \
		-destination 'generic/platform=iOS' -derivedDataPath "$DD" -allowProvisioningUpdates \
		DEVELOPMENT_TEAM="$TEAM" build
	;;
install)
	: "${DEVICE:?}"
	xcrun devicectl device install app --device "$DEVICE" "$APP"
	xcrun devicectl device process launch --device "$DEVICE" --terminate-existing --console "$BUNDLE"
	;;
files)
	: "${DEVICE:?}"
	xcrun devicectl device info files --device "$DEVICE" --domain-type appGroupDataContainer \
		--domain-identifier "$GROUP"
	;;
remove)
	: "${DEVICE:?}"
	xcrun devicectl device uninstall app --device "$DEVICE" "$BUNDLE"
	;;
*)
	sed -n '2,15p' "$0"
	exit 2
	;;
esac
