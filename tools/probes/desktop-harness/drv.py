"""Helpers for driving a harness-wired devtest app (probe.rs). Import from the scripts beside this file.

Env: HARNESS_DIR — scratch dir holding `probe/` (NOOKLET_PROBE_DIR of the running app), `pids/app`, and the
compiled tools `desktop-window` (../desktop-window.swift), `idle` (idle.swift), `pb` (pb.swift).
SHOTS — where screenshots go. Nothing here touches any app but the one whose pid is in pids/app.
"""
import json, os, subprocess, time

V = os.environ.get("HARNESS_DIR", "/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m11c/verify")
SHOTS = os.environ.get("SHOTS", V + "/../shots/verify")
TOP = 32  # the web view starts 32 pt below the window's top edge (`geom`: contentLayoutRect y=32)


def sh(*a):
    return subprocess.run(a, capture_output=True, text=True).stdout.strip()


def pc(cmd, timeout=10.0):
    """One harness command; returns its result text."""
    name = f"{time.time_ns()}"
    tmp, path, out = f"{V}/probe/{name}.tmpcmd", f"{V}/probe/{name}.cmd", f"{V}/probe/{name}.out"
    with open(tmp, "w") as f:
        f.write(cmd)
    os.rename(tmp, path)
    end = time.time() + timeout
    while time.time() < end:
        if os.path.exists(out):
            return open(out).read()
        time.sleep(0.05)
    return f"TIMEOUT: {cmd}"


def ev(js):
    """Evaluate a function BODY in the page; returns its (JSON-able) return value."""
    out = pc("eval JSON.stringify((() => { " + js + " })())")
    try:
        v = json.loads(out)
        return json.loads(v) if isinstance(v, str) else v
    except Exception:
        return out


def idle():
    return int(sh(V + "/idle"))


def app_pid():
    return open(V + "/pids/app").read().strip()


def shot(name):
    return sh(V + "/desktop-window", "shot", app_pid(), f"{SHOTS}/{name}.png")


class OwnerActive(Exception):
    pass


def guard():
    """Stop if the person at the Mac is using it: synthesized in-app events do not reset the HID idle
    timer, so a low idle time means THEIR keys or pointer, which would land in the test window."""
    if idle() < 2:
        raise OwnerActive("someone is using the Mac")


def wait_idle(sec=15, limit=900):
    t = time.time()
    while idle() < sec:
        if time.time() - t > limit:
            raise OwnerActive("never idle")
        time.sleep(1)


def centre(selector_js):
    r = ev(f"const el = {selector_js}; if (!el) return null; const b = el.getBoundingClientRect(); return [b.x + b.width/2, b.y + b.height/2];")
    return (r[0], r[1] + TOP) if isinstance(r, list) else None


def click_el(selector_js, label):
    guard()
    c = centre(selector_js)
    if not c:
        print(f"  {label}: NOT FOUND")
        return False
    print(f"  click {label} at {c[0]:.0f},{c[1]:.0f}: {pc(f'click {c[0]:.0f} {c[1]:.0f}')}")
    return True


class Burst:
    """Activate the app only for a short burst, and ALWAYS hand the keyboard back to whoever had it."""

    def __enter__(self):
        wait_idle()
        self.front = sh(V + "/desktop-window", "frontmost", "0")
        print("  activate:", pc("activate"))
        time.sleep(0.4)
        return self

    def __exit__(self, *exc):
        for _ in range(6):
            if sh(V + "/desktop-window", "frontmost", "0") == self.front:
                break
            sh(V + "/desktop-window", "give-back", self.front)
            time.sleep(0.4)
        print("  focus back to", self.front, "frontmost now", sh(V + "/desktop-window", "frontmost", "0"))
        return False
