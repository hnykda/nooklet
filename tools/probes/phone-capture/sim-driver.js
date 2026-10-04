// Reports what the REAL app shows inside the iOS Simulator's WKWebView (there is no tap automation
// here), and performs the one tap the run needs ("Just this device"). Injected into the built
// public/index.html by sim-run.sh. Talks to sim-host.mjs on the Mac: GET /cmd says whether to set
// up a graph on this load; POST /dump records a DOM summary after each load and each return to
// the foreground. Fixture data only: a fresh local-only graph on a throwaway Simulator install.
(() => {
  const host = window.PC_SIM?.host;
  if (!host) return;
  // Warnings and errors the app logs (e.g. "[capture-queue] …"), reported with each dump.
  const logged = [];
  for (const level of ["warn", "error"]) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      logged.push(
        `${level}: ${args.map((a) => (a instanceof Error ? a.message : typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")}`,
      );
      orig(...args);
    };
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const byText = (sel, text) =>
    [...document.querySelectorAll(sel)].find((e) => e.textContent?.includes(text));
  async function find(fn, timeout = 20000) {
    const end = Date.now() + timeout;
    for (;;) {
      const el = fn();
      if (el) return el;
      if (Date.now() > end) return undefined;
      await wait(200);
    }
  }
  async function dump(label) {
    const rows = [
      ...document.querySelectorAll(".journal-day-today .vr-row:not(.vr-row-draft)"),
    ].map((e) => e.textContent.trim());
    const ta = document.querySelector(".capture-input");
    const body = {
      label,
      at: new Date().toISOString(),
      path: location.pathname + location.search,
      today: rows,
      capture: ta ? ta.value : null,
      noGraphNotice: Boolean(document.querySelector(".capture-no-graph")),
      connectScreen: Boolean(document.querySelector(".connect-choice")),
      title: document.querySelector("h1")?.textContent ?? null,
      capturePlugin: Boolean(window.Capacitor?.isPluginAvailable?.("NookletCapture")),
      // Container paths name the Mac's user: redacted, these dumps get committed.
      logged: logged.slice(-10).map((l) => l.replace(/file:\/\/\/[^'"\s]*/g, "<file>")),
    };
    try {
      body.queue = (await window.Capacitor?.Plugins?.NookletCapture?.list())?.ids ?? null;
    } catch (e) {
      body.queue = `list failed: ${e?.message ?? e}`;
    }
    return fetch(`${host}/dump`, { method: "POST", body: JSON.stringify(body) }).catch(() => {});
  }
  (async () => {
    const cmd = await fetch(`${host}/cmd`)
      .then((r) => r.text())
      .catch(() => "none");
    if (cmd === "setup") {
      const setUp = await find(() => byText("button", "Set up a graph"), 8000);
      if (setUp) setUp.click();
      const local = await find(() => byText("button", "Just this device"));
      if (local) {
        await dump("before-setup");
        local.click();
      }
    }
    await wait(7000);
    await dump("load");
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") setTimeout(() => void dump("resume"), 6000);
    });
  })();
})();
