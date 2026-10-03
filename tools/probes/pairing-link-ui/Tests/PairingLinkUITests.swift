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

  private func save(_ shot: XCUIScreenshot, to path: String) {
    try? shot.pngRepresentation.write(to: URL(fileURLWithPath: path))
    let attachment = XCTAttachment(screenshot: shot)
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
