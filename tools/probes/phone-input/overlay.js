// Phone input probe overlay (B-662, B-664, B-661, B-684, B-705) for the real app on the Simulator:
// a headless WKWebView has no console to read, so the state is printed into the screenshots.
// Injected into the built apps/web/ios/App/App/public/index.html by run.sh; `pnpm ios:sync` puts
// the plain app back.
//
// Header: popup present / toolbar present + its scrollLeft / keyboard inset (--kb) / visualViewport
// width@scale / document scrollWidth / innerWidth / the focused element / the draft's value / the
// outline's row texts. Then an event log: key, input, pointer and click events.
(() => {
  const lines = [];
  const box = document.createElement("pre");
  box.id = "probe-overlay";
  box.style.cssText =
    "position:fixed;left:0;right:0;top:0;z-index:99999;margin:0;padding:4px;font:9px/1.25 monospace;" +
    "background:rgba(255,255,200,.6);color:#000;pointer-events:none;white-space:pre-wrap;max-height:34%;overflow:hidden";
  const t0 = performance.now();
  const cm = () => document.querySelector(".cm-content")?.textContent ?? "-";
  const pop = () => (document.querySelector(".cmd-popup") ? "P" : "-");
  const draft = () => {
    const d = document.querySelector(".vr-draft-input");
    return d ? JSON.stringify(d.value) : "-";
  };
  const rows = () =>
    JSON.stringify(
      [
        ...document.querySelectorAll(
          ".page-view .vr-outliner .vr-row, .journal-day .vr-outliner .vr-row",
        ),
      ]
        .slice(0, 6)
        .map(
          (r) =>
            (r.querySelector(".cm-content") ?? r.querySelector(".vr-block-view"))?.textContent ??
            "?",
        ),
    );
  const active = () => {
    const a = document.activeElement;
    if (!a || a === document.body) return "body";
    return `${a.tagName.toLowerCase()}.${String(a.className).split(" ")[0]}`;
  };
  const toolbar = () => {
    const tb = document.querySelector(".cmd-toolbar");
    return tb ? `tb@${Math.round(tb.scrollLeft)}` : "tb=-";
  };
  function push(s) {
    if (s) lines.push(`${Math.round(performance.now() - t0)} ${s}`);
    while (lines.length > (window.PROBE_LINES ?? 13)) lines.shift();
    const kb = getComputedStyle(document.documentElement).getPropertyValue("--kb").trim() || "0";
    box.textContent =
      `popup=${pop()} ${toolbar()} kb=${kb} vv=${window.visualViewport?.width.toFixed(0)}@${window.visualViewport?.scale.toFixed(2)} ` +
      `docW=${document.documentElement.scrollWidth} innerW=${window.innerWidth} act=${active()}\n` +
      `draft=${draft()} rows=${rows()}\n` +
      lines.join("\n");
    if (!box.isConnected && document.body) document.body.appendChild(box);
  }
  window.__probePush = push;
  // `prev=` is `defaultPrevented` once the app's own handlers (Solid delegates to `document`) ran.
  const later = (tag, e) => {
    setTimeout(
      () =>
        push(
          `  ${tag}+0ms prev=${e.defaultPrevented} ${pop()} draft=${draft()} cm=${JSON.stringify(cm())}`,
        ),
      0,
    );
  };
  const on = (type, fmt, after = true) =>
    window.addEventListener(
      type,
      (e) => {
        push(`${fmt(e)} @${tgt(e)} ${pop()} draft=${draft()} cm=${JSON.stringify(cm())}`);
        if (after) later(type, e);
      },
      true,
    );
  const tgt = (e) => {
    const t = e.target;
    return t instanceof Element
      ? `${t.tagName.toLowerCase()}.${String(t.className).split(" ")[0]}`
      : "?";
  };
  on(
    "keydown",
    (e) =>
      `keydown ${JSON.stringify(e.key)} ${e.keyCode} shift=${e.shiftKey} comp=${e.isComposing}`,
  );
  on(
    "beforeinput",
    (e) => `beforeinput ${e.inputType} ${JSON.stringify(e.data)} comp=${e.isComposing}`,
  );
  on("input", (e) => `input ${e.inputType}`);
  on("keyup", (e) => `keyup ${JSON.stringify(e.key)}`, false);
  on("compositionstart", () => "compstart", false);
  on("compositionend", (e) => `compend ${JSON.stringify(e.data)}`, false);
  on("pointerdown", (e) => `pointerdown ${e.pointerType} ${tgt(e)}`, false);
  on("mousedown", (e) => `mousedown ${tgt(e)}`, false);
  on("click", (e) => `click ${tgt(e)}`);
  on("focusout", (e) => `focusout ${tgt(e)}`, false);
  new MutationObserver(() => {
    const p = pop();
    if (p !== window.__lastPop) {
      window.__lastPop = p;
      push(`popup -> ${p}`);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  // B-705, maximum-scale: a field the CSS floor cannot reach (inline !important beats it). With
  // `maximum-scale=1` on the viewport, focusing it must leave the scale at 1.00 too.
  if (window.PROBE_SMALL_FIELD === true) {
    const add = () => {
      if (!document.body || document.getElementById("probe-small")) return;
      const f = document.createElement("input");
      f.id = "probe-small";
      f.setAttribute("aria-label", "probe small field");
      f.style.cssText =
        "position:fixed;right:4px;bottom:120px;width:90px;z-index:99998;font-size:12px !important;";
      document.body.appendChild(f);
    };
    setInterval(add, 1000);
  }
  setInterval(() => push(""), 400);
})();
