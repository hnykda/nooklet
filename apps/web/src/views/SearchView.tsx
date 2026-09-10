/**
 * Search (BUILD item 4; PLAN.md §9): a query box with a keyword/semantic/hybrid mode toggle, a
 * result list (page, breadcrumb, highlighted snippet via `InlineContent`), and filters for tag,
 * namespace, and date range. Results navigate straight to the hit's block (or page, for a
 * page-kind hit) — the server already tells us the page name, so this skips the local
 * block-id-to-page lookup `goToTarget` would otherwise need (`useLinkedReferences`' block links do
 * need that lookup, since a reference only carries an id; a search hit already carries `page`).
 */
import { useNavigate } from "@solidjs/router";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import type { SearchHit, SearchInput } from "../data/api-client.js";
import { useSearchResults } from "../data/store.js";
import { InlineContent } from "../editor/InlineContent.js";
import { goToTarget, pageRoutePath, pageZoomRoutePath } from "./navigateTarget.js";
import { ViewNav } from "./ViewNav.js";

const MODES = ["hybrid", "keyword", "semantic"] as const;

export function SearchView(): JSX.Element {
  const navigate = useNavigate();

  const [query, setQuery] = createSignal("");
  const [mode, setMode] = createSignal<(typeof MODES)[number]>("hybrid");
  const [tag, setTag] = createSignal("");
  const [namespace, setNamespace] = createSignal("");
  const [updatedAfter, setUpdatedAfter] = createSignal("");
  const [updatedBefore, setUpdatedBefore] = createSignal("");

  const input = createMemo<SearchInput | undefined>(() => {
    const q = query().trim();
    if (q === "") return undefined;
    return {
      query: q,
      mode: mode(),
      tags: tag().trim() ? [tag().trim()] : undefined,
      namespace: namespace().trim() || undefined,
      updatedAfter: updatedAfter() ? new Date(updatedAfter()).toISOString() : undefined,
      updatedBefore: updatedBefore() ? new Date(updatedBefore()).toISOString() : undefined,
    };
  });

  const [results] = useSearchResults(input);

  function openHit(hit: SearchHit): void {
    navigate(hit.kind === "page" ? pageRoutePath(hit.page) : pageZoomRoutePath(hit.page, hit.id));
  }

  return (
    <div class="search-view">
      <ViewNav />

      <div class="search-box">
        <input
          type="search"
          class="search-query-input"
          placeholder="Search…"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <div class="search-mode-toggle" role="radiogroup" aria-label="Search mode">
          <For each={MODES}>
            {(m) => (
              <button
                type="button"
                classList={{ "search-mode-active": mode() === m }}
                aria-pressed={mode() === m}
                onClick={() => setMode(m)}
              >
                {m}
              </button>
            )}
          </For>
        </div>
      </div>

      <details class="search-filters">
        <summary>Filters</summary>
        <label>
          Tag
          <input
            value={tag()}
            onInput={(e) => setTag(e.currentTarget.value)}
            placeholder="e.g. launch"
          />
        </label>
        <label>
          Namespace
          <input
            value={namespace()}
            onInput={(e) => setNamespace(e.currentTarget.value)}
            placeholder="e.g. Projects"
          />
        </label>
        <label>
          Updated after
          <input
            type="date"
            value={updatedAfter()}
            onInput={(e) => setUpdatedAfter(e.currentTarget.value)}
          />
        </label>
        <label>
          Updated before
          <input
            type="date"
            value={updatedBefore()}
            onInput={(e) => setUpdatedBefore(e.currentTarget.value)}
          />
        </label>
      </details>

      <Show when={input() === undefined}>
        <p class="search-hint">Type to search.</p>
      </Show>
      <Show when={results.loading}>
        <p class="search-loading">Searching…</p>
      </Show>
      <Show when={results()}>
        {(r) => (
          <>
            <p class="search-summary">
              <Show when={r().modeUsed !== mode()}>
                <span class="search-mode-fallback">Fell back to {r().modeUsed} search. </span>
              </Show>
              {r().hits.length} result{r().hits.length === 1 ? "" : "s"}
            </p>
            <ul class="search-results">
              <For each={r().hits}>
                {(hit) => (
                  <li class="search-result">
                    <button type="button" class="search-result-open" onClick={() => openHit(hit)}>
                      <div class="search-result-page">
                        {hit.page}
                        <Show when={hit.breadcrumb.length > 0}>
                          <span class="search-result-breadcrumb">
                            {" "}
                            › {hit.breadcrumb.join(" › ")}
                          </span>
                        </Show>
                      </div>
                      <div class="search-result-snippet">
                        <InlineContent
                          content={hit.snippet}
                          onNavigate={(t) => void goToTarget(navigate, t)}
                        />
                      </div>
                    </button>
                  </li>
                )}
              </For>
              <Show when={r().hits.length === 0}>
                <li class="search-empty">No results.</li>
              </Show>
            </ul>
          </>
        )}
      </Show>
    </div>
  );
}
