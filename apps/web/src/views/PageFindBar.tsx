/**
 * The find-in-page bar (audit §2 #16) and the hook a page view uses to host it.
 *
 * What it does: Cmd/Ctrl+F on a page opens a bar above the outline; typing narrows the outline to
 * the blocks that contain the text (and their ancestors, `editor/pageFilter.ts`), highlights the
 * occurrences, and counts the matching blocks. Enter / Shift+Enter step through them, scrolling
 * each into view. Escape closes the bar, restores the whole outline and — if a block was being
 * edited when the bar opened — puts the caret back where it was.
 *
 * Highlighting uses the CSS Custom Highlight API rather than wrapping text in elements: the
 * rendered rows belong to `render/tokens.tsx` and are re-rendered by Solid at will, and ranges
 * leave that DOM untouched. Where the API is missing the rows are still filtered and marked
 * (`.vr-row-find-match`); only the in-text highlight is lost.
 */

import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  closePageFind,
  pageFindFocusRequest,
  pageFindOpen,
  pageFindQuery,
  registerPageFindHost,
  setPageFindQuery,
} from "../app/page-find.js";
import { findRanges } from "../editor/pageFilter.js";
import "./page-find.css";

const HIGHLIGHT = "nooklet-find";
const HIGHLIGHT_CURRENT = "nooklet-find-current";

function highlightsSupported(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
}

/**
 * At most this many occurrences are highlighted at once. A one-letter query on the owner's biggest
 * page (1.7 MB) matches ~78,000 times; building that many ranges costs more than it shows, and
 * spreading them into `new Highlight(...)` overflows the argument limit. Every matching BLOCK is
 * still shown and counted — only the in-text marks stop. The current match is painted first.
 */
const MAX_HIGHLIGHTS = 2000;

/** Ranges over the text nodes of `root` for each `[start, end)` into its concatenated text, in
 * order, stopping after `limit`. `spans` must be sorted, as `findRanges` returns them. */
function rangesIn(root: Element, spans: Array<[number, number]>, limit: number): Range[] {
  const nodes: Array<{ node: Text; start: number; end: number }> = [];
  let length = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n as Text;
    nodes.push({ node: text, start: length, end: length + text.data.length });
    length += text.data.length;
  }
  // Spans are sorted, so the node pointer only moves forward: linear in nodes + spans.
  let k = 0;
  const locate = (offset: number, isEnd: boolean): { node: Text; offset: number } | null => {
    // An end offset exactly on a node boundary belongs to the node it ends, a start offset to the
    // node it begins — otherwise a match at a node edge became an empty range.
    while (k < nodes.length) {
      const entry = nodes[k] as { node: Text; start: number; end: number };
      if (isEnd ? offset <= entry.end : offset < entry.end) {
        return { node: entry.node, offset: offset - entry.start };
      }
      k++;
    }
    return null;
  };
  const out: Range[] = [];
  for (const [s, e] of spans) {
    if (out.length >= limit) break;
    const a = locate(s, false);
    const b = locate(e, true);
    if (!a || !b) break;
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    out.push(range);
  }
  return out;
}

function rowElement(outliner: Element, id: string): Element | null {
  return outliner.querySelector(`.vr-row[data-block-id="${CSS.escape(id)}"]`);
}

export function PageFindBar(props: {
  /** Matching block ids in reading order, from `BlockTree`'s `onFilterMatches`. */
  matches: readonly string[];
  /** The page view's root: the outline is the `.vr-outliner` directly inside its `.page-view-body`. */
  scope: () => HTMLElement | undefined;
}): JSX.Element {
  let input: HTMLInputElement | undefined;
  const [current, setCurrent] = createSignal(0);
  const active = createMemo(() => pageFindQuery().trim() !== "");
  const index = createMemo(() =>
    props.matches.length === 0 ? -1 : Math.min(current(), props.matches.length - 1),
  );

  // The page's own outline, not a references panel's outliners further down. Pinned to the exact
  // nesting: when B-595 wrapped the page's sections in `.page-view-body`, the old
  // `:scope > .vr-outliner` silently matched nothing, and find lost its highlights and its
  // scroll-to-match while still filtering rows (B-623; `e2e/tests/page-find.spec.ts`).
  const outliner = (): Element | null =>
    props.scope()?.querySelector(":scope > .page-view-body > .vr-outliner") ?? null;

  // Focus and select on open and on every repeated Cmd/Ctrl+F. The rAF is a backstop: the same
  // flush that opens the bar detaches the editor (`requestEditingEnd`), and a focused element that
  // is removed sends focus to <body> — possibly after this ran.
  createEffect(
    on(pageFindFocusRequest, () => {
      const take = (): void => {
        if (!input) return;
        input.focus();
        input.select();
      };
      take();
      requestAnimationFrame(() => {
        if (input?.isConnected && document.activeElement === document.body) take();
      });
    }),
  );

  createEffect(on(pageFindQuery, () => setCurrent(0), { defer: true }));

  let frame = 0;
  function paint(): void {
    frame = 0;
    if (!highlightsSupported()) return;
    const root = outliner();
    const q = pageFindQuery();
    const all: Range[] = [];
    const cur: Range[] = [];
    if (root && active()) {
      const currentId = props.matches[index()];
      const paintRow = (id: string, into: Range[]): void => {
        const room = MAX_HIGHLIGHTS - all.length - cur.length;
        if (room <= 0) return;
        // The row being edited has no rendered view — CodeMirror holds its text — and is skipped.
        const view = rowElement(root, id)?.querySelector(".vr-block-view");
        if (!view) return;
        for (const r of rangesIn(view, findRanges(view.textContent ?? "", q), room)) into.push(r);
      };
      if (currentId !== undefined) paintRow(currentId, cur);
      for (const id of props.matches) if (id !== currentId) paintRow(id, all);
    }
    CSS.highlights.set(HIGHLIGHT, new Highlight(...all));
    CSS.highlights.set(HIGHLIGHT_CURRENT, new Highlight(...cur));
  }
  function schedule(): void {
    if (frame === 0) frame = requestAnimationFrame(paint);
  }

  createEffect(() => {
    // Subscribe to everything `paint` reads, then paint after the rows have rendered.
    void pageFindQuery();
    void props.matches;
    void index();
    schedule();
  });
  onMount(() => {
    // Rows re-render on their own — a refetch, a `((ref))` resolving, a row scrolling into
    // `content-visibility` — and ranges into replaced text nodes go stale.
    const root = props.scope();
    if (!root) return;
    const observer = new MutationObserver(schedule);
    observer.observe(root, { subtree: true, childList: true, characterData: true });
    onCleanup(() => observer.disconnect());
  });
  onCleanup(() => {
    if (frame !== 0) cancelAnimationFrame(frame);
    if (highlightsSupported()) {
      CSS.highlights.delete(HIGHLIGHT);
      CSS.highlights.delete(HIGHLIGHT_CURRENT);
    }
  });

  function step(direction: 1 | -1): void {
    const n = props.matches.length;
    if (n === 0) return;
    const next = (index() + direction + n) % n;
    setCurrent(next);
    const id = props.matches[next];
    const root = outliner();
    if (id && root) rowElement(root, id)?.scrollIntoView({ block: "center" });
  }

  const count = (): string => {
    if (!active()) return "";
    if (props.matches.length === 0) return "No matches";
    return `${index() + 1} of ${props.matches.length}`;
  };

  return (
    // `<search>` is the landmark element itself (no form: nothing is submitted; Enter steps).
    <search class="page-find">
      <input
        ref={input}
        class="page-find-input"
        type="text"
        placeholder="Find in page"
        aria-label="Find in page"
        spellcheck={false}
        value={pageFindQuery()}
        onInput={(e) => setPageFindQuery(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.isComposing) return;
          if (e.key === "Escape") {
            e.preventDefault();
            closePageFind({ restoreFocus: true });
          } else if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          }
        }}
      />
      <span class="page-find-count" aria-live="polite">
        {count()}
      </span>
      {/* `preventDefault` on mousedown keeps focus in the input, so typing continues after a
          click on a button. */}
      <button
        type="button"
        class="page-find-button"
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        disabled={props.matches.length === 0}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => step(-1)}
      >
        ↑
      </button>
      <button
        type="button"
        class="page-find-button"
        aria-label="Next match"
        title="Next match (Enter)"
        disabled={props.matches.length === 0}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => step(1)}
      >
        ↓
      </button>
      <button
        type="button"
        class="page-find-button"
        aria-label="Close find"
        title="Close (Escape)"
        onMouseDown={(e) => e.preventDefault()}
        // Put the caret back only when the keyboard is still in the bar. The mousedown guard
        // above leaves focus wherever it was, and if that is a block being edited now, sending
        // the caret to the block the bar was opened from yanked it away from where the person was
        // typing.
        onClick={() => closePageFind({ restoreFocus: document.activeElement === input })}
      >
        ×
      </button>
    </search>
  );
}

/**
 * Everything a page view needs to host find in page, so the view itself changes by a few lines:
 * render `<find.Bar>` above its `BlockTree` and pass `find.filter()` / `find.onMatches` to it.
 *
 * `enabled` is whether there is an outline to search (the page exists). The host registers only
 * then, so Cmd/Ctrl+F on "this page doesn't exist yet" stays the browser's.
 */
export function usePageFind(
  name: Accessor<string>,
  enabled: Accessor<boolean>,
): {
  filter: () => string | undefined;
  onMatches: (ids: readonly string[]) => void;
  Bar: (props: { scope: () => HTMLElement | undefined }) => JSX.Element;
} {
  const [matches, setMatches] = createSignal<readonly string[]>([]);
  const on_ = createMemo(enabled);
  createEffect(() => {
    if (!on_()) return;
    onCleanup(registerPageFindHost());
  });
  // A find is about the page it was opened on; following a link closes it.
  createEffect(on(name, () => closePageFind({ restoreFocus: false }), { defer: true }));

  return {
    filter: () => (pageFindOpen() ? pageFindQuery() : undefined),
    onMatches: setMatches,
    Bar: (props) => (
      <Show when={pageFindOpen()}>
        <PageFindBar matches={matches()} scope={props.scope} />
      </Show>
    ),
  };
}
