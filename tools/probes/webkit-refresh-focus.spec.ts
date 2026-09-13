/**
 * Probe (2026-09-13, m11/webkit-focus, B-42): with the `[[` autocomplete open in a journal block,
 * does a sync-driven refresh take focus away from the editor — in WebKit, in Chromium?
 *
 * Owner's report: in the desktop app (WKWebView) typing `[[dru` and pausing, "it refreshes
 * ('syncs') and the focus is lost"; not in the web app (Chromium).
 *
 * Records, from page load: every `focusin`/`focusout` (target, relatedTarget, JS stack), window
 * blur, every call to `HTMLElement.prototype.focus`/`blur` (stack), every DOM insertion or removal
 * of a node that CONTAINS the focused element at the time (stack — Solid's reconcile goes through
 * `insertBefore`/`replaceChild`/`remove`), `.cmd-popup` appearing/disappearing, which row holds the
 * editor, and the sync indicator's text — each stamped with ms since page load. Samples
 * `document.activeElement` every 20 ms and logs each change. Writes, per scenario and browser, a
 * JSON trace, a JSON report and a text timeline to $PROBE_TRACE_DIR (default: the test output dir).
 *
 * Scenarios: (own-cycle) nothing but the client's own cycle after typing — the 500 ms text flush,
 * the 300 ms push debounce, the push, the pull of our own ops, the push-queue drain (syncVersion
 * bump); (api-same-page) an API write to ANOTHER block on the same journal page, after the own
 * cycle has settled; (api-other-page) an API write to a different page.
 *
 * Not part of the suite (it prints; it does not assert). To re-run, copy it into `e2e/tests/`, add
 * it to the webkit project's testMatch, and:
 *   cd e2e && NOOKLET_E2E_PORT=<port> PROBE_TRACE_DIR=<dir> pnpm exec playwright test \
 *     tests/webkit-refresh-focus.spec.ts --project=chromium --project=webkit
 * then delete the copy.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { api, isoOffset, readBlocks } from "../helpers/index.js";

type Entry = { t: number; kind: string; detail?: string; stack?: string };

async function installTrace(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Entry = { t: number; kind: string; detail?: string; stack?: string };
    const w = window as unknown as {
      __trace: Entry[];
      __mark: (label: string) => void;
    };
    w.__trace = [];
    const at = () => Math.round(performance.now());
    const describe = (el: unknown): string => {
      if (el === null || el === undefined) return String(el);
      if (el === window) return "window";
      if (el === document) return "document";
      const e = el as Element;
      if (!("tagName" in e)) return String((e as Node).nodeName ?? el);
      const cls =
        typeof e.className === "string" ? e.className.split(" ").slice(0, 2).join(".") : "";
      return `${e.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`;
    };
    const stack = () => (new Error().stack ?? "").split("\n").slice(2, 14).join(" | ");
    const push = (kind: string, detail?: string, withStack = false) =>
      w.__trace.push({ t: at(), kind, detail, stack: withStack ? stack() : undefined });
    w.__mark = (label) => push("MARK", label);

    for (const type of ["focusin", "focusout"] as const) {
      document.addEventListener(
        type,
        (e) => push(type, `${describe(e.target)} related=${describe(e.relatedTarget)}`, true),
        true,
      );
    }
    window.addEventListener("blur", (e) => {
      if (e.target === window) push("window-blur", "", true);
    });
    window.addEventListener("focus", (e) => {
      if (e.target === window) push("window-focus", "");
    });

    const origFocus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (this: HTMLElement, opts?: FocusOptions) {
      push("call.focus()", describe(this), true);
      return origFocus.call(this, opts);
    };
    const origBlur = HTMLElement.prototype.blur;
    HTMLElement.prototype.blur = function (this: HTMLElement) {
      push("call.blur()", describe(this), true);
      return origBlur.call(this);
    };

    // A DOM operation on a node that holds focus right now: the kind of thing that blurs in one
    // engine and not the other.
    const holdsFocus = (node: unknown): boolean => {
      const a = document.activeElement;
      return node instanceof Node && !!a && a !== document.body && (node === a || node.contains(a));
    };
    const wrapNode = (
      name: "insertBefore" | "appendChild" | "removeChild" | "replaceChild",
      pick: (args: unknown[]) => unknown[],
    ) => {
      const proto = Node.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
      const orig = proto[name] as (...a: unknown[]) => unknown;
      proto[name] = function (this: Node, ...args: unknown[]) {
        const hit = pick(args).find((n) => holdsFocus(n));
        if (hit) push(`dom.${name}`, `${describe(hit)} parent=${describe(this)}`, true);
        return orig.apply(this, args);
      };
    };
    wrapNode("insertBefore", (a) => [a[0]]);
    wrapNode("appendChild", (a) => [a[0]]);
    wrapNode("removeChild", (a) => [a[0]]);
    wrapNode("replaceChild", (a) => [a[0], a[1]]);
    for (const name of ["remove", "replaceWith", "before", "after", "append", "prepend"] as const) {
      const proto = Element.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
      const orig = proto[name] as (...a: unknown[]) => unknown;
      proto[name] = function (this: Element, ...args: unknown[]) {
        if ((name === "remove" || name === "replaceWith") && holdsFocus(this))
          push(`dom.${name}`, describe(this), true);
        for (const a of args) if (holdsFocus(a)) push(`dom.${name}(arg)`, describe(a), true);
        return orig.apply(this, args);
      };
    }

    let lastActive = "";
    let lastSync = "";
    let lastPopup = "";
    let lastEditorRow = "";
    setInterval(() => {
      const a = describe(document.activeElement);
      if (a !== lastActive) {
        push("activeElement", a);
        lastActive = a;
      }
      const s = document.querySelector(".app-sync-indicator")?.textContent ?? "";
      if (s !== lastSync) {
        push("sync-indicator", s);
        lastSync = s;
      }
      const popup = document.querySelector(".cmd-popup");
      const p = popup ? `open rows=${popup.querySelectorAll("[role=option]").length}` : "closed";
      if (p !== lastPopup) {
        push("popup", p);
        lastPopup = p;
      }
      const row = document.querySelector(".cm-editor")?.closest(".vr-row");
      const r = row ? (row.textContent ?? "").slice(0, 40) : "none";
      if (r !== lastEditorRow) {
        push("editor-row", r);
        lastEditorRow = r;
      }
    }, 20);
  });
}

async function mark(page: Page, label: string): Promise<void> {
  await page.evaluate(
    (l) => (window as unknown as { __mark: (l: string) => void }).__mark(l),
    label,
  );
}

async function focusedInEditor(page: Page): Promise<boolean> {
  return page.evaluate(() => !!document.activeElement?.closest(".cm-content"));
}

const SCENARIOS = [
  "own-cycle",
  "api-same-page",
  "api-other-page",
  "new-block-own-cycle",
  "new-block-api-same-page",
] as const;

for (const scenario of SCENARIOS) {
  test(`probe: [[ popup open, refresh kind ${scenario}`, async ({ page, browserName }, info) => {
    test.setTimeout(60_000);
    const today = isoOffset(0);
    const tag = `${scenario}-${browserName}-${Date.now()}`;
    await api(page, "page.append", {
      page: today,
      markdown: `- probe base ${tag}\n- sibling ${tag}`,
    });
    await api(page, "page.create", { name: "Probe Other Page", if_exists: "return" });
    await installTrace(page);
    await page.goto("/journals");
    const row = page.locator(".vr-block-view", { hasText: `probe base ${tag}` });
    await expect(row).toBeVisible();
    // Let the first sync and its refetches settle, so what follows is the refresh under test.
    await page.waitForTimeout(1500);
    await row.click();
    await expect(page.locator(".cm-content")).toBeFocused();
    await page.keyboard.press("End");
    // The owner types new lines into a journal: a block made by Enter moments earlier takes a
    // different path through the tree effect (`unseenCreations`) until a refetch returns it.
    if (scenario.startsWith("new-block")) await page.keyboard.press("Enter");
    await mark(page, "typing starts");

    const perKey: Array<{ key: string; focused: boolean }> = [];
    for (const ch of scenario.startsWith("new-block") ? "testing [[dru" : " testing [[dru") {
      await page.keyboard.type(ch);
      perKey.push({ key: ch, focused: await focusedInEditor(page) });
      await page.waitForTimeout(60);
    }
    await mark(page, "typing done");
    const popupOpened = await page
      .locator(".cmd-popup")
      .waitFor({ timeout: 2000 })
      .then(
        () => true,
        () => false,
      );

    const samples: Array<{ at: number; focused: boolean; popup: boolean }> = [];
    const sample = async (at: number) =>
      samples.push({
        at,
        focused: await focusedInEditor(page),
        popup: (await page.locator(".cmd-popup").count()) > 0,
      });

    if (scenario.endsWith("own-cycle")) {
      for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(100);
        await sample((i + 1) * 100);
      }
    } else {
      // Past our own cycle first, so the write under test is the only thing that refreshes.
      await page.waitForTimeout(2500);
      await sample(0);
      await mark(page, `api write (${scenario})`);
      if (scenario.endsWith("api-same-page")) {
        const blocks = await readBlocks(page, today);
        const sibling = blocks.find((b) => b.content === `sibling ${tag}`);
        await api(page, "block.update", { id: sibling?.id, content: `sibling ${tag} edited` });
      } else {
        await api(page, "page.append", { page: "Probe Other Page", markdown: `- line ${tag}` });
      }
      for (let i = 0; i < 25; i++) {
        await page.waitForTimeout(100);
        await sample((i + 1) * 100);
      }
    }
    await mark(page, "typing again");
    await page.keyboard.type("x");
    await page.waitForTimeout(300);
    const text = await page
      .locator(".cm-content")
      .textContent({ timeout: 1000 })
      .catch(() => null);
    await mark(page, "end");

    const dir = process.env.PROBE_TRACE_DIR ?? info.outputDir;
    const trace = await page.evaluate(() => (window as unknown as { __trace: Entry[] }).__trace);
    writeFileSync(
      join(dir, `trace-${scenario}-${browserName}.json`),
      JSON.stringify(trace, null, 1),
    );
    const report = {
      browserName,
      scenario,
      popupOpened,
      perKey,
      samples,
      editorTextAfterX: text,
      lostAt: samples.filter((s) => !s.focused).map((s) => s.at),
    };
    writeFileSync(
      join(dir, `report-${scenario}-${browserName}.json`),
      JSON.stringify(report, null, 1),
    );
    writeFileSync(
      join(dir, `timeline-${scenario}-${browserName}.txt`),
      trace
        .map(
          (e) =>
            `${String(e.t).padStart(6)} ${e.kind} ${e.detail ?? ""}${e.stack ? `\n         @ ${e.stack}` : ""}`,
        )
        .join("\n"),
    );
    console.log(
      `=== ${browserName} ${scenario}: popup=${popupOpened} lostAt=${JSON.stringify(report.lostAt)} unfocusedAfterKeys=${JSON.stringify(perKey.filter((k) => !k.focused).map((k) => k.key))} text=${JSON.stringify(text)}`,
    );
  });
}
