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
import { describeError, type SearchHit, type SearchInput } from "../data/api-client.js";
import { displayRefName } from "../data/page-title.js";
import { useSearchResults } from "../data/store.js";
import { pageRoutePath, pageZoomRoutePath } from "../routes/page-path.js";
import "./search-filters.css";
import { SearchFallbackNote } from "./SearchFallbackNote.js";
import { SearchSnippet } from "./SearchSnippet.js";
import { openEmbeddingsSettings } from "./SettingsPanel.js";
import {
  NO_SEARCH_FILTERS,
  SEARCH_MARKERS,
  type SearchFilterChoice,
  searchFilterInput,
  withMarker,
} from "./searchFilters.js";

const MODES = ["hybrid", "keyword", "semantic"] as const;

export function SearchView(): JSX.Element {
  const navigate = useNavigate();

  const [query, setQuery] = createSignal("");
  const [mode, setMode] = createSignal<(typeof MODES)[number]>("hybrid");
  const [tag, setTag] = createSignal("");
  const [namespace, setNamespace] = createSignal("");
  const [updatedAfter, setUpdatedAfter] = createSignal("");
  const [updatedBefore, setUpdatedBefore] = createSignal("");
  // Audit §2 #11: task marker, blocks/pages, journals only (`./searchFilters.ts`).
  const [filters, setFilters] = createSignal<SearchFilterChoice>(NO_SEARCH_FILTERS);
  const patchFilters = (patch: Partial<SearchFilterChoice>): void => {
    setFilters((f) => ({ ...f, ...patch }));
  };

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
      ...searchFilterInput(filters()),
    };
  });

  const [results, { refetch }] = useSearchResults(input);
  // Reading an errored resource RE-THROWS. Every read below goes through this, or the first
  // failed request threw inside the loading branch's own `when`, the reactive computation died
  // with it, and "Searching…" stayed on screen forever — B-10's symptom, back for search (B-80).
  // …and only while there IS a query. An emptied box runs no search, and a resource whose source
  // goes undefined keeps its last value: the old summary and rows stayed under "Type to search.",
  // and under any filter chosen next, which they did not satisfy (B-353).
  const safeResults = () =>
    input() !== undefined && results.error === undefined ? results() : undefined;

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
        {/* Straight after "Updated after": the two are one range, and the task filters that were
            added between them left the halves ~430px apart on a phone (B-355). */}
        <label>
          Updated before
          <input
            type="date"
            value={updatedBefore()}
            onInput={(e) => setUpdatedBefore(e.currentTarget.value)}
          />
        </label>
        <label>
          Task
          <select
            class="search-filter-marker"
            value={filters().marker}
            onChange={(e) => {
              const marker = e.currentTarget.value as SearchFilterChoice["marker"];
              setFilters((f) => withMarker(f, marker));
            }}
          >
            <option value="">Any block</option>
            <For each={SEARCH_MARKERS}>{(m) => <option value={m}>{m}</option>}</For>
          </select>
        </label>
        <label>
          Show
          <select
            class="search-filter-kind"
            value={filters().kind}
            onChange={(e) =>
              patchFilters({ kind: e.currentTarget.value as SearchFilterChoice["kind"] })
            }
          >
            <option value="all">Blocks and pages</option>
            <option value="blocks">Blocks only</option>
            {/* A task is a block: "pages only" and a marker cannot both hold. */}
            <option value="pages" disabled={filters().marker !== ""}>
              Pages only
            </option>
          </select>
        </label>
        <label class="search-filter-check">
          <input
            type="checkbox"
            class="search-filter-journals"
            checked={filters().journalsOnly}
            onChange={(e) => patchFilters({ journalsOnly: e.currentTarget.checked })}
          />
          Journals only
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
      <Show when={input() !== undefined && !results.loading && results.error !== undefined}>
        <p class="search-error" role="alert">
          Search failed. {describeError(results.error)}{" "}
          <button type="button" class="search-retry" onClick={() => refetch()}>
            Retry
          </button>
        </p>
      </Show>
      <Show when={safeResults()}>
        {(r) => (
          <>
            {/* Why it fell back, and the one next step that fits (B-520). "Try again" refetches:
                an index still building or an Ollama just started is fixed by time, not a click
                elsewhere. */}
            <Show when={r().modeUsed !== mode()}>
              <SearchFallbackNote
                modeUsed={r().modeUsed}
                fallback={r().fallback}
                onOpenSettings={openEmbeddingsSettings}
                onRetry={() => refetch()}
              />
            </Show>
            <p class="search-summary">
              {r().hits.length} result{r().hits.length === 1 ? "" : "s"}
            </p>
            <ul class="search-results">
              <For each={r().hits}>
                {(hit) => (
                  <li class="search-result">
                    <button type="button" class="search-result-open" onClick={() => openHit(hit)}>
                      <div class="search-result-page">
                        {/* A journal day in the reader's title format, not its ISO storage name
                            (ADR 018, B-354). The hit carries only the name, so `displayRefName`. */}
                        {displayRefName(hit.page)}
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
