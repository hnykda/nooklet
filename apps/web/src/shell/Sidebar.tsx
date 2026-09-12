/**
 * Left sidebar: navigation, favourites, and recently edited pages.
 *
 * Favourites are a synced page property (`favorite`), not browser state — the list follows you to
 * every device, and an agent can read or set it like any other property. See
 * `data/store.ts#useFavoritePages`.
 *
 * Toggled by the existing `app.toggleSidebar` command, which flips a `sidebar-open` class on
 * `<body>`; this component reads that rather than owning a second source of truth.
 */

import type { PageRow } from "@nooklet/core";
import { A } from "@solidjs/router";
import { CalendarDays, CircleCheck, FileText, Network, Search, Star } from "lucide-solid";
import { createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { displayPageName } from "../data/page-title.js";
import { useAllPages, useFavoritePages, usePageIcons } from "../data/store.js";
import { PageIconBadge } from "../views/PageIcon.js";
import "./sidebar.css";

function useBodyClass(name: string): () => boolean {
  const [on, setOn] = createSignal(
    typeof document !== "undefined" && document.body.classList.contains(name),
  );
  onMount(() => {
    // The class is toggled imperatively by a command, so observe it rather than duplicating the
    // state here and risking the two drifting apart.
    const observer = new MutationObserver(() => setOn(document.body.classList.contains(name)));
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    onCleanup(() => observer.disconnect());
  });
  return on;
}

/** Most recently edited pages, journals excluded — the journal stream is its own view. The list
 * used to be the first twelve names alphabetically: `useAllPages` orders by name and this
 * function returned it untouched (B-76). */
function recentPages(all: ReturnType<typeof useAllPages>): () => PageRow[] {
  return () => [...all()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export function Sidebar(): JSX.Element {
  const open = useBodyClass("sidebar-open");
  const favorites = useFavoritePages();
  const icons = usePageIcons();
  const allPages = useAllPages();

  const recent = () =>
    recentPages(allPages)()
      .filter((p) => p.journalDay === null)
      .slice(0, 12);

  return (
    <Show when={open()}>
      <aside class="app-sidebar" aria-label="Sidebar">
        <nav class="sidebar-nav">
          <A href="/journals" end>
            <CalendarDays size={15} /> Journals
          </A>
          <A href="/pages">
            <FileText size={15} /> Pages
          </A>
          <A href="/tasks">
            <CircleCheck size={15} /> Tasks
          </A>
          <A href="/search">
            <Search size={15} /> Search
          </A>
          <A href="/graph">
            <Network size={15} /> Graph
          </A>
        </nav>

        <Show when={favorites().length > 0}>
          <section class="sidebar-section">
            <h2>
              <Star size={12} /> Favourites
            </h2>
            <ul>
              <For each={favorites()}>
                {(page) => (
                  <li>
                    <A href={`/page/${page.name.split("/").map(encodeURIComponent).join("/")}`}>
                      <PageIconBadge icon={icons().get(page.id)} />
                      {displayPageName(page)}
                    </A>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>

        <Show when={recent().length > 0}>
          <section class="sidebar-section">
            <h2>Pages</h2>
            <ul>
              <For each={recent()}>
                {(page) => (
                  <li>
                    <A href={`/page/${page.name.split("/").map(encodeURIComponent).join("/")}`}>
                      <PageIconBadge icon={icons().get(page.id)} />
                      {displayPageName(page)}
                    </A>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>
      </aside>
    </Show>
  );
}
