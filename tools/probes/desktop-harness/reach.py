"""At the default window: Toggle sidebar → Graph → Pages → ? → Settings, by real (in-app) clicks.
Result 2026-09-13: every click hit the WKWebView (not a traffic light) and did its job (shots v02..v06)."""
import sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from drv import *

state = lambda: ev("const s = document.querySelector('aside[aria-label=Sidebar]'); return {path: location.pathname, sidebar: !!s && getComputedStyle(s).display !== 'none', dialogs: [...document.querySelectorAll('[role=dialog]')].map(d => d.getAttribute('aria-label'))};")
link = lambda name: f"[...document.querySelectorAll('aside[aria-label=Sidebar] a')].find(a => a.textContent.trim() === '{name}')"
print("geom:\n" + pc("geom"))
for label, pt in [("Toggle sidebar", "21 54"), ("title strip", "300 16"), ("close button", "16 16")]:
    print(f"hit {label}: {pc('hit ' + pt)}")
print("before:", state())
with Burst():
    click_el("document.querySelector('button[aria-label=\"Toggle sidebar\"]')", "Toggle sidebar")
    time.sleep(0.8); print("  after toggle:", state()); shot("v02-click-toggle-sidebar")
    click_el(link("Graph"), "Graph")
    time.sleep(1.5); print("  after Graph:", state()); shot("v03-click-graph")
    click_el(link("Pages"), "Pages")
    time.sleep(1.2); print("  after Pages:", state()); shot("v04-click-all-pages")
    click_el("document.querySelector('button[aria-label=Help]')", "Help ?")
    time.sleep(0.6); shot("v05-click-help")
    click_el("[...document.querySelectorAll('.help-item')].find(e => e.textContent.includes('Settings'))", "Help > Settings")
    time.sleep(0.8); print("  after Settings:", state()); shot("v06-click-settings")
