// Drives the REAL app inside the iOS Simulator's WKWebView through its own DOM, one step per launch
// (there is no headless tap automation here). Injected into the built public/index.html by
// sim-run.sh, ahead of the app's module script. Config comes from `window.LG_SIM` (set by sim-run.sh).
// The step counter lives in localStorage, so a relaunch (simctl terminate + launch) or the app's
// own reload moves to the next step. Each step leaves the screen in the state sim-run.sh
// screenshots.
//
//   step 0 (launch 1): "Just this device", type a note into today's draft, Enter.
//   step 1 (launch 2, a real relaunch): nothing at first (screenshot: the note, no set-up screen),
//           then Switch graph -> Add a graph -> Sync with a server -> address + token -> Connect.
//   step 2 (after the app's reload onto the server graph): the server graph (screenshot), then the
//           switcher open (screenshot: both graphs listed), then "This device".
//   step 3 (after the reload back): nothing (screenshot: the local note again).
(() => {
  const cfg = window.LG_SIM;
  const KEY = "lgsim.step";
  const step = Number(localStorage.getItem(KEY) ?? "0");
  const log = (m) => console.log(`[lgsim step ${step}] ${m}`);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function find(fn, timeout = 30000) {
    const end = Date.now() + timeout;
    for (;;) {
      const el = fn();
      if (el) return el;
      if (Date.now() > end) throw new Error("timed out");
      await wait(200);
    }
  }
  const byText = (sel, text) =>
    [...document.querySelectorAll(sel)].find((e) => e.textContent?.includes(text));
  function type(el, value) {
    el.focus();
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  async function run() {
    if (step === 0) {
      (await find(() => byText("button", "Just this device"))).click();
      const draft = await find(() => document.querySelector(".journal-day-today .vr-draft-input"));
      type(draft, cfg.note);
      draft.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await wait(3000);
      localStorage.setItem(KEY, "1");
      log("done");
    } else if (step === 1) {
      await wait(cfg.pauseMs);
      (await find(() => document.querySelector('button[aria-label="Switch graph"]'))).click();
      (await find(() => byText(".graph-switcher-add", "Add a graph"))).click();
      (await find(() => byText("button", "Sync with a server"))).click();
      const fields = await find(() => {
        const f = document.querySelectorAll(".graph-switcher-field input");
        return f.length >= 2 ? f : undefined;
      });
      type(fields[0], cfg.graphUrl);
      type(fields[1], cfg.token);
      localStorage.setItem(KEY, "2");
      (await find(() => byText(".graph-switcher-popover button[type=submit]", "Connect"))).click();
      log("connect clicked");
    } else if (step === 2) {
      await wait(cfg.pauseMs);
      (await find(() => document.querySelector('button[aria-label="Switch graph"]'))).click();
      await wait(cfg.pauseMs);
      localStorage.setItem(KEY, "3");
      (await find(() => byText(".graph-switcher-name", "This device"))).click();
      log("switched back");
    }
  }
  window.addEventListener("load", () => {
    run().catch((e) => log(`failed: ${e}`));
  });
})();
