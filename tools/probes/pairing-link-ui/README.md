# pairing-link-ui — B-603 on the iOS Simulator, headless

Opens a real `nooklet://connect?...` link in the real app, screenshots the pre-filled confirm
screen, taps Connect, and screenshots the result. `xcrun simctl openurl` alone stops at
SpringBoard's "Open in “nooklet”?" alert, which needs a tap, and no tap tool is installed. This
XCUITest bundle opens the URL with `XCUIDevice.shared.system.open` and taps that alert when it
appears. Simulator.app is never opened; never use `open -a Simulator` (it shows a window on the
owner's screen).

Use a private device. Other agents run `xcrun simctl shutdown all`, which killed the first run
mid-test ("Test crashed with signal term").

```sh
xcrun simctl create pairing-probe "iPhone 17 Pro"          # prints <udid>
xcrun simctl boot <udid>
pnpm ios:sync && (cd apps/web/ios/App && xcodebuild -project App.xcodeproj -scheme App \
  -sdk iphonesimulator -derivedDataPath /tmp/d build -quiet)
xcrun simctl install <udid> /tmp/d/Build/Products/Debug-iphonesimulator/App.app
# a scratch server and a linked token:
NOOKLET_DATA=$(mktemp -d) pnpm nooklet token create --label sim --scope write --sync \
  --link http://<LAN-IP>:<port>          # then serve that data dir with --host 0.0.0.0 --allow-host <LAN-IP>
cd tools/probes/pairing-link-ui
TEST_RUNNER_PAIRING_URL='<the printed nooklet://connect link>' TEST_RUNNER_SHOT_DIR=/tmp \
  xcodebuild test -project PairingUITest.xcodeproj -scheme PairingUITests -destination id=<udid>
xcrun simctl delete <udid>
```

Result 2026-10-03 (iOS 26.5, `pairing-confirm.png`, `pairing-after-connect.png`): the confirm
screen showed the address (blanked in the committed PNG on 2026-10-04: it was the test machine's
real LAN address — see `docs/progress/leak-audit.md`); nothing was contacted before the tap; Connect led to Today with both
sync dots green. The first run found a real bug: after Connect's `location.reload()`,
`App.getLaunchUrl()` returned the same link again (it is Capacitor's `lastURL`, which outlives a
reload), so the confirm screen came back after every connect. Fixed by
`apps/web/src/platform/launch-url.ts`.
