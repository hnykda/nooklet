// B-684 / B-682 / B-683 probe overlay for the real app on the Simulator (a headless WKWebView has
// no console to read). Injected into the built apps/web/ios/App/App/public/index.html by run.sh;
// `pnpm ios:sync` puts the plain app back.
//
// Header line: popup present? / document scrollWidth / innerWidth / visualViewport width@scale /
// the first .vr-image's rendered box and natural size. Then an event log: each key/input event
// with the block editor's text and whether the popup exists at that moment, and again a
// macrotask later (when `CommandLayer`'s deferred re-detection has run).
(() => {
  const lines = [];
  const box = document.createElement("pre");
  box.id = "probe-overlay";
  box.style.cssText =
    "position:fixed;left:0;right:0;top:0;z-index:99999;margin:0;padding:4px;font:9px/1.25 monospace;" +
    "background:rgba(255,255,200,.8);color:#000;pointer-events:none;white-space:pre-wrap;max-height:30%;overflow:hidden";
  const t0 = performance.now();
  const cm = () => document.querySelector(".cm-content")?.textContent ?? "-";
  const pop = () => (document.querySelector(".cmd-popup") ? "P" : "-");
  const img = () => {
    const el = document.querySelector("img.vr-image");
    if (!el) return "img=-";
    const r = el.getBoundingClientRect();
    return `img=${r.width.toFixed(0)}x${r.height.toFixed(0)} nat=${el.naturalWidth}x${el.naturalHeight} l=${r.left.toFixed(0)} r=${r.right.toFixed(0)}`;
  };
  function push(s) {
    if (s) lines.push(`${Math.round(performance.now() - t0)} ${s}`);
    while (lines.length > (window.PROBE_LINES ?? 24)) lines.shift();
    box.textContent =
      `popup=${pop()} docW=${document.documentElement.scrollWidth} innerW=${window.innerWidth} ` +
      `vv=${window.visualViewport?.width.toFixed(0)}@${window.visualViewport?.scale.toFixed(2)} ${img()}\n` +
      lines.join("\n");
    if (!box.isConnected && document.body) document.body.appendChild(box);
  }
  window.__probePush = push;
  const later = (tag) => {
    queueMicrotask(() => push(`  ${tag}+micro ${pop()} cm=${JSON.stringify(cm())}`));
    setTimeout(() => push(`  ${tag}+0ms ${pop()} cm=${JSON.stringify(cm())}`), 0);
    setTimeout(() => push(`  ${tag}+60ms ${pop()} cm=${JSON.stringify(cm())}`), 60);
  };
  const on = (type, fmt) =>
    window.addEventListener(
      type,
      (e) => {
        push(`${fmt(e)} ${pop()} cm=${JSON.stringify(cm())}`);
        later(type);
      },
      true,
    );
  on("keydown", (e) => `keydown ${JSON.stringify(e.key)} ${e.keyCode} comp=${e.isComposing}`);
  on("beforeinput", (e) => `beforeinput ${e.inputType} ${JSON.stringify(e.data)}`);
  on("input", (e) => `input ${e.inputType}`);
  on("keyup", (e) => `keyup ${JSON.stringify(e.key)}`);
  on("compositionstart", () => "compstart");
  on("compositionend", (e) => `compend ${JSON.stringify(e.data)}`);
  new MutationObserver(() => {
    const p = pop();
    if (p !== window.__lastPop) {
      window.__lastPop = p;
      push(`popup -> ${p}`);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(() => push(""), 500);
})();
