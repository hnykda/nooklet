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

  // Inside a `((block ref))` preview the nested spans carry offsets into the TARGET block's
  // content (`render/tokens.tsx#RefPreview` re-tokenizes it), not this one's, so the ref itself is
  // the element whose offsets mean anything here. The OUTERMOST ref: a preview can itself contain
  // a ref, whose offsets are a third block's.
  let ref: HTMLElement | null = null;
  const start = node instanceof HTMLElement ? node : node.parentElement;
  for (let up = start; up && up !== container; up = up.parentElement) {
    if (up.classList.contains("vr-block-ref")) ref = up;
  }
  const el = ref ?? nearestOffsetAttr(node);
  if (!el) return null;

  // A point with nothing rendered after it on its line (the click was in the empty space right of
  // the text) is the END of that line in the source, past any closing markup the rendered form
  // leaves out: a link's `]]`, a bold's `**`. Mapping by the rendered character instead put the
  // caret inside a trailing `[[link]]`, and the next key retargeted it (B-606). The same at the
  // start of a line: before a leading link's `[[`, not after it.
  for (const forward of [true, false]) {
    const edge = lineEdge(container, el, node, offsetInNode, forward);
    if (edge !== null) return edge;
  }

  const from = Number(el.getAttribute("data-from"));
  const to = Number(el.getAttribute("data-to"));
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  // A ref's rendered text is another block's, so no character of it maps into `((id))`.
  if (el === ref) return from;
  const textLength = node.textContent?.length ?? to - from;
  const clamped = Math.min(Math.max(offsetInNode, 0), textLength);

  // A wikilink renders its target, which starts after the `[[` (`data-text-from`), so the
  // character under the pointer is counted from there rather than from the `[[`.
  if (el.hasAttribute("data-text-from")) {
    const textFrom = Number(el.getAttribute("data-text-from"));
    if (!Number.isNaN(textFrom)) return Math.min(textFrom + clamped, to);
  }

  // For a leaf text-bearing element (our `span[data-from]` text wrapper) the DOM offset within
  // the text node IS the character offset from `from`; clamp to the token's own span as a safety
  // net for any element where rendered length differs from source length (see doc comment).
  return Math.min(from + clamped, to);
}

/**
 * When nothing is rendered between the point and its line's end (`forward`) or start, the source
 * offset of that edge: the `data-to` (or `data-from`) of the outermost element around the point
 * that also has nothing rendered past it. `null` when the point is not at a line edge.
 */
function lineEdge(
  container: HTMLElement,
  el: HTMLElement,
  node: Node,
  offset: number,
  forward: boolean,
): number | null {
  const start = node instanceof Element ? node : node.parentElement;
  const block = start?.closest("p, h1, h2, h3, h4, h5, h6, blockquote, li, div");
  const scope = block && container.contains(block) ? block : container;
  if (!nothingRendered(scope, node, offset, forward, true)) return null;
  const attr = forward ? "data-to" : "data-from";
  let outer: HTMLElement = el;
  for (let up = el.parentElement; up && up !== scope && scope.contains(up); up = up.parentElement) {
    if (up.hasAttribute(attr) && nothingRendered(up, node, offset, forward, false)) outer = up;
  }
  const at = Number(outer.getAttribute(attr));
  return Number.isNaN(at) ? null : at;
}

/**
 * Whether the part of `scope` past the point (`forward`) or before it renders no text. A `<br>`
 * ends a line: with `uptoBreak` the walk stops there (the rest is the next line), otherwise a
 * `<br>` counts as something rendered (an element spanning a line break is not at the line edge).
 */
function nothingRendered(
  scope: Element,
  node: Node,
  offset: number,
  forward: boolean,
  uptoBreak: boolean,
): boolean {
  const doc = scope.ownerDocument;
  const range = doc.createRange();
  if (forward) {
    range.setStart(node, offset);
    range.setEnd(scope, scope.childNodes.length);
  } else {
    range.setStart(scope, 0);
    range.setEnd(node, offset);
  }
  const nodes: Node[] = [];
  const walker = doc.createTreeWalker(
    range.cloneContents(),
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
  );
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
  if (!forward) nodes.reverse();
  for (const n of nodes) {
    if (n.nodeName === "BR") return uptoBreak;
    if (n.nodeType === Node.TEXT_NODE && (n.textContent ?? "") !== "") return false;
  }
  return true;
}
