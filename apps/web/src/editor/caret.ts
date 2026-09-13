/**
 * Click-on-rendered-block -> source-string caret offset (research/04-editor.md §3.3): every
 * rendered token carries `data-from`/`data-to` (`render/tokens.tsx`), so instead of Logseq's
 * `diff/find-position` heuristic (rendered-text vs. source-text diffing), a click resolves
 * deterministically: find the text node under the pointer, walk up to the nearest `[data-from]`,
 * and add the in-token character offset. Exact for every token whose rendered text equals its
 * source text (plain text, tag names, wikilink targets, code, …); for a token that hides source
 * characters in its rendered form (e.g. a wikilink's alias, `[[Target|Alias]]` rendering just
 * "Alias"), this lands the caret at the token's `data-from` rather than mid-alias — an accepted
 * approximation for v1 (documented, not silently wrong: it never lands *outside* the token).
 *
 * The hit test itself needs a real browser (`caretPositionFromPoint`/`caretRangeFromPoint`):
 * `caret.test.tsx` stubs it with answers measured in Chromium, and the real gestures are e2e
 * (`e2e/tests/focus.spec.ts`, `e2e/tests/render-views.spec.ts`).
 */

/**
 * The offset of a point that fell BETWEEN an element's children rather than inside a text node:
 * the child just after it, or failing that the one just before, when that child carries offsets.
 * An empty line inside a block (`a\n\nb`, two `<br>`s — `render/tokens.tsx#Lines`) has no text to
 * land in, so the browser answers `(p, <index of the second br>)` for a click anywhere on it, and
 * walking up from the `<p>` finds no `[data-from]` at all — the caret went to the end of the
 * block (B-325). `null` when neither neighbour says where it is, as before.
 */
function offsetBetweenChildren(node: Node, index: number): number | null {
  if (!(node instanceof Element)) return null;
  const after = node.childNodes[index];
  if (after instanceof Element && after.hasAttribute("data-from")) {
    return Number(after.getAttribute("data-from"));
  }
  const before = node.childNodes[index - 1];
  if (before instanceof Element && before.hasAttribute("data-to")) {
    return Number(before.getAttribute("data-to"));
  }
  return null;
}

function nearestOffsetAttr(node: Node | null): HTMLElement | null {
  let el = node instanceof HTMLElement ? node : (node?.parentElement ?? null);
  while (el) {
    if (el.hasAttribute("data-from")) return el;
    el = el.parentElement;
  }
  return null;
}

export function resolveClickOffset(container: HTMLElement, x: number, y: number): number | null {
  const doc = container.ownerDocument;
  let node: Node | null = null;
  let offsetInNode = 0;

  const withCaretPos = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (typeof withCaretPos.caretPositionFromPoint === "function") {
    const pos = withCaretPos.caretPositionFromPoint(x, y);
    if (pos) {
      node = pos.offsetNode;
      offsetInNode = pos.offset;
    }
  } else if (typeof doc.caretRangeFromPoint === "function") {
    const range = doc.caretRangeFromPoint(x, y);
    if (range) {
      node = range.startContainer;
      offsetInNode = range.startOffset;
    }
  }
  if (!node || !container.contains(node)) return null;

  const between = offsetBetweenChildren(node, offsetInNode);
  if (between !== null && !Number.isNaN(between)) return between;

  const el = nearestOffsetAttr(node);
  if (!el) return null;
  const from = Number(el.getAttribute("data-from"));
  const to = Number(el.getAttribute("data-to"));
  if (Number.isNaN(from) || Number.isNaN(to)) return null;

  // For a leaf text-bearing element (our `span[data-from]` text wrapper) the DOM offset within
  // the text node IS the character offset from `from`; clamp to the token's own span as a safety
  // net for any element where rendered length differs from source length (see doc comment).
  const textLength = node.textContent?.length ?? to - from;
  const clamped = Math.min(Math.max(offsetInNode, 0), textLength);
  return Math.min(from + clamped, to);
}
