// Phone UI probe (B-646, B-648, B-651): drives the REAL app on a private headless Simulator with
// the SOFTWARE keyboard (XCUITest's typeText goes through it; no hardware keyboard is attached
// without Simulator.app), and screenshots each state. Run by ../run.sh. Env (TEST_RUNNER_ prefix
// stripped by xcodebuild): SHOT_DIR, STEPS (comma list: slash, task, props).
import XCTest

final class PhoneUITests: XCTestCase {
  var shotDir = NSTemporaryDirectory()
  let app = XCUIApplication(bundleIdentifier: "sh.nooklet.app")

  func testPhoneUI() throws {
    let env = ProcessInfo.processInfo.environment
    shotDir = env["SHOT_DIR"] ?? shotDir
    let steps = Set((env["STEPS"] ?? "slash,task,props").split(separator: ",").map(String.init))

    app.launch()
    sleep(5)
    let local = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Just this device")).firstMatch
    if local.waitForExistence(timeout: 5) { local.tap(); sleep(4) }
    shot("0-start")

    if steps.contains("slash") { try slash() }
    if steps.contains("task") { try task() }
    if steps.contains("props") { try props() }
  }

  /// B-646: `/` typed on the soft keyboard into today's empty first line.
  func slash() throws {
    let draft = app.textViews.firstMatch
    XCTAssertTrue(draft.waitForExistence(timeout: 10), "no draft textarea")
    draft.tap()
    sleep(1)
    draft.typeText("a")
    // First use of the soft keyboard shows a full-keyboard "slide to type" intro over it.
    let cont = app.buttons["Continue"]
    if cont.waitForExistence(timeout: 2) { cont.tap(); sleep(1) }
    app.typeText("b /")
    sleep(2)
    shot("1-draft-slash")
    // Pick TODO from the menu by typing its name and Return.
    app.typeText("todo")
    sleep(1)
    shot("2-slash-query")
    app.typeText("\n")
    sleep(2)
    shot("3-after-todo")
  }

  /// B-651: the toolbar's task button cycles the marker; the checkbox ticks it.
  func task() throws {
    let cycle = app.buttons["task.cycle"]
    XCTAssertTrue(cycle.waitForExistence(timeout: 5), "no task.cycle toolbar button")
    cycle.tap()
    sleep(2)
    shot("4-cycled")
    let hide = app.buttons["app.hideKeyboard"]
    if hide.exists { hide.tap(); sleep(2) }
    shot("5-keyboard-hidden")
    let box = app.descendants(matching: .any).matching(
      NSPredicate(format: "label BEGINSWITH %@", "Task: ")).firstMatch
    XCTAssertTrue(box.waitForExistence(timeout: 5), "no task checkbox")
    box.tap()
    sleep(2)
    shot("6-checkbox-tapped")
  }

  /// B-648: open Properties on a page, focus a property field, then look at the layout width.
  func props() throws {
    let toggle = app.buttons["Properties"]
    if !toggle.waitForExistence(timeout: 3) {
      // Journals do not show the panel; open today's page through its title.
      app.links.element(boundBy: 0).tap()
      sleep(3)
    }
    XCTAssertTrue(toggle.waitForExistence(timeout: 10), "no Properties toggle")
    toggle.tap()
    sleep(2)
    shot("7-props-open")
    let field = app.textFields["property"]
    if field.waitForExistence(timeout: 3) {
      field.tap()
      sleep(2)
      shot("8-props-field-focused")
      field.typeText("status")
    }
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
    sleep(2)
    shot("9-props-after-blur")
  }

  private func shot(_ name: String) {
    let s = XCUIScreen.main.screenshot()
    try? s.pngRepresentation.write(to: URL(fileURLWithPath: "\(shotDir)/\(name).png"))
  }
}
