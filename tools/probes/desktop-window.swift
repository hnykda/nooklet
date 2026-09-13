// Drives ONE macOS app window from the outside, by the owning process id — nothing else on screen.
// Written for the desktop-shell work (docs/bugs-inbox/desktop-shell.md): the devtest build of the
// Tauri app has no devtools, so what it shows and how it answers a pointer or a key has to be
// observed the way a user would.
//
//   swiftc -O tools/probes/desktop-window.swift -o <scratch>/desktop-window
//   desktop-window list  <pid>                    window id, bounds (points, top-left origin), title
//   desktop-window shot  <pid> <out.png>          screencapture -l of that pid's main window only
//   desktop-window click <pid> <x> <y>            left click at a window-relative point
//   desktop-window drag  <pid> <x> <y> <dx> <dy>  press at a window point, move by dx/dy, release
//   desktop-window key   <pid> <keycode> [cmd|shift|alt|ctrl ...]   key down/up, app activated first
//   desktop-window front <pid>                    activate the app
//   desktop-window quit  <pid>                    quit it normally (NSRunningApplication.terminate)
//   desktop-window frontmost 0                    pid of the app that has the keyboard
//   desktop-window give-back <pid>                activate that app again (never launches one)
//
// Clicks and keys are CGEvents: the process running this needs Accessibility permission, or macOS
// drops them silently — every input command prints whether this process is trusted, so that is
// never a guess.
import AppKit
import CoreGraphics
import Foundation

func windows(of pid: pid_t) -> [[String: Any]] {
  let all = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
  return all.filter {
    ($0[kCGWindowOwnerPID as String] as? pid_t) == pid && ($0[kCGWindowLayer as String] as? Int) == 0
      && (($0[kCGWindowBounds as String] as? [String: CGFloat])?["Height"] ?? 0) > 100
  }
}

func mainWindow(_ pid: pid_t) -> (id: CGWindowID, frame: CGRect)? {
  // The largest one: Tauri also owns a small offscreen window, and it is sometimes listed first.
  let area = { (w: [String: Any]) -> CGFloat in
    let b = w[kCGWindowBounds as String] as? [String: CGFloat] ?? [:]
    return (b["Width"] ?? 0) * (b["Height"] ?? 0)
  }
  guard let w = windows(of: pid).max(by: { area($0) < area($1) }),
    let id = w[kCGWindowNumber as String] as? CGWindowID,
    let b = w[kCGWindowBounds as String] as? [String: CGFloat]
  else { return nil }
  return (id, CGRect(x: b["X"]!, y: b["Y"]!, width: b["Width"]!, height: b["Height"]!))
}

func post(_ type: CGEventType, _ p: CGPoint, clicks: Int64 = 1) {
  let e = CGEvent(
    mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: .left)!
  e.setIntegerValueField(.mouseEventClickState, value: clicks)
  e.post(tap: .cghidEventTap)
}

func activate(_ pid: pid_t) {
  print("accessibility trusted: \(AXIsProcessTrusted())")
  NSRunningApplication(processIdentifier: pid)?.activate()
  usleep(400_000)
}

let args = CommandLine.arguments
guard args.count >= 3, let pid = pid_t(args[2]) else {
  print("usage: desktop-window list|shot|click|drag|key|front <pid> …")
  exit(2)
}

switch args[1] {
case "list":
  for w in windows(of: pid) {
    print(
      w[kCGWindowNumber as String] ?? "?", w[kCGWindowBounds as String] ?? "?",
      w[kCGWindowName as String] ?? "")
  }
case "shot":
  guard let w = mainWindow(pid) else {
    print("no window for pid \(pid)")
    exit(1)
  }
  let task = Process()
  task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
  task.arguments = ["-x", "-o", "-l", String(w.id), args[3]]
  try task.run()
  task.waitUntilExit()
  print("window \(w.id) \(w.frame) -> \(args[3])")
case "front":
  activate(pid)
case "frontmost":
  // Which app has the keyboard right now — recorded before a launch, so focus can be handed back.
  print(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1)
case "give-back":
  // Hand activation back to <pid> (the app that had it before a launch). Never launches anything.
  // Launching the app activates it, and on a machine someone is using, their next keystrokes land
  // in the test window instead of where they meant them — that happened once during this work.
  let ok = NSRunningApplication(processIdentifier: pid)?.activate() ?? false
  usleep(300_000)
  print("gave focus back to \(pid): \(ok), frontmost now \(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1)")
case "quit":
  // A normal quit (what Cmd+Q does), not a signal: WebKit gets to tear its pages down, which is
  // the difference between "the user quit the app" and "the process died" for a service worker.
  let ok = NSRunningApplication(processIdentifier: pid)?.terminate() ?? false
  for _ in 0..<50 where kill(pid, 0) == 0 { usleep(100_000) }
  print("terminate sent: \(ok), exited: \(kill(pid, 0) != 0)")
case "click":
  guard let w = mainWindow(pid) else {
    print("no window")
    exit(1)
  }
  activate(pid)
  let p = CGPoint(x: w.frame.minX + Double(args[3])!, y: w.frame.minY + Double(args[4])!)
  post(.mouseMoved, p)
  usleep(80_000)
  post(.leftMouseDown, p)
  usleep(80_000)
  post(.leftMouseUp, p)
  print("clicked \(p)")
case "drag":
  guard let w = mainWindow(pid) else {
    print("no window")
    exit(1)
  }
  activate(pid)
  let start = CGPoint(x: w.frame.minX + Double(args[3])!, y: w.frame.minY + Double(args[4])!)
  let dx = Double(args[5])!
  let dy = Double(args[6])!
  post(.mouseMoved, start)
  usleep(80_000)
  post(.leftMouseDown, start)
  usleep(150_000)
  for i in 1...20 {
    post(
      .leftMouseDragged,
      CGPoint(x: start.x + dx * Double(i) / 20, y: start.y + dy * Double(i) / 20))
    usleep(20_000)
  }
  post(.leftMouseUp, CGPoint(x: start.x + dx, y: start.y + dy))
  usleep(400_000)
  print("before \(w.frame) after \(mainWindow(pid)?.frame ?? .zero)")
case "key":
  activate(pid)
  var flags: CGEventFlags = []
  for m in args.dropFirst(4) {
    switch m {
    case "cmd": flags.insert(.maskCommand)
    case "shift": flags.insert(.maskShift)
    case "alt": flags.insert(.maskAlternate)
    case "ctrl": flags.insert(.maskControl)
    default: break
    }
  }
  let code = CGKeyCode(args[3])!
  let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)!
  down.flags = flags
  down.post(tap: .cghidEventTap)
  usleep(40_000)
  let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)!
  up.flags = flags
  up.post(tap: .cghidEventTap)
  print("key \(code) flags \(flags.rawValue)")
default:
  print("unknown command \(args[1])")
  exit(2)
}
