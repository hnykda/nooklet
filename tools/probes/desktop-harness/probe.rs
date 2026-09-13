//! An in-process driver for the desktop app's window — a PROBE, never part of `apps/desktop`.
//! Written for docs/bugs-inbox/desktop-shell.md (B-531..B-537 verification, 2026-09-13).
//!
//! Why in-process: posting CGEvents from outside needs macOS Accessibility permission, and the
//! agent shell that verifies the app does not have it (`AXIsProcessTrusted` false), so external
//! clicks and keys are dropped silently. Events built with `NSEvent` and handed to
//! `NSApp postEvent:` from inside the app take AppKit's normal path — `NSWindow sendEvent:`, native
//! hit-testing (a traffic-light button over the web view WOULD take the click), WebKit's
//! `performKeyEquivalent` and the menu bar's key equivalents — so they show what a user's pointer
//! and keys do. What they cannot show: anything the window server does itself (dragging a window by
//! its title bar ignores synthesized drags).
//!
//! Wiring (`wire.py` does it on a COPY of apps/desktop): `mod probe;` in main.rs,
//! `probe::start(handle.clone())` after the window is built, objc2/objc2-foundation/objc2-app-kit
//! in Cargo.toml, and `open_in_browser` writing `OPEN <url>` / `REFUSED <url>` to
//! `$NOOKLET_PROBE_DIR/opened.log` instead of opening the owner's browser.
//!
//! Enabled only when NOOKLET_PROBE_DIR is set. Protocol: write `<dir>/<name>.cmd` holding one
//! command; the result appears in `<dir>/<name>.out`. Commands: `eval <js>` (result JSON),
//! `geom`, `hit <x> <y>` (window points, top-left origin), `click <x> <y>`, `drag <x> <y> <dx> <dy>`,
//! `key <keycode> <chars> [cmd,shift,alt,ctrl]`, `type <text>`, `activate`, `status`, `frame`,
//! `menu-dump`, `menu <Title/Item>` (first component `@app` = the application menu).
#![allow(unused_unsafe, deprecated)]

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::MainThreadMarker;
use objc2_app_kit::{
    NSApplication, NSEvent, NSEventModifierFlags, NSEventType, NSMenu, NSView, NSWindow, NSWindowButton,
};
use objc2_foundation::{NSPoint, NSProcessInfo, NSRect, NSString};
use tauri::{AppHandle, Manager, Runtime};

pub fn dir() -> Option<PathBuf> {
    std::env::var("NOOKLET_PROBE_DIR").ok().filter(|d| !d.is_empty()).map(PathBuf::from)
}

pub fn start<R: Runtime>(app: AppHandle<R>) {
    let Some(dir) = dir() else { return };
    let _ = fs::create_dir_all(&dir);
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(80));
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        let mut cmds: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "cmd"))
            .collect();
        cmds.sort();
        for path in cmds {
            let Ok(text) = fs::read_to_string(&path) else { continue };
            let _ = fs::rename(&path, path.with_extension("taken"));
            let out = path.with_extension("out");
            let app2 = app.clone();
            let (tx, rx) = std::sync::mpsc::channel::<()>();
            let _ = app.run_on_main_thread(move || {
                let result = run(&app2, &out, text.trim());
                if let Some(r) = result {
                    write(&out, &r);
                }
                let _ = tx.send(());
            });
            let _ = rx.recv_timeout(Duration::from_secs(10));
        }
    });
}

fn write(out: &Path, s: &str) {
    let tmp = out.with_extension("tmp");
    let _ = fs::write(&tmp, s);
    let _ = fs::rename(&tmp, out);
}

fn now() -> f64 {
    NSProcessInfo::processInfo().systemUptime()
}

fn ns_window<R: Runtime>(app: &AppHandle<R>) -> Option<&'static NSWindow> {
    let w = app.get_webview_window("main")?;
    let ptr = w.ns_window().ok()? as *const NSWindow;
    if ptr.is_null() {
        return None;
    }
    Some(unsafe { &*ptr })
}

fn class_name(obj: &AnyObject) -> String {
    obj.class().name().to_string_lossy().into_owned()
}

/// Window-relative point with a TOP-LEFT origin (what screenshots and CSS use) → AppKit window base
/// coordinates (bottom-left origin).
fn to_base(win: &NSWindow, x: f64, y: f64) -> NSPoint {
    let h = win.frame().size.height;
    NSPoint::new(x, h - y)
}

fn rect_tl(win: &NSWindow, r: NSRect) -> String {
    let h = win.frame().size.height;
    format!(
        "{{\"x\":{:.1},\"y\":{:.1},\"w\":{:.1},\"h\":{:.1}}}",
        r.origin.x,
        h - r.origin.y - r.size.height,
        r.size.width,
        r.size.height
    )
}

fn view_rect_in_window(win: &NSWindow, v: &NSView) -> String {
    let r = unsafe { v.convertRect_toView(v.bounds(), None) };
    rect_tl(win, r)
}

fn hit(win: &NSWindow, x: f64, y: f64) -> String {
    let Some(content) = win.contentView() else { return "no content view".into() };
    let frame_view: Retained<NSView> = unsafe { content.superview() }.unwrap_or(content.clone());
    let p = to_base(win, x, y);
    match unsafe { frame_view.hitTest(p) } {
        Some(v) => {
            let mut chain = vec![class_name(&v)];
            let mut cur = unsafe { v.superview() };
            while let Some(s) = cur {
                chain.push(class_name(&s));
                cur = unsafe { s.superview() };
            }
            chain.join(" < ")
        }
        None => "nil".into(),
    }
}

fn post(app: &NSApplication, ev: Option<Retained<NSEvent>>) -> bool {
    match ev {
        Some(e) => {
            unsafe { app.postEvent_atStart(&e, false) };
            true
        }
        None => false,
    }
}

fn flags(mods: &str) -> NSEventModifierFlags {
    let mut f = NSEventModifierFlags::empty();
    for m in mods.split(',') {
        match m {
            "cmd" => f |= NSEventModifierFlags::Command,
            "shift" => f |= NSEventModifierFlags::Shift,
            "alt" => f |= NSEventModifierFlags::Option,
            "ctrl" => f |= NSEventModifierFlags::Control,
            _ => {}
        }
    }
    f
}

fn key(app: &NSApplication, win: &NSWindow, code: u16, chars: &str, mods: &str) -> bool {
    let f = flags(mods);
    let wn = win.windowNumber();
    let c = NSString::from_str(chars);
    let mut ok = true;
    for ty in [NSEventType::KeyDown, NSEventType::KeyUp] {
        let ev = unsafe {
            NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
                ty, NSPoint::new(0.0, 0.0), f, now(), wn, None, &c, &c, false, code,
            )
        };
        ok &= post(app, ev);
    }
    ok
}

fn mouse(app: &NSApplication, win: &NSWindow, ty: NSEventType, x: f64, y: f64, clicks: isize) -> bool {
    let ev = unsafe {
        NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            ty,
            to_base(win, x, y),
            NSEventModifierFlags::empty(),
            now(),
            win.windowNumber(),
            None,
            0,
            clicks,
            if matches!(ty, NSEventType::LeftMouseUp) { 0.0 } else { 1.0 },
        )
    };
    post(app, ev)
}

fn find_menu_item(menu: &NSMenu, path: &[&str]) -> Option<(Retained<NSMenu>, isize)> {
    let (first, rest) = path.split_first()?;
    let items = menu.itemArray();
    for i in 0..items.count() {
        let item = items.objectAtIndex(i);
        let title = item.title().to_string();
        let matches = title == *first || (*first == "@app" && i == 0);
        if !matches {
            continue;
        }
        if rest.is_empty() {
            let idx = menu.indexOfItem(&item);
            // SAFETY: caller only uses it on the main thread
            let owned: Retained<NSMenu> = unsafe { Retained::retain(menu as *const NSMenu as *mut NSMenu) }?;
            return Some((owned, idx));
        }
        if let Some(sub) = item.submenu() {
            return find_menu_item(&sub, rest);
        }
    }
    None
}

fn dump_menu(menu: &NSMenu, depth: usize, out: &mut String) {
    let items = menu.itemArray();
    for i in 0..items.count() {
        let item = items.objectAtIndex(i);
        let key = item.keyEquivalent().to_string();
        let mask = item.keyEquivalentModifierMask();
        out.push_str(&format!(
            "{}{} [key={:?} mods={:#x} enabled={}]\n",
            "  ".repeat(depth),
            if item.isSeparatorItem() { "----".to_string() } else { item.title().to_string() },
            key,
            mask.0,
            item.isEnabled()
        ));
        if let Some(sub) = item.submenu() {
            dump_menu(&sub, depth + 1, out);
        }
    }
}

fn run<R: Runtime>(app: &AppHandle<R>, out: &Path, cmd: &str) -> Option<String> {
    let mtm = MainThreadMarker::new().expect("main thread");
    let nsapp = NSApplication::sharedApplication(mtm);
    let Some(win) = ns_window(app) else { return Some("no window".into()) };
    let (verb, rest) = cmd.split_once(' ').unwrap_or((cmd, ""));
    match verb {
        "eval" => {
            let out = out.to_path_buf();
            let Some(w) = app.get_webview_window("main") else { return Some("no webview".into()) };
            let r = w.eval_with_callback(rest.to_string(), move |res| write(&out, &res));
            match r {
                Ok(()) => None,
                Err(e) => Some(format!("eval error {e}")),
            }
        }
        "geom" => {
            let content = win.contentView()?;
            let mut s = format!(
                "frame(screen,bottom-left)={:?}\nstyleMask={:#x}\ncontentLayoutRect(tl)={}\ncontentView={} rect(tl)={}\ntitlebarAppearsTransparent={} titleVisibility={:?} movable={} movableByBackground={} isKey={} appActive={}\n",
                win.frame(),
                win.styleMask().0,
                rect_tl(win, win.contentLayoutRect()),
                class_name(&content),
                view_rect_in_window(win, &content),
                win.titlebarAppearsTransparent(),
                win.titleVisibility(),
                win.isMovable(),
                win.isMovableByWindowBackground(),
                win.isKeyWindow(),
                nsapp.isActive(),
            );
            for (name, b) in [
                ("close", NSWindowButton::CloseButton),
                ("mini", NSWindowButton::MiniaturizeButton),
                ("zoom", NSWindowButton::ZoomButton),
            ] {
                if let Some(btn) = win.standardWindowButton(b) {
                    s.push_str(&format!("{name} button rect(tl)={} hidden={}\n", view_rect_in_window(win, &btn), btn.isHidden()));
                }
            }
            let subs = content.subviews();
            for i in 0..subs.count() {
                let v = subs.objectAtIndex(i);
                s.push_str(&format!("content subview {} rect(tl)={}\n", class_name(&v), view_rect_in_window(win, &v)));
            }
            Some(s)
        }
        "hit" => {
            let mut p = rest.split_whitespace().map(|n| n.parse::<f64>().unwrap_or(0.0));
            let (x, y) = (p.next()?, p.next()?);
            Some(hit(win, x, y))
        }
        "activate" => {
            nsapp.activateIgnoringOtherApps(true);
            win.makeKeyAndOrderFront(None);
            Some(format!("active={}", nsapp.isActive()))
        }
        "status" => Some(format!("active={} key={}", nsapp.isActive(), win.isKeyWindow())),
        "key" => {
            // key <keycode> <chars> [mods]
            let mut p = rest.splitn(3, ' ');
            let code: u16 = p.next()?.parse().ok()?;
            let chars = p.next()?.replace("SPACE", " ");
            let mods = p.next().unwrap_or("");
            Some(format!("posted={}", key(&nsapp, win, code, &chars, mods)))
        }
        "type" => {
            let mut ok = true;
            for ch in rest.chars() {
                ok &= key(&nsapp, win, 0, &ch.to_string(), "");
            }
            Some(format!("posted={ok}"))
        }
        "click" => {
            let mut p = rest.split_whitespace().map(|n| n.parse::<f64>().unwrap_or(0.0));
            let (x, y) = (p.next()?, p.next()?);
            let h = hit(win, x, y);
            let ok = mouse(&nsapp, win, NSEventType::LeftMouseDown, x, y, 1) & mouse(&nsapp, win, NSEventType::LeftMouseUp, x, y, 1);
            Some(format!("posted={ok} hit={h}"))
        }
        "drag" => {
            let mut p = rest.split_whitespace().map(|n| n.parse::<f64>().unwrap_or(0.0));
            let (x, y, dx, dy) = (p.next()?, p.next()?, p.next()?, p.next()?);
            let before = win.frame();
            let mut ok = mouse(&nsapp, win, NSEventType::LeftMouseDown, x, y, 1);
            for i in 1..=10 {
                let f = i as f64 / 10.0;
                ok &= mouse(&nsapp, win, NSEventType::LeftMouseDragged, x + dx * f, y + dy * f, 1);
            }
            ok &= mouse(&nsapp, win, NSEventType::LeftMouseUp, x + dx, y + dy, 1);
            Some(format!("posted={ok} hit={} frame_before={:?}", hit(win, x, y), before))
        }
        "frame" => Some(format!("{:?}", win.frame())),
        "menu-dump" => {
            let mut s = String::new();
            if let Some(m) = nsapp.mainMenu() {
                dump_menu(&m, 0, &mut s);
            }
            Some(s)
        }
        "menu" => {
            // menu Title/Sub/Item  (first component may be @app)
            let path: Vec<&str> = rest.split('/').collect();
            let Some(m) = nsapp.mainMenu() else { return Some("no main menu".into()) };
            match find_menu_item(&m, &path) {
                Some((menu, idx)) => {
                    menu.performActionForItemAtIndex(idx);
                    Some(format!("performed {rest} (index {idx})"))
                }
                None => Some(format!("not found: {rest}")),
            }
        }
        _ => Some(format!("unknown command {verb}")),
    }
}
