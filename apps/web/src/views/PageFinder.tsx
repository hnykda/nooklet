/**
 * The accent-insensitive fuzzy page-name finder (BUILD item 6; PLAN.md §9). A reusable component,
 * not a palette: it renders a text input plus a results list and calls `onNavigate` — nothing
 * modal or keybound here. The command-palette agent can mount this directly (as the "pages and
 * journals" results source, docs/spec/commands-and-keymap.md R41's `nav.switchPage`) instead of
 * re-implementing page fuzzy-matching; `views/pageSearch.ts` carries the actual matching logic so
 * even that much can be reused independently of this component's markup.
 *
 * `PageFinderTrigger` below is the "usable from the views" affordance this task also needs: a
 * small button that pops this open, used by `ViewNav.tsx` (mounted at the top of every view this
 * task owns) so there is always a way to jump to a page without going through the URL bar.
 */
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { useAllPages } from "../data/store.js";
import type { NavigateTarget } from "../data/types.js";
import { fuzzyFindPages } from "./pageSearch.js";

export interface PageFinderProps {
  onNavigate: (t: NavigateTarget) => void;
  /** Called after a page is chosen, or on Escape — e.g. to close a popover. Optional: a palette
   * embedding this inline may not need it. */
  onClose?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
}

export function PageFinder(props: PageFinderProps): JSX.Element {
  const pages = useAllPages();
  const [query, setQuery] = createSignal("");
  const matches = createMemo(() => fuzzyFindPages(pages(), query(), 30));

  function choose(title: string): void {
    props.onNavigate({ kind: "page", name: title });
    setQuery("");
    props.onClose?.();
  }

  return (
    <div class="page-finder">
      <input
        type="search"
        class="page-finder-input"
        placeholder={props.placeholder ?? "Jump to page…"}
        value={query()}
        autofocus={props.autoFocus}
        onInput={(e) => setQuery(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const first = matches()[0];
            if (first) choose(first.title);
          } else if (e.key === "Escape") {
            props.onClose?.();
          }
        }}
      />
      <ul class="page-finder-results">
        <For each={matches()}>
          {(m) => (
            <li>
              <button type="button" class="page-finder-result" onClick={() => choose(m.title)}>
                {m.title}
              </button>
            </li>
          )}
        </For>
        <Show when={matches().length === 0}>
          <li class="page-finder-empty">No matching pages</li>
        </Show>
      </ul>
    </div>
  );
}

/** A button that opens `PageFinder` in a small popover — the ready-to-drop-in "usable from the
 * views" affordance. */
export function PageFinderTrigger(props: { onNavigate: (t: NavigateTarget) => void }): JSX.Element {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="page-finder-trigger">
      <button type="button" class="page-finder-open" onClick={() => setOpen((v) => !v)}>
        Jump to page…
      </button>
      <Show when={open()}>
        <div class="page-finder-popover">
          <PageFinder
            autoFocus
            onNavigate={(t) => {
              props.onNavigate(t);
              setOpen(false);
            }}
            onClose={() => setOpen(false)}
          />
        </div>
      </Show>
    </div>
  );
}
