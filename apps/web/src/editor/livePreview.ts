/**
 * Live-preview decorations (`docs/spec/markdown-grammar.md` §5): re-tokenize the edited block on
 * every transaction and hide markdown syntax markers everywhere except where the cursor is inside
 * or adjacent to the token (Obsidian-style Live Preview). Implements the highest-impact rows of
 * that table — wikilink/tag/strong/em/strike/highlight/code/heading-prefix — at reasonable
 * fidelity for a first pass; NOT implemented (documented, not silently skipped):
 * `blockRef`/`linkToBlock`'s "replace with the target's first line" widget and `embed`'s inline
 * editable widget (both need a cross-page block/page lookup this milestone's data seam doesn't
 * expose — same gap as `render/tokens.tsx`). `checkbox` similarly stays a plain marked span
 * rather than a live `<input>` widget here — the rendered (non-editing) view's real checkbox
 * (`render/tokens.tsx`) already covers "click to toggle without entering edit mode"; a second
 * interactive checkbox inside the editing surface itself is deferred.
 *
 * `math` (wired in M7): a `Decoration.widget` with KaTeX's output replaces the `$…$` token when
 * the cursor is elsewhere, exactly the contract's row. KaTeX loads lazily (`render/math.ts`); the
 * first block with math on a fresh session shows the contract's `Decoration.mark` fallback, and
 * once the chunk lands the plugin dispatches a `mathReady` effect to re-decorate. A fence body is
 * never inline-tokenized, so a ```` ```query ```` block shows its raw text while editing with
 * nothing to hide — the rendered view (`render/QueryFenceView.tsx`) is the other half.
 *
 * Only `Decoration.replace` ranges (the hidden syntax markers and the math widget) are reported
 * to `EditorView.atomicRanges` — NOT the `Decoration.mark` style ranges — so arrow-key movement
 * skips a hidden `**`/`[[`/`]]` in one step (the contract's requirement) without also making
 * ordinary styled text (a whole tag, a whole link) uneditable-in-the-middle.
 *
 * This file is CM6-only and cannot be unit-tested without a real `EditorView`/DOM — the math
 * widget is covered by `e2e/tests/render.spec.ts`; the rest by the editing specs.
 */

import {
  cursorLineBoundaryBackward,
  cursorLineBoundaryForward,
  cursorLineBoundaryLeft,
  cursorLineBoundaryRight,
  selectLineBoundaryBackward,
  selectLineBoundaryForward,
  selectLineBoundaryLeft,
  selectLineBoundaryRight,
} from "@codemirror/commands";
import {
  EditorSelection,
  EditorState,
  Prec,
  RangeSetBuilder,
  StateEffect,
  Transaction,
} from "@codemirror/state";
import {
  type Command,
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { InlineToken } from "@nooklet/core";
import { classifyBlockContent } from "@nooklet/core";
import { isMathLoaded, loadMath, renderTexSync } from "./render/math.js";

function cursorTouches(from: number, to: number, head: number): boolean {
  return head >= from && head <= to;
}

/** Dispatched once KaTeX has loaded so open editors re-decorate without a keystroke. */
const mathReady = StateEffect.define<null>();

class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
  ) {
    super();
  }

  override eq(other: MathWidget): boolean {
    return other.tex === this.tex && other.display === this.display;
  }

  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    const html = renderTexSync(this.tex, this.display);
    if (html === null) {
      const delim = this.display ? "$$" : "$";
      span.className = "vr-math";
      span.textContent = `${delim}${this.tex}${delim}`;
    } else {
      span.className = "vr-math vr-math-rendered";
      span.innerHTML = html; // KaTeX output with `trust: false` — see `render/math.ts`.
    }
    return span;
  }

  override ignoreEvent(): boolean {
    // A click on the formula should place the cursor next to it (and so reveal the source),
    // which is CodeMirror's default when events are not ignored.
    return false;
  }
}

/** Walk the token tree, calling `visit` for every token (parent before children). */
function walk(tokens: InlineToken[], visit: (t: InlineToken) => void): void {
  for (const t of tokens) {
    visit(t);
    if ("children" in t && t.children) walk(t.children, visit);
    if (t.kind === "wikilink" && t.nested) walk(t.nested, visit);
    if (
      (t.kind === "linkToPage" || t.kind === "linkToBlock" || t.kind === "link") &&
      "label" in t
    ) {
      walk(t.label, visit);
    }
  }
}

interface Range {
  from: number;
  to: number;
  deco: Decoration;
}

interface Built {
  hide: Range[];
  style: Range[];
  /** A math token was seen before KaTeX had loaded — the plugin should load it and re-run. */
  wantsMath: boolean;
}

function buildRanges(doc: string, head: number): Built {
  const hide: Range[] = [];
  const style: Range[] = [];
  let wantsMath = false;

  const bc = classifyBlockContent(doc);
  const lineTokenArrays: InlineToken[][] =
    bc.kind === "paragraph" || bc.kind === "quote"
      ? bc.lines
      : bc.kind === "heading"
        ? [bc.title, ...(bc.trailing ?? [])]
        : [];

  if (bc.kind === "heading") {
    const hashLen = bc.level + 1; // "#".repeat(level) + " "
    if (!cursorTouches(0, hashLen, head))
      hide.push({ from: 0, to: hashLen, deco: Decoration.replace({}) });
  }

  for (const tokens of lineTokenArrays) {
    walk(tokens, (tok) => {
      const touching = cursorTouches(tok.start, tok.end, head);
      switch (tok.kind) {
        case "strong":
        case "em":
        case "strike":
        case "highlight": {
          const delimLen = tok.kind === "em" ? 1 : 2;
          if (!touching) {
            hide.push({ from: tok.start, to: tok.start + delimLen, deco: Decoration.replace({}) });
            hide.push({ from: tok.end - delimLen, to: tok.end, deco: Decoration.replace({}) });
          }
          if (tok.kind === "highlight") {
            style.push({
              from: tok.start,
              to: tok.end,
              deco: Decoration.mark({ class: "vr-highlight" }),
            });
          }
          break;
        }
        case "code":
          style.push({
            from: tok.start,
            to: tok.end,
            deco: Decoration.mark({ class: "vr-inline-code cm-inline-code" }),
          });
          break;
        case "wikilink":
          if (!touching) {
            hide.push({ from: tok.start, to: tok.targetStart, deco: Decoration.replace({}) });
            hide.push({ from: tok.targetEnd, to: tok.end, deco: Decoration.replace({}) });
          }
          style.push({
            from: tok.targetStart,
            to: tok.targetEnd,
            deco: Decoration.mark({ class: "vr-page-ref" }),
          });
          break;
        case "tag":
          style.push({ from: tok.start, to: tok.end, deco: Decoration.mark({ class: "vr-tag" }) });
          break;
        case "link":
          style.push({ from: tok.start, to: tok.end, deco: Decoration.mark({ class: "vr-link" }) });
          break;
        case "autolink":
          style.push({
            from: tok.start,
            to: tok.end,
            deco: Decoration.mark({ class: "vr-link vr-autolink" }),
          });
          break;
        case "math":
          if (!isMathLoaded()) {
            wantsMath = true;
            style.push({
              from: tok.start,
              to: tok.end,
              deco: Decoration.mark({ class: "vr-math" }),
            });
          } else if (touching) {
            style.push({
              from: tok.start,
              to: tok.end,
              deco: Decoration.mark({ class: "vr-math" }),
            });
          } else {
            hide.push({
              from: tok.start,
              to: tok.end,
              deco: Decoration.replace({ widget: new MathWidget(tok.tex, tok.display === true) }),
            });
          }
          break;
        default:
          break;
      }
    });
  }

  return { hide, style, wantsMath };
}

function toSet(ranges: Range[]): DecorationSet {
  const sorted = [...ranges].sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of sorted) builder.add(r.from, r.to, r.deco);
  return builder.finish();
}

class LivePreviewPlugin {
  decorations: DecorationSet;
  atomic: DecorationSet;
  private destroyed = false;
  private mathRequested = false;

  constructor(private readonly view: EditorView) {
    this.decorations = Decoration.none;
    this.atomic = Decoration.none;
    this.rebuild(view.state.doc.toString(), view.state.selection.main.head);
  }

  private rebuild(doc: string, head: number): void {
    const { hide, style, wantsMath } = buildRanges(doc, head);
    this.atomic = toSet(hide);
    this.decorations = toSet([...hide, ...style]);
    if (wantsMath && !this.mathRequested) {
      this.mathRequested = true;
      void loadMath().then(
        () => {
          // Asynchronous, so never inside an update; and a surface that was torn down in the
          // meantime must not be dispatched to.
          if (!this.destroyed) this.view.dispatch({ effects: mathReady.of(null) });
        },
        () => {
          this.mathRequested = false; // let a later edit retry the chunk
        },
      );
    }
  }

  update(update: ViewUpdate): void {
    const ready = update.transactions.some((tr) => tr.effects.some((e) => e.is(mathReady)));
    if (!update.docChanged && !update.selectionSet && !ready) return;
    this.rebuild(update.state.doc.toString(), update.state.selection.main.head);
  }

  destroy(): void {
    this.destroyed = true;
  }
}

/**
 * The markers hidden in `state` as it stands (what is hidden depends on where its caret is),
 * sorted. Only the zero-width ones: a math widget has width, so a caret before it is visibly
 * somewhere else than a caret after it.
 */
function hiddenMarkers(state: EditorState): Array<{ from: number; to: number }> {
  return buildRanges(state.doc.toString(), state.selection.main.head)
    .hide.filter((r) => r.deco.spec.widget === undefined)
    .map(({ from, to }) => ({ from, to }));
}

/** `pos` moved across every hidden marker that starts (`forward`) or ends exactly there, chained. */
function pastHidden(
  hidden: ReadonlyArray<{ from: number; to: number }>,
  pos: number,
  forward: boolean,
): number {
  let at = pos;
  for (let moved = true; moved; ) {
    moved = false;
    for (const r of hidden) {
      if (forward ? r.from === at && r.to > at : r.to === at && r.from < at) {
        at = forward ? r.to : r.from;
        moved = true;
      }
    }
  }
  return at;
}

/**
 * Wraps a line-boundary command so the caret also crosses hidden markers sitting at the boundary.
 *
 * With `lineWrapping` on, CodeMirror finds a visual line's end by hit-testing the editor's right
 * edge (`moveToLineBoundary` -> `posAtCoords`), and a zero-width `Decoration.replace` at the end of
 * the line is never under that point: End stopped BEFORE a trailing link's hidden `]]`. That
 * position touches the link, so the `]]` was revealed and the next key went into the link target
 * (`[[BaleníZ]]`, a junk page; B-606). Home likewise stopped after a leading link's `[[`. Crossing
 * the hidden range puts the caret where it visibly already was, outside the markup.
 *
 * The markers are read from the state BEFORE the move: the move itself reveals them.
 */
function acrossHiddenMarkers(command: Command, forward: boolean): Command {
  return (view) => {
    const hidden = hiddenMarkers(view.state);
    if (!command(view)) return false;
    const sel = view.state.selection;
    const next = EditorSelection.create(
      sel.ranges.map((r) => {
        const head = pastHidden(hidden, r.head, forward);
        if (head === r.head) return r;
        return r.empty
          ? EditorSelection.cursor(head, forward ? -1 : 1)
          : EditorSelection.range(r.anchor, head);
      }),
      sel.mainIndex,
    );
    if (!next.eq(sel))
      view.dispatch({ selection: next, scrollIntoView: true, userEvent: "select" });
    return true;
  };
}

/**
 * The same hit test misplaces a click in the empty space right of a line that ends in a hidden
 * marker (CM6's own mouse selection, in a block already being edited): it lands before the `]]`.
 * A pointer caret from which only hidden markers remain up to its line's end (or back to its
 * start) goes to that end. A click with visible text between it and the line edge is left alone.
 */
const pointerPastHidden = EditorState.transactionFilter.of((tr) => {
  if (!tr.isUserEvent("select.pointer") || tr.docChanged || !tr.selection) return tr;
  const main = tr.selection.main;
  if (!main.empty || tr.selection.ranges.length > 1) return tr;
  const line = tr.startState.doc.lineAt(main.head);
  const hidden = hiddenMarkers(tr.startState);
  const end = pastHidden(hidden, main.head, true);
  const start = pastHidden(hidden, main.head, false);
  const to =
    end !== main.head && end === line.to
      ? end
      : start !== main.head && start === line.from
        ? start
        : null;
  if (to === null) return tr;
  return {
    selection: EditorSelection.cursor(to, to === line.to ? -1 : 1),
    effects: tr.effects,
    scrollIntoView: tr.scrollIntoView,
    annotations: Transaction.userEvent.of("select.pointer"),
  };
});

const lineBoundaryKeymap = keymap.of([
  {
    key: "Home",
    run: acrossHiddenMarkers(cursorLineBoundaryBackward, false),
    shift: acrossHiddenMarkers(selectLineBoundaryBackward, false),
    preventDefault: true,
  },
  {
    key: "End",
    run: acrossHiddenMarkers(cursorLineBoundaryForward, true),
    shift: acrossHiddenMarkers(selectLineBoundaryForward, true),
    preventDefault: true,
  },
  // CM6 picks the direction of these by the text at the caret; this outliner's text is
  // left-to-right, so Left is backward and Right forward.
  {
    mac: "Cmd-ArrowLeft",
    run: acrossHiddenMarkers(cursorLineBoundaryLeft, false),
    shift: acrossHiddenMarkers(selectLineBoundaryLeft, false),
    preventDefault: true,
  },
  {
    mac: "Cmd-ArrowRight",
    run: acrossHiddenMarkers(cursorLineBoundaryRight, true),
    shift: acrossHiddenMarkers(selectLineBoundaryRight, true),
    preventDefault: true,
  },
]);

export const livePreview = [
  ViewPlugin.fromClass(LivePreviewPlugin, {
    decorations: (v) => v.decorations,
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? Decoration.none),
  }),
  // Above `defaultKeymap`, whose Home/End/Cmd-Arrow bindings these replace with wrapped copies.
  Prec.high(lineBoundaryKeymap),
  pointerPastHidden,
];
