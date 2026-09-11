/**
 * Every page in the graph, with its backlink count — the "Pages" view Logseq has and the only
 * place that answers "what is actually in here?" without searching for something specific.
 *
 * Journals are listed too but sorted after ordinary pages by default: there are hundreds of them
 * and they are reachable through the journal stream and the calendar, so they would otherwise
 * bury everything else.
 */

import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { displayPageName } from "../data/page-title.js";
import { setPageFavorite, useAllPages, useFavoritePages } from "../data/store.js";
import type { NavigateTarget } from "../data/types.js";
import { pageRoutePath } from "./navigateTarget.js";
import "./all-pages.css";

type SortKey = "name" | "updated";

export function AllPagesView(props: { onNavigate?: (t: NavigateTarget) => void }): JSX.Element {
  const pages = useAllPages();
  const favorites = useFavoritePages();
  const [query, setQuery] = createSignal("");
  const [sort, setSort] = createSignal<SortKey>("updated");
  const [showJournals, setShowJournals] = createSignal(false);

  const favoriteIds = createMemo(() => new Set(favorites().map((p) => p.id)));

  const rows = createMemo(() => {
    const q = query().trim().toLowerCase();
    const list = pages().filter((p) => {
      if (!showJournals() && p.journalDay !== null) return false;
      // Matched against what is on screen AND the stored name, so a journal is found by
      // "2026-09" as well as by "Sep 7th" (ADR 018 — the two are no longer the same string).
      return q === "" || `${displayPageName(p)} ${p.name}`.toLowerCase().includes(q);
    });
    const by = sort();
    return [...list].sort((a, b) =>
      by === "name"
        ? displayPageName(a).localeCompare(displayPageName(b))
        : (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
    );
  });

  return (
    <div class="all-pages">
      <header class="all-pages-header">
        <h1>
          Pages <span class="all-pages-count">{rows().length}</span>
        </h1>
        <input
          class="all-pages-filter"
          placeholder="Filter…"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <label class="all-pages-toggle">
          <input
            type="checkbox"
            checked={showJournals()}
            onChange={(e) => setShowJournals(e.currentTarget.checked)}
          />
          Journals
        </label>
        <select
          class="all-pages-sort"
          value={sort()}
          onChange={(e) => setSort(e.currentTarget.value as SortKey)}
          aria-label="Sort"
        >
          <option value="updated">Recently edited</option>
          <option value="name">Name</option>
        </select>
      </header>

      <Show when={rows().length === 0}>
        <p class="all-pages-empty">No pages match.</p>
      </Show>

      <ul class="all-pages-list">
        <For each={rows()}>
          {(page) => (
            <li class="all-pages-row">
              <button
                type="button"
                class="all-pages-star"
                aria-label={favoriteIds().has(page.id) ? "Remove favourite" : "Add favourite"}
                aria-pressed={favoriteIds().has(page.id)}
                onClick={() => void setPageFavorite(page.id, !favoriteIds().has(page.id))}
              >
                {favoriteIds().has(page.id) ? "★" : "☆"}
              </button>
              <a class="all-pages-name" href={pageRoutePath(page.name)}>
                {displayPageName(page)}
              </a>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
