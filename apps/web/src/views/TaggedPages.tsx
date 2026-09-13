/**
 * "Pages tagged X" — the top section of the references panel on a tag's page (ADR 017, B-111).
 *
 * A page tagged `tags:: person` does not link to `Person` from any block, so without this the
 * `Person` page showed nothing about its members; `page.list({tag})` was the only way to ask. The
 * rows come from `page.backlinks`'s `tagged_pages` (the server's `page_tag` index — the replica
 * has no such table), which is why this lives inside `ReferencesPanel` and shares its one request.
 *
 * Above linked references because it answers the first question a tag page is opened for ("what
 * is a Person here?"), and it is compact: one wrapped line of page names rather than blocks.
 * Collapses like the other halves. When the server returned fewer rows than exist (a `Journal`
 * page on a graph with years of days), the count says the real total and a line says how many are
 * shown — a count over a truncated list must not pretend to be the list.
 */
import { createSignal, For, type JSX, Show } from "solid-js";
import type { TaggedPage } from "../data/api-client.js";
import { displayRefName } from "../data/page-title.js";
import type { NavigateTarget } from "../data/types.js";
import "./tagged-pages.css";

export interface TaggedPagesProps {
  /** The tag — the page being viewed. */
  target: string;
  pages: readonly TaggedPage[];
  total: number;
  onNavigate: (t: NavigateTarget) => void;
}

export function TaggedPages(props: TaggedPagesProps): JSX.Element {
  const [open, setOpen] = createSignal(true);
  const label = () => `Pages tagged ${displayRefName(props.target)}`;

  return (
    <Show when={props.pages.length > 0}>
      <section class="tagged-pages" aria-label={label()}>
        <div class="references-head">
          <button
            type="button"
            class="references-toggle"
            aria-expanded={open()}
            onClick={() => setOpen((v) => !v)}
          >
            <span class="references-caret" aria-hidden="true">
              {open() ? "▾" : "▸"}
            </span>
            {label()}
            <span class="reference-count">{props.total}</span>
          </button>
        </div>
        <Show when={open()}>
          <ul class="tagged-pages-list">
            <For each={props.pages}>
              {(tagged) => (
                <li>
                  <button
                    type="button"
                    class="tagged-page-link"
                    data-source={tagged.source}
                    onClick={() => props.onNavigate({ kind: "page", name: tagged.page })}
                  >
                    {displayRefName(tagged.page)}
                  </button>
                </li>
              )}
            </For>
          </ul>
          <Show when={props.total > props.pages.length}>
            <p class="references-empty">
              Showing {props.pages.length} of {props.total}.
            </p>
          </Show>
        </Show>
      </section>
    </Show>
  );
}
