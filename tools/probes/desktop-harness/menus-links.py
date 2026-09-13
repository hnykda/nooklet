"""Native menu items chosen as a user would (NSMenu performActionForItemAtIndex), and links that ask for a
new window. The wired harness logs `OPEN`/`REFUSED` to probe/opened.log instead of opening a browser.
Result 2026-09-13: Settings… and Help → Keyboard Shortcuts open the client's dialogs; View → Reload reloads;
Documentation / Report a Bug and a clicked https link in a note → OPEN; zotero:// → REFUSED; a file:// link
never reaches the handler (WebKit refuses it from an http page first)."""
import sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from drv import *

dialogs = lambda: ev("return [...document.querySelectorAll('[role=dialog]')].map(d => d.getAttribute('aria-label'))")
close = lambda: ev("document.querySelector('[role=dialog] button[aria-label=Close]')?.click(); return 1")
print(pc("menu @app/Settings…")); time.sleep(0.8); print("  dialogs:", dialogs()); shot("v10-menu-settings"); close(); time.sleep(0.4)
print(pc("menu Help/Keyboard Shortcuts")); time.sleep(0.8); print("  dialogs:", dialogs()); shot("v11-menu-keyboard-shortcuts"); close(); time.sleep(0.4)
ev("window.__marker = 1; return 1"); print(pc("menu View/Reload")); time.sleep(6)
print("  reloaded:", ev("return [window.__marker === undefined, performance.getEntriesByType('navigation')[0]?.type]"))
print(pc("menu Help/nooklet Documentation")); print(pc("menu Help/Report a Bug…"))

ev("history.pushState({}, '', '/journals'); dispatchEvent(new PopStateEvent('popstate')); return 1;"); time.sleep(2.5)
ev("const a = [...document.querySelectorAll('.vr-outliner a[target=_blank]')].find(a => a.href.startsWith('https://')); a?.scrollIntoView({block: 'center'}); for (const [id, href, top] of [['probe-file-link', 'file:///System/Applications/Calculator.app', 300], ['probe-app-link', 'zotero://select/items/ABC', 360]]) { const l = document.createElement('a'); l.id = id; l.href = href; l.target = '_blank'; l.textContent = id; l.style.cssText = `position:fixed;left:300px;top:${top}px;z-index:99999;background:yellow;padding:8px`; document.body.append(l); } return 1;")
time.sleep(0.6)
with Burst():
    click_el("[...document.querySelectorAll('.vr-outliner a[target=_blank]')].find(a => a.href.startsWith('https://'))", "https link in a note"); time.sleep(1.2)
    click_el("document.getElementById('probe-file-link')", "file:// link"); time.sleep(1)
    click_el("document.getElementById('probe-app-link')", "zotero:// link"); time.sleep(1)
print("  still in the app:", ev("return location.href"))
ev("document.getElementById('probe-file-link')?.remove(); document.getElementById('probe-app-link')?.remove(); return 1")
print("opened.log:\n" + open(V + "/probe/opened.log").read())
