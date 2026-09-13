/**
 * The real implementations of the seams `src/commands/` declares but deliberately does not fill:
 * `Store`, `PageSource`, `BlockSource`, `NavigationHost` and `AppHost`. The command package ships
 * fakes for its own tests; this is where those seams meet the actual data layer and router, and
 * it is the one place that knows about both.
 *
 * `EditorHost` is NOT here — it is inherently owned by whatever editor surface is currently
 * focused, so `src/app/editor-host.ts` keeps a live registration the focused `BlockTree` fills in.
 */

import { makeOp, normalizePageName, type Op, type OpPayload } from "@nooklet/core";
import type { LinkAtCaret } from "../commands/hosts/editor-host.js";
import type { AppHost, NavigationHost } from "../commands/hosts/nav-host.js";
import type {
  BlockSource,
  BlockSummary,
  PageSource,
  PageSummary,
} from "../commands/hosts/page-source.js";
import type { BlockTaskSnapshot, Store } from "../commands/types.js";
import { applyOp, applyOps, getOpClock, resolveBlockPageName } from "../data/store.js";
import { forceSync, queryAs } from "../db/client.js";
import { assetUrl } from "../editor/render/asset-url.js";
import { isSafeHref } from "../editor/render/safe-href.js";
import { flashRemoteTouch } from "../live/flash-bus.js";
import type { PageRefQuery } from "../live/resolve-page-ref.js";
import { resolvePageRef } from "../live/resolve-page-ref.js";

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

interface BlockPropRow {
  marker: string | null;
  priority: string | null;
  collapsed: number;
  scheduled: string | null;
  deadline: string | null;
  repeat: string | null;
}

export function createStore(): Store {
  return {
    async getBlockTaskState(blockId: string): Promise<BlockTaskSnapshot | undefined> {
      // The reserved scheduling keys live in dedicated columns (ADR 011/sql-schema.md rule 10),
      // reconstituted here into the property-shaped snapshot the task commands expect.
      const rows = await queryAs<BlockPropRow>(
        `SELECT marker, priority, collapsed,
                CASE WHEN scheduled_day IS NULL THEN NULL
                     ELSE substr(scheduled_day, 1, 4) || '-' || substr(scheduled_day, 5, 2) || '-' || substr(scheduled_day, 7, 2)
                          || COALESCE(' ' || scheduled_time, '') END AS scheduled,
                CASE WHEN deadline_day IS NULL THEN NULL
                     ELSE substr(deadline_day, 1, 4) || '-' || substr(deadline_day, 5, 2) || '-' || substr(deadline_day, 7, 2)
                          || COALESCE(' ' || deadline_time, '') END AS deadline,
                repeat
         FROM block WHERE id = ? AND deleted_at IS NULL`,
        [blockId],
      );
      const row = rows[0];
      if (!row) return undefined;
      return {
        marker: row.marker ?? undefined,
        priority: row.priority ?? undefined,
        scheduled: row.scheduled ?? undefined,
        deadline: row.deadline ?? undefined,
        repeat: row.repeat ?? undefined,
      } as BlockTaskSnapshot;
    },

    async setBlockProp(blockId, key, value) {
      await applyOp(blockId, { kind: "block.prop", key, value } as OpPayload);
    },

    async setBlockProps(blockId, props) {
      // One atomic batch: R35's "stamp done AND reset marker" must not be observable half-applied.
      const clock = await getOpClock(Math.max(8, Object.keys(props).length));
      const ops: Op[] = Object.entries(props).map(([key, value]) =>
        makeOp(clock.next(), clock.device, blockId, {
          kind: "block.prop",
          key,
          value,
        } as OpPayload),
      );
      await applyOps(ops);
    },

    async applyOps(ops) {
      return applyOps(ops);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// PageSource / BlockSource
// ---------------------------------------------------------------------------------------------

export function createPageSource(): PageSource {
  return {
    async listPages(): Promise<PageSummary[]> {
      const rows = await queryAs<{ id: string; name: string; updated_at: number }>(
        "SELECT id, name, updated_at FROM page WHERE deleted_at IS NULL ORDER BY updated_at DESC",
      );
      const aliasRows = await queryAs<{ page_id: string; value: string }>(
        "SELECT page_id, value FROM page_prop WHERE key = 'alias' AND value IS NOT NULL",
      );
      const aliasesByPage = new Map<string, string[]>();
      for (const a of aliasRows) {
        aliasesByPage.set(
          a.page_id,
          a.value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        );
      }
      return rows.map((r) => ({
        id: r.id,
        title: r.name,
        aliases: aliasesByPage.get(r.id) ?? [],
        updatedAt: r.updated_at,
      }));
    },

    async createPage(title: string): Promise<PageSummary> {
      const clock = await getOpClock(2);
      const id = crypto.randomUUID().replace(/-/g, "").slice(0, 14);
      await applyOps([
        makeOp(clock.next(), clock.device, id, {
          kind: "page.create",
          name: title,
          journalDay: null,
          createdAt: Date.now(),
        } as OpPayload),
      ]);
      return { id, title, aliases: [], updatedAt: Date.now() };
    },
  };
}

export function createBlockSource(): BlockSource {
  return {
    async searchBlocks(query: string, limit = 20): Promise<BlockSummary[]> {
      // The client replica has no FTS tables (those are server-only derived tables,
      // sql-schema.md rule 1), so `((` autocomplete uses a bounded LIKE over local content —
      // adequate for "find the block I just wrote", and it keeps this working offline, which a
      // server round trip would not.
      const rows = await queryAs<{ id: string; content: string; name: string }>(
        `SELECT b.id, b.content, p.name
         FROM block b JOIN page p ON p.id = b.page_id
         WHERE b.deleted_at IS NULL AND p.deleted_at IS NULL AND b.content LIKE ?
         ORDER BY b.updated_at DESC LIMIT ?`,
        [`%${query}%`, limit],
      );
      return rows.map((r) => ({
        id: r.id,
        snippet: r.content.split("\n")[0]?.slice(0, 120) ?? "",
        pageTitle: r.name,
      }));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// NavigationHost / AppHost
// ---------------------------------------------------------------------------------------------

export interface NavDeps {
  navigate: (path: string) => void;
  /** Page name for an id, so `openPage(id)` can route by name (routes are name-addressed). */
  pageNameForId: (id: string) => Promise<string | undefined>;
}

interface PageRefRow {
  id: string;
  name: string;
  journal_day: number | null;
}

function pageRefRowToResolved(
  r: PageRefRow | undefined,
): { id: string; name: string; journalDay: number | null } | null {
  return r ? { id: r.id, name: r.name, journalDay: r.journal_day } : null;
}

/** `../live/resolve-page-ref.ts#resolvePageRef`'s local-replica queries — `nav.openPage`'s (ADR
 * 015 §2.4) only real seam beyond what `NavigationHost` already has. */
function pageRefQuery(): PageRefQuery {
  return {
    async byId(id) {
      const rows = await queryAs<PageRefRow>(
        "SELECT id, name, journal_day FROM page WHERE id = ? AND deleted_at IS NULL",
        [id],
      );
      return pageRefRowToResolved(rows[0]);
    },
    async byName(name) {
      const rows = await queryAs<PageRefRow>(
        "SELECT id, name, journal_day FROM page WHERE key = ? AND deleted_at IS NULL",
        [normalizePageName(name)],
      );
      return pageRefRowToResolved(rows[0]);
    },
    async byJournalDay(day) {
      const rows = await queryAs<PageRefRow>(
        "SELECT id, name, journal_day FROM page WHERE journal_day = ? AND deleted_at IS NULL",
        [day],
      );
      return pageRefRowToResolved(rows[0]);
    },
  };
}

export function pagePath(name: string): string {
  return `/page/${name.split("/").map(encodeURIComponent).join("/")}`;
}

export function createNavigationHost(deps: NavDeps): NavigationHost {
  return {
    openPage(pageId) {
      void deps.pageNameForId(pageId).then((name) => {
        if (name) deps.navigate(`/page/${name.split("/").map(encodeURIComponent).join("/")}`);
      });
    },
    openTodayJournal() {
      deps.navigate("/journals");
    },
    openJournals() {
      deps.navigate("/journals");
    },
    back() {
      history.back();
    },
    forward() {
      history.forward();
    },
    openSearch() {
      deps.navigate("/search");
    },
    followLink(link: LinkAtCaret) {
      if (link.type === "url" && link.href) {
        // Through `assetUrl`, as the rendered link is: a raw `assets/x.pdf` resolves against the
        // current `/page/...` URL and opens the SPA fallback instead of the file (B-137, B-51).
        // Same scheme guard as the rendered link (B-268): the URL is content, and may be `javascript:`.
        const url = assetUrl(link.href);
        if (isSafeHref(url)) window.open(url, "_blank", "noopener");
        return;
      }
      if ((link.type === "page" || link.type === "tag") && link.name) {
        const name = normalizePageName(link.name);
        deps.navigate(`/page/${name.split("/").map(encodeURIComponent).join("/")}`);
        return;
      }
      if (link.type === "block" && link.id) {
        const blockId = link.id;
        // By BLOCK id. `deps.pageNameForId` takes a page id (B-82) and found nothing for a block,
        // so Alt+Enter on a ((ref)) silently went nowhere (B-139).
        void resolveBlockPageName(blockId).then((pageName) => {
          if (pageName) deps.navigate(`${pagePath(pageName)}?block=${blockId}`);
        });
      }
    },
    openPageByRef(ref, blockId) {
      void resolvePageRef(ref, pageRefQuery()).then((resolved) => {
        if (!resolved) return;
        const path = blockId
          ? `${pagePath(resolved.name)}?block=${blockId}`
          : pagePath(resolved.name);
        deps.navigate(path);
      });
    },
    revealBlock(blockId) {
      void resolveBlockPageName(blockId).then((pageName) => {
        if (!pageName) return;
        // "Without changing focus/navigation" (ADR 015 §2.5's ui_highlight): only navigate if the
        // block's page isn't already the one on screen, and never add `?block=` here — that param
        // means ZOOM (`../routes/PageRoute.tsx`), a bigger change than "point at this block."
        const target = pagePath(pageName);
        if (decodeURIComponent(window.location.pathname) !== decodeURIComponent(target)) {
          deps.navigate(target);
        }
        flashRemoteTouch(blockId);
      });
    },
  };
}

export interface AppDeps {
  toggleSidebar: () => void;
  undo: () => void;
  redo: () => void;
  setTheme: (t: "light" | "dark" | "system") => void;
  getTheme: () => "light" | "dark" | "system";
  navigate: (path: string) => void;
  /** Raises the settings panel. A dependency rather than a direct import because the panel is
   * shell-level UI and this module is the data/router seam — `CommandLayer` owns that wiring. */
  openSettings: () => void;
  /** Raises the settings panel at its Plugins section (B-98) — same reason as `openSettings`. */
  openPluginManager: () => void;
}

const THEME_CYCLE = { light: "dark", dark: "system", system: "light" } as const;

export function createAppHost(deps: AppDeps): AppHost {
  return {
    toggleSidebar: deps.toggleSidebar,
    // NOT `navigate("/settings")`, which is what this used to do: there is no `/settings` route
    // (see `../App.tsx`'s route table), so Cmd/Ctrl+, rendered an empty screen. Settings is a
    // modal over whatever you were reading — the same shape as Diagnostics — so it keeps the
    // current route instead of replacing it.
    openSettings: deps.openSettings,
    // Not `navigate("/settings/plugins")`, which is what this used to do — no such route, so the
    // main area went blank (B-98). There is no manager; Settings lists the running plugins.
    openPluginManager: deps.openPluginManager,
    toggleTheme() {
      deps.setTheme(THEME_CYCLE[deps.getTheme()]);
    },
    hideKeyboard() {
      // Blurring the focused editable is the only way a web page can dismiss the soft keyboard.
      (document.activeElement as HTMLElement | null)?.blur();
    },
    syncNow() {
      return forceSync();
    },
    undo: deps.undo,
    redo: deps.redo,
  };
}
