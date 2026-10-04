// Opens the page-icon picker (B-647) inside Mobile Safari on the iOS Simulator, where there is no
// tap automation: injected into a COPY of the production build's index.html by run.sh. The URL hash
// says what to do: `#picker` opens it browsing, `#picker=rocket` also types a search.
(() => {
  const m = /#picker(?:=(.*))?$/.exec(location.hash);
  if (!m) return;
  const query = m[1] ? decodeURIComponent(m[1]) : "";
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function find(sel, timeout = 30000) {
    const end = Date.now() + timeout;
    for (;;) {
      const el = document.querySelector(sel);
      if (el) return el;
      if (Date.now() > end) throw new Error(`timed out: ${sel}`);
      await wait(200);
    }
  }
  (async () => {
    (await find(".page-icon-button")).click();
    const search = await find(".emoji-picker-search");
    if (query) {
      search.value = query;
      search.dispatchEvent(new Event("input", { bubbles: true }));
    }
    // Drop focus so the screenshot is not half keyboard (the keyboard is the OS's, not ours).
    search.blur();
  })().catch((e) => console.error("[icon-picker-sim]", e));
})();
