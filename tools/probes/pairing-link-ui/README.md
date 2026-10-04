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

## B-655: one-time codes and the https pairing page (2026-10-04, iOS 26.5, iPhone 17 Pro)

Server: a scratch `nooklet serve --port 6471 --web <repo>/apps/web/dist` (the Simulator shares the
host's loopback, so `http://127.0.0.1:6471` reaches it); codes from
`nooklet pair --link http://127.0.0.1:6471`.

1. `xcrun simctl openurl <udid> 'nooklet://connect?url=…&code=nkp_…'` →
   `simctl-openurl.png`: SpringBoard's "Open in “nooklet”?" (needs a tap; simctl stops here).
   `testPairingLinkOpensPrefilledConfirm` with that link as `TEST_RUNNER_PAIRING_URL` taps through:
   the confirm screen showed "Name this device: iPhone" instead of a token field; Connect redeemed
   the code; Today with both sync dots green. Server: code `used_at` set, token "iPhone" write+sync.
2. `testPairingPageOpensAppWithCode` (`TEST_RUNNER_PAIR_PAGE_URL=<the printed …/pair#code=… URL>`):
   the URL opens in Safari (`pair-page-prompt.png` shows the page and Safari's own
   "Open in “nooklet”?" after tapping "Open in the nooklet app"), the app opens on the code confirm
   screen (`pair-code-confirm.png`), Connect → Today, sync dots green
   (`pair-code-after-connect.png`). This is the camera path minus the camera.
   Querying Safari's elements hangs XCUITest (Safari never reports idle); the test taps by
   screen coordinate through SpringBoard instead.
3. **Bug found here, fixed**: a second pairing URL opened in a Safari tab that already showed the
   pairing page differed only in its fragment (the page strips it), so Safari did a same-document
   hash change and the page kept the OLD, cancelled code; the app then got "no longer valid".
   `PairLanding.tsx` now reloads on `hashchange`. Test: `e2e/tests/qr-pairing.spec.ts` "a second
   pairing URL opened in the same tab shows the new code" (red without the fix).
