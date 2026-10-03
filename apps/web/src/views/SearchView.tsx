/**
 * Search (BUILD item 4; PLAN.md §9): a query box with a keyword/semantic/hybrid mode toggle, a
 * result list (page, breadcrumb, highlighted snippet via `SearchSnippet`), and filters for tag,
 * namespace, and date range. Results navigate straight to the hit's block (or page, for a
 * page-kind hit) — every hit already carries its page name, so this skips the local
 * block-id-to-page lookup `goToTarget` would otherwise need.
 *
 * Local first, then enriched (server-search, `../data/search-session.ts`): the device's own
 * keyword index answers as you type, online or not; when a server with semantic search is there,
 * its matches are added when they arrive, marked "semantic", and one quiet line says which side
 * answered. Before this the view asked only the server, and said "Search needs a server" in
 * local-only mode.
 */
import { useNavigate } from "@solidjs/router";
import { createEffect, createMemo, createSignal, For, type JSX, on, Show } from "solid-js";
import type { SearchInput } from "../data/api-client.js";
import { displayRefName } from "../data/page-title.js";
import { type ShownHit, searchSourceLine } from "../data/search-enrich.js";
import { useSearch } from "../data/search-session.js";
import { pageRoutePath, pageZoomRoutePath } from "../routes/page-path.js";
import "./search-filters.css";
import { SearchFallbackNote } from "./SearchFallbackNote.js";
import { SearchSnippet } from "./SearchSnippet.js";
import { openEmbeddingsSettings, settingsOpen } from "./SettingsPanel.js";
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

  // Whether the reader has put a pointer or focus on the result list for this query. Read once,
  // when the server's answer arrives, to decide whether it may re-rank the list (`mergeHits`).
  // `pointermove`, not `mouseenter`: rows rendering under a resting pointer fire `mouseenter`
  // without the pointer ever moving (B-493).
  const [listTouched, setListTouched] = createSignal(false);
  createEffect(on(input, () => setListTouched(false)));

  const search = useSearch(input, { listTouched });
  // Reading an errored resource RE-THROWS. Every read goes through `local.error` first, or the
  // first failure threw inside the loading branch's own `when`, the reactive computation died with
  // it, and "Searching…" stayed on screen forever (B-80). …and only while there IS a query: an
  // emptied box keeps the resource's last value, and the old rows stayed under "Type to search."
  // and under any filter chosen next (B-353).
  const localResult = () =>
    input() !== undefined && search.local.error === undefined ? search.local() : undefined;
  const hits = () => (input() !== undefined ? search.hits() : []);
  const semanticCount = () => hits().filter((h) => h.semantic).length;
  const fellBack = () => {
    const a = search.server();
    return a.kind === "fell-back" ? a : undefined;
  };

  // A fallback note describes the server as it was when the search ran. Its buttons lead to
  // Settings, where that is what gets changed — so when Settings closes, ask again; otherwise
  // "semantic search is not set up" stayed on screen right after it was set up (B-523). Only a
  // search that fell back re-runs: a theme change has no bearing on any other result.
  createEffect(
    on(
      settingsOpen,
      (open, wasOpen) => {
        if (wasOpen && !open && fellBack()) search.refetch();
      },
      { defer: true },
    ),
  );

  function openHit(hit: ShownHit): void {
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
      <Show when={search.local.loading && localResult() === undefined}>
        <p class="search-loading">Searching…</p>
      </Show>
      <Show when={input() !== undefined && search.local.error !== undefined}>
        <p class="search-error" role="alert">
          Search is not available on this device.
        </p>
      </Show>
      <Show when={localResult()}>
        {/* Why the server's semantic search did not run, and the one next step that fits (B-520).
            "Try again" asks again: an index still building or an Ollama just started is fixed by
            time, not a click elsewhere. */}
        <Show when={fellBack()}>
          {(f) => (
            <SearchFallbackNote
              modeUsed="keyword"
              fallback={f().fallback}
              onOpenSettings={openEmbeddingsSettings}
              onRetry={() => search.refetch()}
            />
          )}
        </Show>
        <Show when={searchSourceLine(search.server(), semanticCount())}>
          {(line) => (
            <p class="search-source" data-source={search.server().kind}>
              {line()}
            </p>
          )}
        </Show>
        <p class="search-summary">
          {hits().length} result{hits().length === 1 ? "" : "s"}
        </p>
        <ul
          class="search-results"
          onPointerMove={() => setListTouched(true)}
          onFocusIn={() => setListTouched(true)}
        >
          <For each={hits()}>
            {(hit) => {
              const body = (
                <>
                  <div class="search-result-page">
                    {/* A journal day in the reader's title format, not its ISO storage name
                        (ADR 018, B-354). The hit carries only the name, so `displayRefName`. */}
                    {displayRefName(hit.page)}
                    <Show when={hit.breadcrumb.length > 0}>
                      <span class="search-result-breadcrumb"> › {hit.breadcrumb.join(" › ")}</span>
                    </Show>
                    <Show when={hit.semantic}>
                      <span class="search-result-tag">semantic</span>
                    </Show>
                  </div>
                  <div class="search-result-snippet">
                    <SearchSnippet snippet={hit.snippet} />
                  </div>
                </>
              );
              return (
                <li class="search-result" data-semantic={hit.semantic ? "" : undefined}>
                  {/* A hit the server has and this device has not synced yet cannot open here:
                      its page route would show nothing, or an empty page of that name. */}
                  <Show
                    when={hit.onDevice}
                    fallback={
                      <div class="search-result-open search-result-away">
                        {body}
                        <div class="search-result-away-note">
                          Not on this device yet — it opens here once it has synced.
                        </div>
                      </div>
                    }
                  >
                    <button type="button" class="search-result-open" onClick={() => openHit(hit)}>
                      {body}
                    </button>
                  </Show>
                </li>
              );
            }}
          </For>
          <Show when={hits().length === 0}>
            <li class="search-empty">No results.</li>
          </Show>
        </ul>
      </Show>
    </div>
  );
}
