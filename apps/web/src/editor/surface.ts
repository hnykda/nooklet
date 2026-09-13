/**
 * The single, reused CodeMirror 6 `EditorView` (ADR 006 / research/04-editor.md §3.3): exactly one
 * exists for the whole `BlockTree`, re-parented into whichever block's row is being edited. Every
 * other block stays inert rendered HTML (`render/tokens.tsx`). Implements the `Surface` interface
 * research/04-editor.md §3.3 sketches, adapted to this package's `CaretSpec`/`Clock`-free op
 * layer: text changes are streamed out via `deps.onTextChange` on every transaction (so nothing is
 * lost on a crash and other consumers stay current) rather than kept only in CM6 state; committing
 * them to `block.text` ops with the 500 ms coalescing is `BlockTree.tsx`'s job (`history.ts`).
 *
 * Key handling: one CM6 `keymap` at `Prec.highest`, each row reconstructing the exact
 * `KeyDescriptor` its own key string represents and asking `keydown.ts#resolveCommand`-driven
 * `deps.dispatchKey` whether to handle it — see that file for why the source of truth for "what a
 * key means" lives in one pure, unit-tested function instead of being duplicated here.
 *
 * This file is CM6-only and cannot be unit-tested without a real `EditorView`/DOM — see the
 * package summary's "needs manual browser verification" list (real focus-retention-across-blocks
 * behavior on iOS/Android in particular).
 */

import { defaultKeymap } from "@codemirror/commands";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { noteFocus } from "../app/focus-log.js";
import type { KeyDescriptor } from "./keydown.js";
import { livePreview } from "./livePreview.js";
import type { CaretSpec } from "./types.js";

export interface Geometry {
  atStart: boolean;
  atEnd: boolean;
  onFirstLine: boolean;
  onLastLine: boolean;
  goalX: number;
}

export interface Surface {
  attach(host: HTMLElement, id: string, content: string, caret?: CaretSpec): void;
  /** Commits and unmounts; `null` if nothing was attached. Does NOT itself write any op — the
   * caller (`BlockTree.tsx`) decides when a pending text edit becomes a `block.text` op. */
  detach(): { id: string; content: string; head: number } | null;
  content(): string;
  head(): number;
  anchor(): number;
  isComposing(): boolean;
  geometry(): Geometry;
  setCaret(spec: CaretSpec): void;
  currentId(): string | null;
  focus(): void;
  /**
   * Replace the whole document while attached to `id`, keeping the caret where it was (clamped).
   * For changes that arrive from OUTSIDE the editor — undo, a merge, a pull from another device —
   * which used to be silently discarded because the live buffer always won (B-46).
   */
  replaceContent(id: string, content: string): void;
  /** The live CM6 view, for callers that must dispatch through the real editor (the command
   * system's `EditorHost` bridge). `null` when nothing is attached. */
  view(): EditorView | null;
}

export interface SurfaceDeps {
  onTextChange(id: string, content: string): void;
  /** Returns `true` if the key was handled (CM6 must not run its own default action). */
  dispatchKey(id: string, kd: KeyDescriptor, view: EditorView): boolean;
  /** `edit.paste` (R33): returns `true` if handled (caller already called `preventDefault`). */
  onPaste(id: string, event: ClipboardEvent, view: EditorView): boolean;
}

const KEY_BINDINGS: Array<{ cmKey: string; kd: KeyDescriptor }> = [
  { cmKey: "Enter", kd: { key: "Enter", mod: false, shift: false, alt: false } },
  { cmKey: "Shift-Enter", kd: { key: "Enter", mod: false, shift: true, alt: false } },
  { cmKey: "Mod-Enter", kd: { key: "Enter", mod: true, shift: false, alt: false } },
  { cmKey: "Tab", kd: { key: "Tab", mod: false, shift: false, alt: false } },
  { cmKey: "Shift-Tab", kd: { key: "Tab", mod: false, shift: true, alt: false } },
  { cmKey: "Backspace", kd: { key: "Backspace", mod: false, shift: false, alt: false } },
  { cmKey: "Delete", kd: { key: "Delete", mod: false, shift: false, alt: false } },
  { cmKey: "Alt-ArrowUp", kd: { key: "ArrowUp", mod: false, shift: false, alt: true } },
  { cmKey: "Alt-ArrowDown", kd: { key: "ArrowDown", mod: false, shift: false, alt: true } },
  { cmKey: "ArrowUp", kd: { key: "ArrowUp", mod: false, shift: false, alt: false } },
  { cmKey: "ArrowDown", kd: { key: "ArrowDown", mod: false, shift: false, alt: false } },
  { cmKey: "ArrowLeft", kd: { key: "ArrowLeft", mod: false, shift: false, alt: false } },
  { cmKey: "ArrowRight", kd: { key: "ArrowRight", mod: false, shift: false, alt: false } },
  { cmKey: "Mod-ArrowUp", kd: { key: "ArrowUp", mod: true, shift: false, alt: false } },
  { cmKey: "Mod-ArrowDown", kd: { key: "ArrowDown", mod: true, shift: false, alt: false } },
  { cmKey: "Mod-.", kd: { key: ".", mod: true, shift: false, alt: false } },
  { cmKey: "Mod-Shift-.", kd: { key: ".", mod: true, shift: true, alt: false } },
  { cmKey: "Escape", kd: { key: "Escape", mod: false, shift: false, alt: false } },
  { cmKey: "Shift-ArrowUp", kd: { key: "ArrowUp", mod: false, shift: true, alt: false } },
  { cmKey: "Shift-ArrowDown", kd: { key: "ArrowDown", mod: false, shift: true, alt: false } },
  { cmKey: "Mod-Shift-d", kd: { key: "d", mod: true, shift: true, alt: false } },
  { cmKey: "Mod-Shift-c", kd: { key: "c", mod: true, shift: true, alt: false } },
  { cmKey: "Mod-z", kd: { key: "z", mod: true, shift: false, alt: false } },
  { cmKey: "Mod-Shift-z", kd: { key: "z", mod: true, shift: true, alt: false } },
];

export function createSurface(deps: SurfaceDeps): Surface {
  let current: string | null = null;

  const outlinerKeymap = keymap.of(
    KEY_BINDINGS.map(({ cmKey, kd }) => ({
      key: cmKey,
      run: (v: EditorView): boolean => {
        if (!current) return false;
        return deps.dispatchKey(current, kd, v);
      },
    })),
  );

  const extensions = [
    Prec.highest(outlinerKeymap),
    keymap.of(defaultKeymap), // no history() — undo/redo is the document-level EditHistory (ADR 006)
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({
      spellcheck: "true",
      autocorrect: "on",
      autocapitalize: "sentences",
      enterkeyhint: "enter",
      "aria-label": "Block content",
    }),
    livePreview,
    EditorView.updateListener.of((update) => {
      if (update.docChanged && current) deps.onTextChange(current, update.state.doc.toString());
    }),
    EditorView.domEventHandlers({
      paste(event, v) {
        if (!current) return false;
        return deps.onPaste(current, event, v);
      },
    }),
    EditorView.theme({
      "&": { fontSize: "inherit", fontFamily: "inherit" },
      ".cm-content": { padding: 0, fontFamily: "inherit" },
      ".cm-line": { padding: 0 },
      "&.cm-editor": { backgroundColor: "transparent" },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": { fontFamily: "inherit", lineHeight: "inherit" },
    }),
  ];

  const view = new EditorView({ state: EditorState.create({ doc: "", extensions }) });

  function setCaretInternal(spec: CaretSpec): void {
    const doc = view.state.doc;
    let pos: number;
    if ("at" in spec) pos = spec.at === "start" ? 0 : doc.length;
    else if ("offset" in spec) pos = Math.min(Math.max(0, spec.offset), doc.length);
    else {
      const y = view.coordsAtPos(spec.line === "first" ? 0 : doc.length);
      pos = y
        ? (view.posAtCoords({ x: spec.goalX, y: (y.top + y.bottom) / 2 }) ?? doc.length)
        : doc.length;
    }
    view.dispatch({ selection: { anchor: pos } });
  }

  return {
    attach(host, id, content, caret = { at: "end" }) {
      noteFocus("editor attach", `block ${id}; host connected=${host.isConnected}`);
      current = id;
      const focusedBefore = typeof document === "undefined" ? null : document.activeElement;
      view.setState(EditorState.create({ doc: content, extensions }));
      host.appendChild(view.dom);
      view.focus();
      setCaretInternal(caret);
      // Re-assert focus, twice, for two different reasons. Guarded on still being attached to the
      // same block so a genuine click-away is never fought.
      const refocus = (): void => {
        if (current === id && !view.hasFocus) view.focus();
      };

      // 1. Solid runs a `ref` callback when the element is CREATED, not when it is inserted into
      //    the document — so the `view.focus()` above often runs while `host` is still detached,
      //    where focusing is a no-op. A microtask runs after Solid finishes inserting but before
      //    the browser dispatches the next input event, which is what keeps keystrokes typed
      //    immediately after Enter from being delivered to `<body>` and lost.
      queueMicrotask(refocus);

      // 2. Entering edit mode also removes the previously focused element (the clicked
      //    `.vr-block-view`, or the previous row's host). The browser resets focus to `<body>`
      //    when that happens, potentially after the current event finishes dispatching, so a
      //    frame-later backstop is still needed on top of the microtask.
      //
      //    But a frame is not "soon" on a loaded machine: the browser keeps dispatching input while
      //    it drops frames, so this can run after keystrokes that came later — after Cmd+K put
      //    focus in the palette's input — and it took focus back from the open palette, so typing
      //    went into the block underneath (B-290). It may take focus only from where entering
      //    edit mode leaves it: `<body>`, or the element that still had it when this attach ran.
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active !== null && active !== document.body && active !== focusedBefore) return;
        refocus();
      });
      view.dispatch({
        effects: EditorView.scrollIntoView(view.state.selection.main.head, {
          y: "nearest",
          yMargin: 64,
        }),
      });
    },
    detach() {
      if (!current) return null;
      // With the stack: several paths end editing (a click away, a block gone from the page, a
      // selection, a lock), and the log has to say which one did (B-42).
      noteFocus("editor detach", `block ${current}`, { stack: true });
      const out = {
        id: current,
        content: view.state.doc.toString(),
        head: view.state.selection.main.head,
      };
      view.dom.remove();
      current = null;
      return out;
    },
    content: () => view.state.doc.toString(),
    head: () => view.state.selection.main.head,
    anchor: () => view.state.selection.main.anchor,
    isComposing: () => view.composing,
    geometry(): Geometry {
      const { head } = view.state.selection.main;
      const doc = view.state.doc;
      const c = view.coordsAtPos(head);
      const first = view.coordsAtPos(0);
      const last = view.coordsAtPos(doc.length);
      return {
        atStart: head === 0,
        atEnd: head === doc.length,
        onFirstLine: !c || !first || Math.abs(c.top - first.top) < 2,
        onLastLine: !c || !last || Math.abs(c.top - last.top) < 2,
        goalX: c ? c.left : 0,
      };
    },
    setCaret: setCaretInternal,
    currentId: () => current,
    view: () => (current === null ? null : view),
    focus: () => view.focus(),
    replaceContent(id, content) {
      if (current !== id) return;
      const doc = view.state.doc;
      if (doc.toString() === content) return;
      const head = Math.min(view.state.selection.main.head, content.length);
      view.dispatch({
        changes: { from: 0, to: doc.length, insert: content },
        selection: { anchor: head },
      });
    },
  };
}
