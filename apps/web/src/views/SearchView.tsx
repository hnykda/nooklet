/**
 * Search (BUILD item 4; PLAN.md §9): a query box with a keyword/semantic/hybrid mode toggle, a
 * result list (page, breadcrumb, highlighted snippet via `SearchSnippet`), and filters for tag,
 * namespace, and date range. Results navigate straight to the hit's block (or page, for a
 * page-kind hit) — the server already tells us the page name, so this skips the local
 * block-id-to-page lookup `goToTarget` would otherwise need (`useLinkedReferences`' block links do
 * need that lookup, since a reference only carries an id; a search hit already carries `page`).
 */
import { useNavigate } from "@solidjs/router";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import type { SearchHit, SearchInput } from "../data/api-client.js";
import { useSearchResults } from "../data/store.js";
import { pageRoutePath, pageZoomRoutePath } from "./navigateTarget.js";
import { SearchSnippet } from "./SearchSnippet.js";

const MODES = ["hybrid", "keyword", "semantic"] as const;

/** A short, human-readable reason. Network failures surface as a bare TypeError, which on its own
 * tells the reader nothing. */
function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (/failed to fetch|networkerror|load failed/i.test(message))
    return "Could not reach the server.";
  return message;
}

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

  const [results, { refetch }] = useSearchResults(input);
  // Reading an errored resource RE-THROWS. Every read below goes through this, or the first
  // failed request threw inside the loading branch's own `when`, the reactive computation died
  // with it, and "Searching…" stayed on screen forever — B-10's symptom, back for search (B-80).
  const safeResults = () => (results.error === undefined ? results() : undefined);

  function openHit(hit: SearchHit): void {
    navigate(hit.kind === "page" ? pageRoutePath(hit.page) : pageZoomRoutePath(hit.page, hit.id));
  }

  return (
    <div class="search-view">
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
      <Show when={results.loading && safeResults() === undefined}>
        <p class="search-loading">Searching…</p>
      </Show>
      {/* Without this, a failed request left "Searching…" on screen forever — which is exactly
          how a missing API token presented, and is indistinguishable from a slow server. */}
      <Show when={!results.loading && results.error !== undefined}>
        <p class="search-error" role="alert">
          Search failed. {errorText(results.error)}{" "}
          <button type="button" class="search-retry" onClick={() => refetch()}>
            Retry
          </button>
        </p>
      </Show>
      <Show when={safeResults()}>
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
                        <SearchSnippet snippet={hit.snippet} />
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
