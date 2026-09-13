"""Cmd+C/V/X/Z/Shift+Z/A in a plain textarea (Settings → Custom CSS) and in a block; Cmd+, and Cmd+R.
Snapshots the general pasteboard first and restores it after, so the person's clipboard survives.
Result 2026-09-13: textarea — all work through the native Edit menu; block — all but Cmd+V (B-536),
which works after the dispatcher fix. Run the block half on a page you do not mind writing to."""
import sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from drv import *

PB = V + "/pb"
LEFT, RIGHT = "", ""  # NSLeftArrowFunctionKey, NSRightArrowFunctionKey
ev("window.__keys = []; if (!window.__keysHooked) { window.__keysHooked = true; addEventListener('keydown', e => window.__keys.push([e.key, e.metaKey, e.defaultPrevented])); } return 1;")
keys = lambda: ev("const k = window.__keys; window.__keys = []; return k;")

def key(code, ch, mods, label, read, wait=0.4):
    guard()
    pc(f"key {code} {ch} {mods}")
    time.sleep(wait)
    print(f"  {label}: {read()} page keydown(key, meta, defaultPrevented)={keys()} clipboard-is-ours={sh(PB, 'text') in ('beta', 'alpha', 'world', 'world ')}")

print(sh(PB, "save", V + "/pb-snapshot.plist"))
try:
    # 1. A textarea: nothing in the page handles these keys, so the native Edit menu must.
    if not ev("return !!document.querySelector('[role=dialog] textarea')"):
        pc("menu @app/Settings…"); time.sleep(0.8)
    TA = "document.querySelector('[role=dialog] textarea')"
    val = lambda: ev(f"const t = {TA}; return t && {{v: t.value, sel: [t.selectionStart, t.selectionEnd]}};")
    with Burst():
        click_el(TA, "Custom CSS textarea"); time.sleep(0.3)
        pc("type alpha beta"); time.sleep(0.5); print("  typed:", val())
        ev(f"{TA}.setSelectionRange(6, 10); return 1;"); key(8, "c", "cmd", "Cmd+C", val)
        ev(f"const t = {TA}; t.setSelectionRange(t.value.length, t.value.length); return 1;"); pc("key 49 SPACE")
        key(9, "v", "cmd", "Cmd+V", val)
        ev(f"{TA}.setSelectionRange(0, 6); return 1;"); key(7, "x", "cmd", "Cmd+X", val)
        key(6, "z", "cmd", "Cmd+Z", val); key(6, "z", "cmd,shift", "Shift+Cmd+Z", val); key(0, "a", "cmd", "Cmd+A", val)
        key(51, "\x7f", "", "Delete (leave Custom CSS empty again)", val)
        key(53, "\x1b", "", "Escape", val)
    # 2. A block on a scratch page.
    ev("history.pushState({}, '', '/page/' + encodeURIComponent('probe desktop keys')); dispatchEvent(new PopStateEvent('popstate')); return 1;"); time.sleep(2)
    ev("document.querySelector('.page-view-missing button')?.click(); return 1"); time.sleep(2)
    st = lambda: ev("return {rows: [...document.querySelectorAll('.vr-row')].map(r => r.textContent), dialogs: [...document.querySelectorAll('[role=dialog]')].map(d => d.getAttribute('aria-label')), nav: performance.getEntriesByType('navigation')[0]?.type, t: Math.round(performance.now())};")
    with Burst():
        click_el("document.querySelector('.cm-content')", "block editor"); time.sleep(0.3)
        pc("type hello world"); time.sleep(0.6); print("  typed:", st(), keys())
        key(123, LEFT, "alt,shift", "Alt+Shift+Left", st); key(8, "c", "cmd", "Cmd+C", st)
        key(124, RIGHT, "", "Right", st); pc("key 49 SPACE"); key(9, "v", "cmd", "Cmd+V", st, wait=0.6)
        key(6, "z", "cmd", "Cmd+Z", st); key(6, "z", "cmd,shift", "Shift+Cmd+Z", st)
        key(123, LEFT, "alt,shift", "Alt+Shift+Left", st); key(7, "x", "cmd", "Cmd+X", st); key(6, "z", "cmd", "Cmd+Z", st)
        shot("v08-block-editor-clipboard")
        key(43, ",", "cmd", "Cmd+,", st, wait=0.8); shot("v09-cmd-comma-settings")
        key(53, "\x1b", "", "Escape", st)
        key(15, "r", "cmd", "Cmd+R", st, wait=5)
finally:
    print(sh(PB, "restore", V + "/pb-snapshot.plist"))
