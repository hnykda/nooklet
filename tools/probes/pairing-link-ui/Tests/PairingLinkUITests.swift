// B-603 probe: open a nooklet://connect pairing link in the REAL app on a headless Simulator,
// screenshot the pre-filled confirm screen, then tap Connect and screenshot the result.
// `simctl openurl` stops at SpringBoard's "Open in nooklet?" alert, which needs a tap, and no tap
// tool is installed; XCUITest can tap it without Simulator.app ever being opened.
// See ../run.sh for how it is driven. Env (TEST_RUNNER_ prefix stripped by xcodebuild):
//   PAIRING_URL  the nooklet://connect?... link      SHOT_DIR  where to write the PNGs
import XCTest

final class PairingLinkUITests: XCTestCase {
  func testPairingLinkOpensPrefilledConfirm() throws {
    let env = ProcessInfo.processInfo.environment
    let url = try XCTUnwrap(URL(string: env["PAIRING_URL"] ?? ""))
    let shotDir = env["SHOT_DIR"] ?? NSTemporaryDirectory()

    let app = XCUIApplication(bundleIdentifier: "sh.nooklet.app")
    app.launch()
    sleep(4)

    XCUIDevice.shared.system.open(url)
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    let open = springboard.buttons["Open"]
    if open.waitForExistence(timeout: 4) { open.tap() }

    let heading = app.staticTexts["Connect to this server?"]
    XCTAssertTrue(heading.waitForExistence(timeout: 15), "confirm screen did not appear")
    sleep(1)
    save(XCUIScreen.main.screenshot(), to: "\(shotDir)/pairing-confirm.png")

    // Nothing has been contacted yet; the owner's tap is what connects.
    app.buttons["Connect"].tap()
    sleep(8)
    save(XCUIScreen.main.screenshot(), to: "\(shotDir)/pairing-after-connect.png")
    XCTAssertFalse(heading.exists, "still on the confirm screen after Connect")
  }

  // B-655: the path a camera scan takes, minus the camera. PAIR_PAGE_URL is the https (or
  // loopback http) pairing page `nooklet pair` prints / the QR holds: it opens in Safari, the page's
  // "Open in the nooklet app" link is tapped, Safari's own "Open in nooklet?" prompt is accepted,
  // and the app must show the code confirm screen; Connect redeems the code.
  func testPairingPageOpensAppWithCode() throws {
    let env = ProcessInfo.processInfo.environment
    let url = try XCTUnwrap(URL(string: env["PAIR_PAGE_URL"] ?? ""))
    let shotDir = env["SHOT_DIR"] ?? NSTemporaryDirectory()

    // A Safari tab left on an earlier build's pairing page keeps that document (a fragment-only
    // navigation does not reload it), so start from a fresh Safari process.
    XCUIApplication(bundleIdentifier: "com.apple.mobilesafari").terminate()
    XCUIDevice.shared.system.open(url)
    // Querying Safari's elements hung the runner (it waits for Safari to go idle, which a page
    // with a live web view never quite does — the first attempt sat there for 10 minutes). So
    // Safari is driven by screen coordinates through SpringBoard, which is always idle: the
    // "Open in the nooklet app" button's centre on an iPhone 17 Pro portrait screen, measured
    // from `pair-page-safari.png`.
    sleep(8)
    save(XCUIScreen.main.screenshot(), to: "\(shotDir)/pair-page-safari.png")
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.29)).tap()
    sleep(3)
    save(XCUIScreen.main.screenshot(), to: "\(shotDir)/pair-page-prompt.png")
    // Safari's "Open in “nooklet”?" prompt: its Open button is the right-hand one.
    let open = springboard.buttons["Open"]
    if open.waitForExistence(timeout: 2) {
      open.tap()
    } else {
      let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
      let safariOpen = safari.buttons["Open"]
      if safariOpen.waitForExistence(timeout: 5) { safariOpen.tap() }
    }

    let app = XCUIApplication(bundleIdentifier: "sh.nooklet.app")
    let heading = app.staticTexts["Connect to this server?"]
    XCTAssertTrue(heading.waitForExistence(timeout: 20), "the app's confirm screen did not appear")
    XCTAssertTrue(app.textFields["Name this device"].exists, "no device-name field: not code mode")
    sleep(1)
    save(XCUIScreen.main.screenshot(), to: "\(shotDir)/pair-code-confirm.png")
    app.buttons["Connect"].tap()
    sleep(8)
    save(XCUIScreen.main.screenshot(), to: "\(shotDir)/pair-code-after-connect.png")
    XCTAssertFalse(heading.exists, "still on the confirm screen after Connect")
  }

  private func save(_ shot: XCUIScreenshot, to path: String) {
    try? shot.pngRepresentation.write(to: URL(fileURLWithPath: path))
    let attachment = XCTAttachment(screenshot: shot)
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
