// Phone images + slash probe (B-682, B-683, B-684): drives the REAL app on a private headless
// Simulator with the SOFTWARE keyboard, already connected to a scratch server whose today's
// journal holds "first block", an uploaded 1200x900 image and "third block" (see ../run.sh).
// Screenshots each state; the overlay (../overlay.js) prints the measurements into them.
// Env (TEST_RUNNER_ prefix stripped by xcodebuild): SHOT_DIR, STEPS (comma list: slash, picker).
import XCTest

final class PhoneUITests: XCTestCase {
  var shotDir = NSTemporaryDirectory()
  let app = XCUIApplication(bundleIdentifier: "sh.nooklet.app")

  func testPhoneUI() throws {
    let env = ProcessInfo.processInfo.environment
    shotDir = env["SHOT_DIR"] ?? shotDir
    let steps = Set((env["STEPS"] ?? "slash,picker").split(separator: ",").map(String.init))

    app.launch()
    sleep(8)
    shot("0-start")
    if steps.contains("slash") { try slash() }
    if steps.contains("picker") { try picker() }
  }

  /// B-684: `/` typed on the soft keyboard at the end of an existing block.
  func slash() throws {
    let first = app.staticTexts["first block"]
    XCTAssertTrue(first.waitForExistence(timeout: 10), "no first block")
    // At the end of the text, as a person adding to a block would.
    first.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.5)).tap()
    sleep(1)
    app.typeText(" ")
    let cont = app.buttons["Continue"]
    if cont.waitForExistence(timeout: 2) { cont.tap(); sleep(1) }
    shot("1-before-slash")
    // Like a finger: the 123 layer's key, then its `/` key (typeText may inject differently).
    let more = app.keys["more"]
    if more.waitForExistence(timeout: 2) {
      more.tap()
      sleep(1)
      let slashKey = app.keys["/"]
      if slashKey.waitForExistence(timeout: 2) { slashKey.tap() } else { app.typeText("/") }
    } else {
      app.typeText("/")
    }
    sleep(2)
    shot("2-after-slash")
    app.typeText("i")
    sleep(2)
    shot("3-after-slash-i")
  }

  /// B-682/B-683: `/image` through the real photo picker.
  func picker() throws {
    app.typeText("mage")
    sleep(1)
    app.typeText("\n")
    sleep(3)
    shot("4-chooser")
    let library = app.buttons["Photo Library"]
    if library.waitForExistence(timeout: 5) {
      library.tap()
      sleep(4)
    }
    shot("5-library")
    // The photo picker runs out of process: tap by coordinates. iOS 26's picker opens a preview
    // on a tap; its top-right check button confirms. PICK = normalized x,y of the cell.
    let pick = (ProcessInfo.processInfo.environment["PICK"] ?? "0.5,0.43").split(separator: ",")
      .map { Double($0)! }
    app.coordinate(withNormalizedOffset: CGVector(dx: pick[0], dy: pick[1])).tap()
    sleep(3)
    shot("5b-preview")
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.905, dy: 0.125)).tap()
    sleep(6)
    shot("6-after-pick")
    let hide = app.buttons["app.hideKeyboard"]
    if hide.exists { hide.tap(); sleep(2) }
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)).tap()
    sleep(3)
    shot("7-rendered")
  }

  private func shot(_ name: String) {
    let s = XCUIScreen.main.screenshot()
    try? s.pngRepresentation.write(to: URL(fileURLWithPath: "\(shotDir)/\(name).png"))
  }
}
