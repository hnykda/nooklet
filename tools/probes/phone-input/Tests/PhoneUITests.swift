// Phone input probe (B-662, B-664, B-661, B-684, B-705, B-706): drives the REAL app on a private
// headless Simulator with the SOFTWARE keyboard, connected to a scratch server (see ../run.sh).
// Screenshots each state; the overlay (../overlay.js) prints the event log and layout into them.
// Env (TEST_RUNNER_ prefix stripped by xcodebuild): SHOT_DIR, STEPS (comma list, run in order:
// enter, blockenter, blockslash, marker, toolbar, hide, draftslash, switcher, small),
// SECOND_BASE / SECOND_TOKEN (for `switcher`: a second graph to add, token pasted with a `.`).
import XCTest

final class PhoneUITests: XCTestCase {
  var shotDir = NSTemporaryDirectory()
  let app = XCUIApplication(bundleIdentifier: "sh.nooklet.app")
  var env: [String: String] = [:]

  func testPhoneInput() throws {
    env = ProcessInfo.processInfo.environment
    shotDir = env["SHOT_DIR"] ?? shotDir
    let steps = (env["STEPS"] ?? "enter").split(separator: ",").map(String.init)
    app.launch()
    sleep(8)
    shot("0-start")
    for step in steps {
      switch step {
      case "enter": try enter()
      case "blockenter": try blockEnter()
      case "blockslash": try blockSlash()
      case "marker": try marker()
      case "toolbar": try toolbar()
      case "hide": try hide()
      case "draftslash": try draftSlash()
      case "switcher": try switcher()
      case "small": try small()
      // B-699: the confirm screen a pairing link opens shows the address once, read-only.
      case "tokenlink":
        pairingLink(
          "nooklet://connect?url=http%3A%2F%2F192.168.1.5%3A6100%2Fg%2Fwork&token=nk_"
            + String(repeating: "0", count: 48), "18-token-link")
      case "codelink":
        pairingLink(
          "nooklet://connect?url=http%3A%2F%2F192.168.1.5%3A6100%2Fg%2Fwork&code=nkp_"
            + String(repeating: "a", count: 22), "19-code-link")
      default: XCTFail("unknown step \(step)")
      }
    }
  }

  /// The soft keyboard's own Return key, as a thumb presses it (falls back to typeText "\n").
  func pressReturn() {
    for key in [app.keys["return"], app.keys["Return"], app.buttons["Return"], app.buttons["return"]] {
      if key.exists { print("PROBE return via \(key.identifier)"); key.tap(); return }
    }
    print("PROBE return via typeText")
    app.typeText("\n")
  }

  /// The 123 layer's `/` key, as a finger types it.
  func tapSlashKey() {
    let more = app.keys["more"]
    if more.waitForExistence(timeout: 2) {
      more.tap()
      sleep(1)
      let slashKey = app.keys["/"]
      if slashKey.waitForExistence(timeout: 2) { slashKey.tap(); return }
    }
    app.typeText("/")
  }

  /// Today's empty draft. The accessibility tree does not always list the textarea, so by its
  /// placeholder's place when it does not.
  func tapDraft() {
    let draft = app.textViews.firstMatch
    if draft.waitForExistence(timeout: 5) { draft.tap() } else {
      print("PROBE draft tapped by coordinate")
      app.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.2)).tap()
    }
    sleep(1)
  }

  func dismissKeyboardIntro() {
    let cont = app.buttons["Continue"]
    if cont.waitForExistence(timeout: 2) { cont.tap(); sleep(1) }
  }

  /// B-662: Return in today's empty draft starts the day.
  func enter() throws {
    tapDraft()
    app.typeText("a")
    dismissKeyboardIntro()
    app.typeText("b")
    sleep(1)
    shot("1-draft-typed")
    pressReturn()
    sleep(2)
    shot("2-draft-after-return")
    app.typeText("cd")
    sleep(2)
    shot("3-typed-next-block")
  }

  /// The block editor's Return (CodeMirror's own iOS Enter path).
  func blockEnter() throws {
    pressReturn()
    sleep(2)
    shot("4-block-after-return")
  }

  /// B-684: `/` in a block editor opens the menu on the `/` itself; then pick TODO.
  func blockSlash() throws {
    app.typeText("x ")
    sleep(1)
    tapSlashKey()
    sleep(2)
    shot("5-block-slash")
    app.typeText("todo")
    sleep(1)
    pressReturn()
    sleep(2)
    shot("6-after-todo")
  }

  /// B-661: a tap on the task checkbox while editing; the keyboard must stay up.
  func marker() throws {
    let box = app.descendants(matching: .any).matching(
      NSPredicate(format: "label BEGINSWITH %@", "Task: ")).firstMatch
    XCTAssertTrue(box.waitForExistence(timeout: 5), "no task checkbox")
    box.tap()
    sleep(2)
    print("PROBE keyboard after marker tap: \(app.keyboards.count)")
    shot("7-marker-tapped")
  }

  /// B-661: toolbar buttons on a tap keep the keyboard.
  func toolbar() throws {
    let indent = app.buttons["block.indent"]
    XCTAssertTrue(indent.waitForExistence(timeout: 5), "no indent button")
    indent.tap()
    sleep(2)
    print("PROBE keyboard after indent tap: \(app.keyboards.count)")
    shot("8-indent-tapped")
  }

  /// B-664: the hide-keyboard button, reached by scrolling the toolbar sideways.
  func hide() throws {
    let bar = app.otherElements["Editor toolbar"]
    if bar.waitForExistence(timeout: 3) { bar.swipeLeft(); sleep(1) }
    shot("9-toolbar-scrolled")
    let hide = app.buttons["app.hideKeyboard"]
    XCTAssertTrue(hide.waitForExistence(timeout: 5), "no hide-keyboard button")
    hide.tap()
    sleep(2)
    print("PROBE keyboard after hide: \(app.keyboards.count) toolbar: \(app.buttons["app.hideKeyboard"].exists)")
    shot("10-keyboard-hidden")
    // Back into a block: the toolbar returns, scrolled to its start.
    let row = app.staticTexts["cd"]
    if row.waitForExistence(timeout: 3) { row.tap() } else {
      app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45)).tap()
    }
    sleep(2)
    shot("11-editing-again")
  }

  /// B-684 in today's empty draft (B-646's path): `/` typed with the 123 layer's key.
  func draftSlash() throws {
    tapDraft()
    app.typeText("a")
    dismissKeyboardIntro()
    app.typeText(" ")
    sleep(1)
    shot("12-draft-before-slash")
    tapSlashKey()
    sleep(2)
    shot("13-draft-slash")
  }

  /// Any element by its accessibility label (web buttons and fields do not always carry it as the
  /// identifier the subscript matches).
  func labelled(_ label: String) -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
  }

  /// B-705: focus the switcher's server address; B-706: a token pasted with a trailing `.`.
  func switcher() throws {
    labelled("Switch graph").tap()
    sleep(1)
    app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Add a graph")).firstMatch.tap()
    sleep(1)
    let sync = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Sync with a server")).firstMatch
    if sync.waitForExistence(timeout: 2) { sync.tap(); sleep(1) }
    let address = labelled("Server address")
    XCTAssertTrue(address.waitForExistence(timeout: 5), "no server address field")
    address.tap()
    sleep(2)
    dismissKeyboardIntro()
    shot("14-switcher-address-focused")
    let base = env["SECOND_BASE"] ?? ""
    let token = env["SECOND_TOKEN"] ?? ""
    guard !base.isEmpty, !token.isEmpty else { return }
    // `labelled` finds the field's <label> text; the tap on it focused the field, so type into
    // whatever has focus.
    app.typeText(base)
    labelled("Device token").tap()
    sleep(1)
    // As copied out of a chat message: the sentence's full stop came along (B-706). Typed, not
    // pasted: the paste menu is the system's, and what reaches the field is the same text.
    app.typeText("\(token).")
    sleep(1)
    shot("15-switcher-filled")
    labelled("Connect").tap()
    sleep(6)
    shot("16-switcher-connected")
  }

  /// Opens a `nooklet://` link the way another app would; iOS asks "Open in nooklet?" first.
  func pairingLink(_ link: String, _ name: String) {
    app.open(URL(string: link)!)
    let open = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Open"]
    if open.waitForExistence(timeout: 5) { open.tap() }
    sleep(3)
    shot(name)
    let cancel = labelled("Cancel")
    if cancel.exists { cancel.tap(); sleep(1) }
  }

  /// B-705 belt and braces: a 12px field the CSS floor cannot reach (inline !important, ../overlay.js).
  func small() throws {
    let f = app.textFields["probe small field"]
    XCTAssertTrue(f.waitForExistence(timeout: 5), "no probe field")
    f.tap()
    sleep(2)
    shot("17-small-field-focused")
  }

  private func shot(_ name: String) {
    let s = XCUIScreen.main.screenshot()
    try? s.pngRepresentation.write(to: URL(fileURLWithPath: "\(shotDir)/\(name).png"))
  }
}
