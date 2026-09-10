/**
 * Live-preview decorations (`docs/spec/markdown-grammar.md` §5): re-tokenize the edited block on
 * every transaction and hide markdown syntax markers everywhere except where the cursor is inside
 * or adjacent to the token (Obsidian-style Live Preview). Implements the highest-impact rows of
 * that table — wikilink/tag/strong/em/strike/highlight/code/heading-prefix — at reasonable
 * fidelity for a first pass; NOT implemented (documented, not silently skipped):
 * `blockRef`/`linkToBlock`'s "replace with the target's first line" widget and `embed`'s inline
 * editable widget (both need a cross-page block/page lookup this milestone's data seam doesn't
 * expose — same gap as `render/tokens.tsx`), and `math`'s KaTeX widget (no renderer is loaded in
 * this milestone, so it falls back to the contract's own "otherwise `Decoration.mark` only").
 * `checkbox` similarly stays a plain marked span rather than a live `<input>` widget here — the
 * rendered (non-editing) view's real checkbox (`render/tokens.tsx`) already covers "click to
 * toggle without entering edit mode"; a second interactive checkbox inside the editing surface
 * itself is deferred.
 *
 * Only `Decoration.replace` ranges (the hidden syntax markers) are reported to
 * `EditorView.atomicRanges` — NOT the `Decoration.mark` style ranges — so arrow-key movement
 * skips a hidden `**`/`[[`/`]]` in one step (the contract's requirement) without also making
 * ordinary styled text (a whole tag, a whole link) uneditable-in-the-middle.
 *
 * This file is CM6-only and cannot be unit-tested without a real `EditorView`/DOM — see the
 * package summary's "needs manual browser verification" list.
 */

import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import type { InlineToken } from "@nooklet/core";
import { classifyBlockContent } from "@nooklet/core";

function cursorTouches(from: number, to: number, head: number): boolean {
  return head >= from && head <= to;
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

function buildRanges(doc: string, head: number): { hide: Range[]; style: Range[] } {
  const hide: Range[] = [];
  const style: Range[] = [];

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
        default:
          break;
      }
    });
  }

  return { hide, style };
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

  constructor(view: EditorView) {
    const { hide, style } = buildRanges(view.state.doc.toString(), view.state.selection.main.head);
    this.atomic = toSet(hide);
    this.decorations = toSet([...hide, ...style]);
  }

  update(update: ViewUpdate): void {
    if (!update.docChanged && !update.selectionSet) return;
    const { hide, style } = buildRanges(
      update.state.doc.toString(),
      update.state.selection.main.head,
    );
    this.atomic = toSet(hide);
    this.decorations = toSet([...hide, ...style]);
  }
}

export const livePreview = ViewPlugin.fromClass(LivePreviewPlugin, {
  decorations: (v) => v.decorations,
  provide: (plugin) =>
    EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? Decoration.none),
});
