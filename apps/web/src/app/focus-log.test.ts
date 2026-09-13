// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  clearFocusLog,
  describeElement,
  focusLogEnabled,
  focusLogText,
  initFocusLog,
  keyCategory,
  noteFocus,
  setFocusLogEnabled,
} from "./focus-log.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  setFocusLogEnabled(false);
  clearFocusLog();
  document.body.innerHTML = "";
  localStorage.clear();
});

/** A block row holding an editor-like focusable, the shape `BlockRowView` renders. */
function editorRow(id = "blk1"): { row: HTMLDivElement; content: HTMLDivElement } {
  const row = document.createElement("div");
  row.className = "vr-row vr-row-editing extra";
  row.setAttribute("data-block-id", id);
  const content = document.createElement("div");
  content.className = "cm-content cm-lineWrapping";
  content.tabIndex = 0;
  content.textContent = "secret words typed by the owner";
  row.appendChild(content);
  document.body.appendChild(row);
  return { row, content };
}

/** The log's lines after its header, i.e. only what was recorded. */
function recorded(): string {
  return focusLogText().split("--- this page load ---\n")[1] ?? "";
}

describe("describeElement / keyCategory (never text)", () => {
  it("names tag, two classes and the block id, and nothing a person wrote", () => {
    const { content } = editorRow("abc");
    expect(describeElement(content)).toBe("div.cm-content.cm-lineWrapping @abc");
    expect(describeElement(null)).toBe("null");
    expect(describeElement(document)).toBe("document");
    expect(describeElement(content)).not.toContain("secret");
  });

  it("reports a character key as `char` and named keys by name, with modifiers", () => {
    const base = {
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      isComposing: false,
    };
    expect(keyCategory({ ...base, key: "d" })).toBe("char");
    expect(keyCategory({ ...base, key: "[", altKey: true })).toBe("Alt+char");
    expect(keyCategory({ ...base, key: "Enter", shiftKey: true })).toBe("Shift+Enter");
    expect(keyCategory({ ...base, key: "a", isComposing: true })).toBe("char (composing)");
    // A character outside the BMP is two UTF-16 units long, and used to be logged as itself.
    expect(keyCategory({ ...base, key: "😀" })).toBe("char");
    expect(keyCategory({ ...base, key: "e\u0301" })).toBe("char");
    expect(keyCategory({ ...base, key: "Dead", altKey: true })).toBe("Alt+Dead");
    expect(keyCategory({ ...base, key: "F5" })).toBe("F5");
  });
});

describe("the focus log (B-42)", () => {
  it("records nothing and patches nothing while off", () => {
    const original = HTMLElement.prototype.focus;
    noteFocus("replica change", "tables=block");
    editorRow().content.focus();
    expect(focusLogEnabled()).toBe(false);
    expect(HTMLElement.prototype.focus).toBe(original);
    expect(recorded()).toBe("");
  });

  it("records focus events, focus() calls and app notes while on, and keeps typed text out", () => {
    const { content } = editorRow();
    setFocusLogEnabled(true);
    content.focus();
    noteFocus("replica change", "tables=block pages(1)=p1");
    content.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true }));
    const text = recorded();
    expect(text).toContain("call focus() div.cm-content.cm-lineWrapping @blk1");
    expect(text).toContain("focusin div.cm-content.cm-lineWrapping @blk1 → related null");
    expect(text).toContain("replica change tables=block pages(1)=p1");
    expect(text).toContain("keydown char on div.cm-content");
    expect(focusLogText()).not.toContain("secret");
  });

  it("records the DOM operation that moves the focused node, with the stack that made it", () => {
    const { row, content } = editorRow();
    const other = document.createElement("div");
    document.body.appendChild(other);
    setFocusLogEnabled(true);
    content.focus();
    // What a keyed <For> does to a reordered row.
    document.body.insertBefore(row, other);
    const text = recorded();
    // The stack names the caller — this test — not the log's own hook.
    expect(text).toMatch(
      /dom insertBefore div\.vr-row\.vr-row-editing @blk1 \(parent body\)\n\s+at .*focus-log\.test/,
    );
  });

  it("marks the moment the editor stops holding focus as LOST", async () => {
    const { row, content } = editorRow();
    setFocusLogEnabled(true);
    content.focus();
    await sleep(80);
    row.remove();
    await sleep(80);
    const text = recorded();
    expect(text).toContain("dom remove div.vr-row.vr-row-editing @blk1 (parent body)");
    expect(text).toMatch(/LOST editor focus → body; no editor; popup closed/);
  });

  it("puts the prototypes back when switched off", () => {
    const focus = HTMLElement.prototype.focus;
    const insertBefore = Node.prototype.insertBefore;
    const textContent = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
    setFocusLogEnabled(true);
    expect(HTMLElement.prototype.focus).not.toBe(focus);
    setFocusLogEnabled(false);
    expect(HTMLElement.prototype.focus).toBe(focus);
    expect(Node.prototype.insertBefore).toBe(insertBefore);
    expect(Object.getOwnPropertyDescriptor(Node.prototype, "textContent")).toEqual(textContent);
  });

  it("stays on across a reload, and shows what the previous page load recorded", () => {
    setFocusLogEnabled(true);
    noteFocus("sync", "pushing pending=1");
    window.dispatchEvent(new Event("pagehide"));
    // A reload: the module state is gone, the flag and the saved entries are not.
    setFocusLogEnabled(false);
    localStorage.setItem("nooklet.debug.focusLog", "1");
    initFocusLog();
    expect(focusLogEnabled()).toBe(true);
    const text = focusLogText();
    expect(text).toMatch(/--- previous page load ---\n[\s\S]*sync pushing pending=1/);
    // The console handle reads the same log.
    expect(
      (window as unknown as { nookletFocusLog: { text: () => string } }).nookletFocusLog.text(),
    ).toContain("sync pushing pending=1");
  });
});
