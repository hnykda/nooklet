/**
 * Every page in the graph — the "All pages" view Logseq has and the only place that answers "what
 * is actually in here?" without searching for something specific.
 *
 * Columns (B-645): blocks, words, created, last edited, each sortable by its header, after
 * Logseq 0.10.9's `all-pages` table (`src/main/frontend/components/page.cljs`: name, backlinks,
 * created-at, updated-at, sortable titles, updated-at descending by default). The counts come from
 * the local replica (`../data/page-stats.ts`), so they are there offline. NOT copied from Logseq:
 * a backlinks column (the `ref` index is server-only, a client count would need every block
 * re-parsed), bulk select + delete, "remove orphaned pages", and pagination — see
 * `docs/progress/all-pages.md`.
 *
 * Delete is the title row's own flow (`../app/page-delete.ts`: the server's dry run quoted in the
 * in-app confirm dialog, B-491), minus the navigation to the journal — the person is looking at
 * this list, and the row simply leaves it. Journals have no Delete, as on the title row.
 *
 * Journals are hidden by default: there are hundreds of them and they are reachable through the
 * journal stream and the calendar, so they would otherwise bury everything else.
 */

import type { PageRow } from "@nooklet/core";
import { Trash2 } from "lucide-solid";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { confirmDialog } from "../app/confirm-dialog.js";
import { announce, pageActionNotice } from "../app/page-actions.js";
import { deletePageWithConfirm } from "../app/page-delete.js";
import { deletePage, findPageToDelete, previewPageDelete } from "../data/page-delete.js";
import { displayPageName } from "../data/page-title.js";
import {
  setPageFavorite,
  useAllPages,
  useFavoritePages,
  usePageIcons,
  usePageStats,
} from "../data/store.js";
import type { NavigateTarget } from "../data/types.js";
import { pageRoutePath, rawAnchorHref } from "../routes/page-path.js";
import { nextSort, type Sort, type SortKey } from "./all-pages-sort.js";
import { PageIconBadge } from "./PageIcon.js";
import "./all-pages.css";

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "blocks", label: "Blocks" },
  { key: "words", label: "Words" },
  { key: "created", label: "Created" },
  { key: "updated", label: "Edited" },
];

const numberFormat = new Intl.NumberFormat();
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export function AllPagesView(_props: { onNavigate?: (t: NavigateTarget) => void }): JSX.Element {
  const pages = useAllPages();
  const favorites = useFavoritePages();
  const icons = usePageIcons();
  const stats = usePageStats();
  const [query, setQuery] = createSignal("");
  const [sort, setSort] = createSignal<Sort>({ key: "updated", desc: true });
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
    const { key, desc } = sort();
    const s = stats();
    const value = (p: PageRow): number => {
      switch (key) {
        case "blocks":
          return s.get(p.id)?.blocks ?? 0;
        case "words":
          return s.get(p.id)?.words ?? 0;
        case "created":
          return p.createdAt ?? 0;
        default:
          return p.updatedAt ?? 0;
      }
    };
    const byName = (a: PageRow, b: PageRow): number =>
      displayPageName(a).localeCompare(displayPageName(b));
    return [...list].sort((a, b) => {
      // Ties (every empty page has 0 words) fall back to the name, A→Z whichever way the column
      // runs, so the order is stable from one refetch to the next.
      const c = key === "name" ? byName(a, b) : value(a) - value(b);
      if (c !== 0) return desc ? -c : c;
      return byName(a, b);
    });
  });

  const remove = (page: PageRow): void => {
    void deletePageWithConfirm(page.name, {
      findPage: findPageToDelete,
      preview: previewPageDelete,
      confirm: confirmDialog,
      remove: deletePage,
      // Stay on this list: the deleted row drops out of it when the pull lands.
      navigate: () => {},
      notify: announce,
    });
  };

  const header = (key: SortKey, label: string): JSX.Element => (
    <button
      type="button"
      class="all-pages-colhead"
      classList={{ "all-pages-colhead-active": sort().key === key }}
      data-col={key}
      aria-label={`Sort by ${label.toLowerCase()}`}
      aria-pressed={sort().key === key}
      onClick={() => setSort((s) => nextSort(s, key))}
    >
      {label}
      <span class="all-pages-arrow" aria-hidden="true">
        {sort().key === key ? (sort().desc ? "↓" : "↑") : ""}
      </span>
    </button>
  );

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
        {/* Phone only (CSS): the columns this would sort by are hidden there, their headers too. */}
        <select
          class="all-pages-sort"
          value={`${sort().key}:${sort().desc ? "desc" : "asc"}`}
          onChange={(e) => {
            const [key, dir] = e.currentTarget.value.split(":");
            setSort({ key: key as SortKey, desc: dir === "desc" });
          }}
          aria-label="Sort"
        >
          <option value="updated:desc">Recently edited</option>
          <option value="name:asc">Name</option>
          <option value="blocks:desc">Most blocks</option>
          <option value="words:desc">Most words</option>
          <option value="created:desc">Newest</option>
        </select>
      </header>

      <Show when={pageActionNotice()} keyed>
        {(n) => (
          <p
            class="all-pages-notice"
            classList={{ "all-pages-notice-error": n.error }}
            role={n.error ? "alert" : "status"}
          >
            {n.text}
          </p>
        )}
      </Show>

      <Show when={rows().length === 0}>
        <p class="all-pages-empty">No pages match.</p>
      </Show>

      <Show when={rows().length > 0}>
        <div class="all-pages-columns">
          <span />
          {header("name", "Name")}
          <For each={COLUMNS}>{(c) => header(c.key, c.label)}</For>
          <span />
        </div>
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
              {/* ADR 025: a raw `<a>` (plain browser navigation, no onClick override) — see
                  `rawAnchorHref`'s doc comment for why this one needs the prefix itself. */}
              <a class="all-pages-name" href={rawAnchorHref(pageRoutePath(page.name))}>
                <PageIconBadge icon={icons().get(page.id)} />
                {displayPageName(page)}
              </a>
              <span class="all-pages-cell" data-col="blocks">
                {numberFormat.format(stats().get(page.id)?.blocks ?? 0)}
              </span>
              <span class="all-pages-cell" data-col="words">
                {numberFormat.format(stats().get(page.id)?.words ?? 0)}
              </span>
              <span class="all-pages-cell" data-col="created">
                {dateFormat.format(page.createdAt)}
              </span>
              <span class="all-pages-cell" data-col="updated">
                {dateFormat.format(page.updatedAt)}
              </span>
              <Show when={page.journalDay === null} fallback={<span />}>
                <button
                  type="button"
                  class="all-pages-delete"
                  aria-label={`Delete ${displayPageName(page)}`}
                  title="Delete page…"
                  onClick={() => remove(page)}
                >
                  <Trash2 size={14} />
                </button>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
