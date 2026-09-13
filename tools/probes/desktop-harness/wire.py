#!/usr/bin/env python3
"""wire.py <copy-of-apps/desktop> — wires probe.rs into a COPY of the desktop app (never apps/desktop itself).

Then build it with its own target dir and bundle id, e.g.
  CARGO_TARGET_DIR=<scratch>/verify-target tauri build --bundles app \\
    --config '{"identifier":"com.nooklet.desktop.devtest2"}'
(run the tauri CLI from apps/desktop/node_modules/.bin with the copy as cwd).
"""
import os, shutil, sys

root = sys.argv[1]
if os.path.realpath(root).endswith("/apps/desktop"):
    sys.exit("refusing: point this at a copy, not apps/desktop")
here = os.path.dirname(os.path.abspath(__file__))
src = os.path.join(root, "src-tauri", "src")
shutil.copy(os.path.join(here, "probe.rs"), os.path.join(src, "probe.rs"))

p = os.path.join(src, "main.rs")
s = open(p).read()
s = s.replace("use tauri::webview::NewWindowResponse;", '#[cfg(target_os = "macos")]\nmod probe;\n\nuse tauri::webview::NewWindowResponse;', 1)
old = '''    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        eprintln!("nooklet: not opening {url}: only http, https and mailto links leave the app");
        return;
    }'''
new = '''    #[cfg(target_os = "macos")]
    let probe_log = |line: String| {
        if let Some(d) = probe::dir() {
            use std::io::Write as _;
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(d.join("opened.log")) {
                let _ = writeln!(f, "{line}");
            }
            return true;
        }
        false
    };
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        #[cfg(target_os = "macos")]
        probe_log(format!("REFUSED {url}"));
        eprintln!("nooklet: not opening {url}: only http, https and mailto links leave the app");
        return;
    }
    #[cfg(target_os = "macos")]
    if probe_log(format!("OPEN {url}")) {
        return;
    }'''
assert old in s, "open_in_browser changed; update wire.py"
s = s.replace(old, new, 1)
old2 = '''                .build()?;

            std::thread::spawn(move || {'''
assert old2 in s, "setup changed; update wire.py"
s = s.replace(old2, '''                .build()?;

            #[cfg(target_os = "macos")]
            probe::start(handle.clone());

            std::thread::spawn(move || {''', 1)
open(p, "w").write(s)

c = os.path.join(root, "src-tauri", "Cargo.toml")
t = open(c).read()
deps = ('objc2 = "0.6"\n'
        'objc2-foundation = { version = "0.3", default-features = false, features = ["std", "NSArray", "NSGeometry", "NSObjCRuntime", "NSString", "NSProcessInfo", "NSDate"] }\n'
        'objc2-app-kit = { version = "0.3", default-features = false, features = ["std", "objc2-core-foundation", "NSApplication", "NSButton", "NSControl", "NSEvent", "NSGraphics", "NSGraphicsContext", "NSMenu", "NSMenuItem", "NSResponder", "NSView", "NSWindow"] }\n')
t = t.replace('tauri = { version = "2", features = [] }\n', 'tauri = { version = "2", features = [] }\n' + deps, 1)
open(c, "w").write(t)
print("wired", root)
