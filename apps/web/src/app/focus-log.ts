/**
 * The focus log: an opt-in recorder of where keyboard focus goes, for a bug that only happens on
 * someone else's machine.
 *
 * Why it exists (B-42): in the desktop app (Tauri, i.e. the system WKWebView) the editor loses
 * focus while the `[[` popup is open, around a sync refresh. Nine Chromium repro attempts, then
 * Playwright's WebKit on the e2e graph AND on a copy of the owner's real graph, with every refresh
 * kind, a resting pointer, late frames and slow typing (`tools/probes/webkit-refresh-focus*`),
 * never lost focus once. What differs is the runtime itself — the real WKWebView, its text input
 * client, a real window — and none of that can be reached from a test here. So the app records
 * what happens and the person it happens to copies the record out of Diagnostics.
 *
 * Off by default, and nothing is patched or listened to while off. Switched on (Diagnostics →
 * "Focus log", or `nookletFocusLog.enable()` in a console), it records, with a timestamp:
 *
 *  - `focusin` / `focusout` with target and `relatedTarget`; window `blur` / `focus`;
 *    `visibilitychange`
 *  - every call to `HTMLElement#focus()` / `#blur()`, with the JS stack that made it
 *  - every DOM insertion, removal or replacement of a node that CONTAINS the focused element, with
 *    the JS stack — a moved or removed node loses focus, and WebKit fires no `focusout` when that
 *    happens, so without this a loss there would be silent
 *  - a 50 ms poll of `document.activeElement`, whether the editor exists and holds focus, which
 *    block it is in, whether a popup is open and `document.hasFocus()`, logged on change; a change
 *    from "editor focused" to anything else is marked `LOST`
 *  - `keydown` as a CATEGORY (a named key such as Enter, or `char`), `beforeinput`'s `inputType`,
 *    composition start/end, `pointerdown` targets
 *  - notes from the app itself (`noteFocus`): replica change events, sync status, the editor
 *    attaching and detaching
 *
 * Never recorded: text. Elements are described by tag, class and block id, keys by category,
 * input by type — the log is meant to be pasted into a bug report.
 *
 * Kept across a reload: entries are written to localStorage on `pagehide` and read back (marked
 * as the previous page load) when the log starts, in case what looks like a refresh is a reload.
 */

import { createSignal } from "solid-js";

const FLAG_KEY = "nooklet.debug.focusLog";
const PREVIOUS_KEY = "nooklet.debug.focusLog.previous";
/** Enough for a few minutes of typing with refreshes; the oldest entries go first. */
const MAX_ENTRIES = 3000;
const POLL_MS = 50;

export interface FocusLogEntry {
  /** ms since this page load (`performance.now()`), rounded. */
  t: number;
  kind: string;
  detail: string;
  stack?: string;
}

let entries: FocusLogEntry[] = [];
let previousLoad: string | null = null;
let uninstall: (() => void) | null = null;

// Signals, not plain variables: the Diagnostics panel renders both, and module-level state a
// component reads has to be reactive or the panel shows whatever it was when it opened.
const [enabled, setEnabled] = createSignal(false);
const [count, setCount] = createSignal(0);
let countQueued = false;
// The same state as `enabled`, for the hooks: `noteFocus` is called from inside effects and ref
// callbacks, and reading a signal there would subscribe that computation to the log's switch.
let recording = false;

export const focusLogEnabled = enabled;
export const focusLogCount = count;

function readFlag(): boolean {
  try {
    return localStorage.getItem(FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

function writeFlag(on: boolean): void {
  try {
    if (on) localStorage.setItem(FLAG_KEY, "1");
    else localStorage.removeItem(FLAG_KEY);
  } catch {
    // Storage blocked: the log still runs for this page load, it just will not survive a reload.
  }
}

/** Tag, up to two classes, and the block id if the element is in a block row. No text content. */
export function describeElement(target: unknown): string {
  if (target === null || target === undefined) return String(target);
  if (typeof window !== "undefined" && target === window) return "window";
  if (typeof document !== "undefined" && target === document) return "document";
  const el = target as Partial<Element>;
  if (typeof el.tagName !== "string") return String((target as Partial<Node>).nodeName ?? "?");
  const classes =
    typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean) : [];
  let out = el.tagName.toLowerCase();
  if (classes.length > 0) out += `.${classes.slice(0, 2).join(".")}`;
  const row = typeof el.closest === "function" ? el.closest("[data-block-id]") : null;
  const blockId = row?.getAttribute("data-block-id");
  if (blockId) out += ` @${blockId}`;
  return out;
}

/** Named keys as themselves; anything that types a character as `char`, so no text leaks. */
export function keyCategory(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing">,
): string {
  const named = e.key.length > 1 ? e.key : "char";
  const mods = [e.metaKey && "Meta", e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift"]
    .filter(Boolean)
    .join("+");
  return `${mods ? `${mods}+` : ""}${named}${e.isComposing ? " (composing)" : ""}`;
}

function shortStack(): string {
  const lines = (new Error().stack ?? "").split("\n").map((l) => l.trim());
  // V8 starts with an "Error" line, JavaScriptCore does not. The next three frames are always this
  // module's own: `shortStack`, `push`, and the hook that called it (a listener, a patched method,
  // `noteFocus`). A production build inlines the module, so they cannot be filtered by file name.
  const frames = (lines[0]?.startsWith("Error") ? lines.slice(1) : lines).slice(3);
  return frames
    .filter((f) => f !== "")
    .slice(0, 8)
    .map((f) => f.replace(/https?:\/\/[^/\s]+\//g, "/"))
    .join(" | ");
}

function push(kind: string, detail: string, withStack: boolean): void {
  entries.push({
    t: Math.round(performance.now()),
    kind,
    detail,
    ...(withStack ? { stack: shortStack() } : {}),
  });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  if (!countQueued) {
    // One signal write per task at most: this runs inside DOM operations Solid is in the middle
    // of, and on every focus event.
    countQueued = true;
    queueMicrotask(() => {
      countQueued = false;
      setCount(entries.length);
    });
  }
}

/** A note from the app (a replica change, the editor detaching). A no-op while the log is off. */
export function noteFocus(kind: string, detail = "", opts: { stack?: boolean } = {}): void {
  if (!recording) return;
  push(kind, detail, opts.stack === true);
}

function formatEntry(e: FocusLogEntry): string {
  const head = `${String(e.t).padStart(8)}ms ${e.kind}${e.detail ? ` ${e.detail}` : ""}`;
  return e.stack ? `${head}\n            at ${e.stack}` : head;
}

/** The whole log as text, oldest first, with a header naming the runtime. */
export function focusLogText(): string {
  const header = [
    "nooklet focus log",
    `recorded ${new Date().toISOString()}`,
    typeof navigator === "undefined" ? "" : `userAgent ${navigator.userAgent}`,
    // The route kind only (`page`, `journals`): the rest of the path is a page name.
    typeof location === "undefined" ? "" : `view ${location.pathname.split("/")[1] || "journals"}`,
    `entries ${entries.length} (max ${MAX_ENTRIES})`,
  ].filter(Boolean);
  const parts = [header.join("\n")];
  if (previousLoad) parts.push(`--- previous page load ---\n${previousLoad}`);
  parts.push(`--- this page load ---\n${entries.map(formatEntry).join("\n")}`);
  return parts.join("\n\n");
}

export function clearFocusLog(): void {
  entries = [];
  previousLoad = null;
  try {
    localStorage.removeItem(PREVIOUS_KEY);
  } catch {
    // ignore
  }
  setCount(0);
}

function install(): () => void {
  const undo: Array<() => void> = [];
  const listen = (
    target: EventTarget,
    type: string,
    fn: (e: Event) => void,
    capture = true,
  ): void => {
    target.addEventListener(type, fn, capture);
    undo.push(() => target.removeEventListener(type, fn, capture));
  };

  for (const type of ["focusin", "focusout"]) {
    listen(document, type, (e) => {
      const fe = e as FocusEvent;
      push(
        type,
        `${describeElement(fe.target)} → related ${describeElement(fe.relatedTarget)}`,
        true,
      );
    });
  }
  listen(window, "blur", (e) => e.target === window && push("window.blur", "", false), false);
  listen(window, "focus", (e) => e.target === window && push("window.focus", "", false), false);
  listen(document, "visibilitychange", () => push("visibility", document.visibilityState, false));
  listen(document, "pointerdown", (e) => push("pointerdown", describeElement(e.target), false));
  listen(document, "keydown", (e) => {
    const ke = e as KeyboardEvent;
    push("keydown", `${keyCategory(ke)} on ${describeElement(ke.target)}`, false);
  });
  listen(document, "beforeinput", (e) => {
    const ie = e as InputEvent;
    push("beforeinput", `${ie.inputType}${ie.isComposing ? " (composing)" : ""}`, false);
  });
  listen(document, "compositionstart", (e) =>
    push("composition", `start on ${describeElement(e.target)}`, false),
  );
  listen(document, "compositionend", () => push("composition", "end", false));
  listen(
    window,
    "pagehide",
    () => {
      try {
        localStorage.setItem(PREVIOUS_KEY, entries.slice(-1500).map(formatEntry).join("\n"));
      } catch {
        // Quota: the previous load's log is a convenience.
      }
    },
    false,
  );

  // Calls that move focus, with who made them.
  const proto = HTMLElement.prototype;
  const origFocus = proto.focus;
  const origBlur = proto.blur;
  proto.focus = function (this: HTMLElement, options?: FocusOptions) {
    push("call focus()", describeElement(this), true);
    return origFocus.call(this, options);
  };
  proto.blur = function (this: HTMLElement) {
    push("call blur()", describeElement(this), true);
    return origBlur.call(this);
  };
  undo.push(() => {
    proto.focus = origFocus;
    proto.blur = origBlur;
  });

  // DOM operations on the subtree holding focus. Checked only while focus is somewhere other than
  // <body>, so the cost while nothing is focused is one property read per operation.
  const holdsFocus = (node: unknown): boolean => {
    const active = document.activeElement;
    return (
      node instanceof Node &&
      active !== null &&
      active !== document.body &&
      (node === active || node.contains(active))
    );
  };
  type Method = (...args: unknown[]) => unknown;
  const wrap = (
    owner: object,
    name: string,
    focusedArgs: (self: unknown, args: unknown[]) => unknown[],
  ): void => {
    const table = owner as Record<string, Method>;
    const orig = table[name];
    if (typeof orig !== "function") return;
    table[name] = function (this: unknown, ...args: unknown[]) {
      const hit = focusedArgs(this, args).find(holdsFocus);
      if (hit !== undefined) {
        push(`dom ${name}`, `${describeElement(hit)} (parent ${describeElement(this)})`, true);
      }
      return orig.apply(this, args);
    };
    undo.push(() => {
      table[name] = orig;
    });
  };
  wrap(Node.prototype, "insertBefore", (_s, a) => [a[0]]);
  wrap(Node.prototype, "appendChild", (_s, a) => [a[0]]);
  wrap(Node.prototype, "removeChild", (_s, a) => [a[0]]);
  wrap(Node.prototype, "replaceChild", (_s, a) => [a[0], a[1]]);
  wrap(Element.prototype, "remove", (s) => [s]);
  wrap(Element.prototype, "replaceWith", (s, a) => [s, ...a]);
  wrap(Element.prototype, "before", (_s, a) => a);
  wrap(Element.prototype, "after", (_s, a) => a);
  wrap(Element.prototype, "append", (_s, a) => a);
  wrap(Element.prototype, "prepend", (_s, a) => a);
  wrap(Element.prototype, "replaceChildren", (s) => [...(s as Element).childNodes]);
  // Solid clears a list's children with `textContent = ""`.
  const textContent = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
  if (textContent?.set && textContent.get) {
    const { get, set } = textContent;
    Object.defineProperty(Node.prototype, "textContent", {
      configurable: true,
      enumerable: textContent.enumerable ?? false,
      get,
      set(this: Node, value: string | null) {
        if (holdsFocus(this)) push("dom textContent=", describeElement(this), true);
        set.call(this, value);
      },
    });
    undo.push(() => Object.defineProperty(Node.prototype, "textContent", textContent));
  }

  // The state a person sees, sampled.
  let last = { active: "", editor: "", popup: "", docFocus: "" };
  let editorWasFocused = false;
  const poll = (): void => {
    const active = document.activeElement;
    const content = document.querySelector(".cm-content");
    const editorFocused = content !== null && active === content;
    const now = {
      active: describeElement(active),
      editor: content
        ? `editor in block ${content.closest("[data-block-id]")?.getAttribute("data-block-id") ?? "?"}`
        : "no editor",
      popup: document.querySelector(".cmd-popup") ? "popup open" : "popup closed",
      docFocus: document.hasFocus() ? "document has focus" : "document does NOT have focus",
    };
    if (editorWasFocused && !editorFocused) {
      push("LOST", `editor focus → ${now.active}; ${now.editor}; ${now.popup}`, false);
    }
    editorWasFocused = editorFocused;
    if (now.active !== last.active) push("activeElement", now.active, false);
    if (now.editor !== last.editor) push("editor", now.editor, false);
    if (now.popup !== last.popup) push("popup", now.popup, false);
    if (now.docFocus !== last.docFocus) push("document", now.docFocus, false);
    last = now;
  };
  const timer = setInterval(poll, POLL_MS);
  undo.push(() => clearInterval(timer));
  poll();

  return () => {
    for (const fn of undo.reverse()) fn();
  };
}

/** Switch recording on or off, and remember the choice across reloads. */
export function setFocusLogEnabled(on: boolean): void {
  writeFlag(on);
  if (on === recording) return;
  if (on) {
    if (typeof document === "undefined") return;
    try {
      previousLoad = localStorage.getItem(PREVIOUS_KEY);
    } catch {
      previousLoad = null;
    }
    recording = true;
    setEnabled(true);
    push("log", "recording started", false);
    uninstall = install();
  } else {
    push("log", "recording stopped", false);
    uninstall?.();
    uninstall = null;
    recording = false;
    setEnabled(false);
  }
}

/**
 * Called once at startup, before anything renders: starts the log if it was left on, and puts
 * `nookletFocusLog` on `window` for anyone with a console (a debug build of the desktop app, the
 * web app in a browser).
 */
export function initFocusLog(): void {
  if (typeof window === "undefined") return;
  (window as unknown as { nookletFocusLog: unknown }).nookletFocusLog = {
    enable: () => setFocusLogEnabled(true),
    disable: () => setFocusLogEnabled(false),
    text: focusLogText,
    print: () => console.log(focusLogText()),
    clear: clearFocusLog,
  };
  if (readFlag()) setFocusLogEnabled(true);
}
