// B-646 probe: an on-screen log of the key/input events a real iOS soft keyboard delivers, so a
// Simulator screenshot shows them (there is no console to read from a headless WKWebView).
// Injected into the built apps/web/ios/App/App/public/index.html by run.sh; `pnpm ios:sync` puts
// the plain app back. Also reports what the slash trigger saw (`.cmd-popup` present or not) and
// the document's layout width (B-648).
(() => {
  const lines = [];
  const box = document.createElement("pre");
  box.id = "probe-overlay";
  box.style.cssText =
    "position:fixed;left:0;right:0;top:0;z-index:99999;margin:0;padding:4px;font:9px/1.25 monospace;" +
    "background:rgba(255,255,200,.75);color:#000;pointer-events:none;white-space:pre-wrap;max-height:50%;overflow:hidden";
  const t0 = performance.now();
  const cm = () => document.querySelector(".cm-content")?.textContent ?? "-";
  const draft = () => document.querySelector(".vr-draft-input")?.value ?? "-";
  function push(s) {
    if (s) lines.push(`${Math.round(performance.now() - t0)} ${s}`);
    while (lines.length > (window.PROBE_LINES ?? 40)) lines.shift();
    box.textContent =
      `popup=${!!document.querySelector(".cmd-popup")} docW=${document.documentElement.scrollWidth} ` +
      `innerW=${window.innerWidth} vv=${window.visualViewport?.width.toFixed(0)}@${window.visualViewport?.scale.toFixed(2)}\n` +
      lines.join("\n");
    if (!box.isConnected && document.body) document.body.appendChild(box);
  }
  window.__probePush = push;
  const tgt = (e) => (e.target?.className?.toString?.() ?? "").slice(0, 18);
  window.addEventListener(
    "keydown",
    (e) =>
      push(
        `keydown key=${JSON.stringify(e.key)} code=${e.keyCode} comp=${e.isComposing} ${tgt(e)}`,
      ),
    true,
  );
  window.addEventListener(
    "keyup",
    (e) => push(`keyup key=${JSON.stringify(e.key)} cm=${JSON.stringify(cm())}`),
    true,
  );
  window.addEventListener(
    "beforeinput",
    (e) => push(`beforeinput ${e.inputType} data=${JSON.stringify(e.data)} comp=${e.isComposing}`),
    true,
  );
  window.addEventListener(
    "input",
    (e) => {
      push(`input ${e.inputType} cm=${JSON.stringify(cm())} draft=${JSON.stringify(draft())}`);
      setTimeout(
        () =>
          push(`  +0ms popup=${!!document.querySelector(".cmd-popup")} cm=${JSON.stringify(cm())}`),
        0,
      );
    },
    true,
  );
  window.addEventListener("focusin", (e) => push(`focusin ${tgt(e)}`), true);
  setInterval(() => push(""), 1000);
})();
