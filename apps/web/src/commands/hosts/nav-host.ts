/**
 * `NavigationHost`/`AppHost` — the narrow seams `nav.*`/`app.*`/`sync.now`/`edit.undo`/`edit.redo`
 * commands call into. Routing (`@solidjs/router`), the settings/plugin-manager views, the
 * document-level undo/redo history (ADR 006 §7), sync's `forceSync`, and theme/sidebar UI state
 * all live outside `commands/` (routes/, sync/, db/, App.tsx are off-limits to this package), so
 * these commands register real, spec-faithful `run()` logic that simply forwards to whichever
 * host method matches, and the integrator supplies the implementation. Fakes below record calls
 * for this package's own tests.
 */
import type { LinkAtCaret } from "./editor-host.js";

export interface NavigationHost {
  openPage(pageId: string): void;
  openTodayJournal(): void;
  openJournals(): void;
  /** The All pages list (`/pages`). */
  openAllPages(): void;
  /** The graph view (`/graph`). The host hides `nav.graph` where there is no graph (B-578). */
  openGraph(): void;
  /** Trash (`/trash`). */
  openTrash(): void;
  back(): void;
  forward(): void;
  openSearch(): void;
  /** Navigate to a link resolved by `EditorHost.getLinkAtCaret()` (R43). */
  followLink(link: LinkAtCaret): void;
  /**
   * ADR 015 §2.4's `nav.openPage`: jump straight to a known page by name/id/journal-date/
   * "today"|"yesterday"|"tomorrow", with no picker — the one thing no existing `nav.*` command
   * does (`nav.switchPage` opens an interactive picker; `nav.todayJournal`/`nav.journals` have a
   * fixed destination). `blockId`, if given, additionally zooms into that block. Equally useful to
   * a future plugin wanting to navigate programmatically, not just to remote agents.
   */
  openPageByRef(ref: string, blockId?: string): void;
  /**
   * ADR 015 §2.4's `nav.revealBlock`: scroll a known block into view and flash it, WITHOUT
   * changing the current zoom root or editing focus — the "point at Y without navigating away"
   * primitive `ui_highlight` wraps. Navigates to the block's own page first only if it isn't
   * already the one showing.
   */
  revealBlock(blockId: string): void;
}

export interface AppHost {
  toggleSidebar(): void;
  openSettings(): void;
  /** Settings, at its read-only list of running plugins — there is no manager UI (B-98). */
  openPluginManager(): void;
  /** The keyboard-shortcuts dialog, generated from the live keymap (`shell/HelpMenu.tsx`). */
  openShortcuts(): void;
  /** The Diagnostics panel (`views/DiagnosticsPanel.tsx`). */
  openDiagnostics(): void;
  /** Cycles light -> dark -> system (R52). */
  toggleTheme(): void;
  hideKeyboard(): void;
  syncNow(): void | Promise<void>;
  undo(): void;
  redo(): void;
}

export function createFakeNavigationHost(): NavigationHost & {
  calls: Array<{ method: string; arg?: unknown }>;
} {
  const calls: Array<{ method: string; arg?: unknown }> = [];
  return {
    calls,
    openPage(pageId) {
      calls.push({ method: "openPage", arg: pageId });
    },
    openTodayJournal() {
      calls.push({ method: "openTodayJournal" });
    },
    openJournals() {
      calls.push({ method: "openJournals" });
    },
    openAllPages() {
      calls.push({ method: "openAllPages" });
    },
    openGraph() {
      calls.push({ method: "openGraph" });
    },
    openTrash() {
      calls.push({ method: "openTrash" });
    },
    back() {
      calls.push({ method: "back" });
    },
    forward() {
      calls.push({ method: "forward" });
    },
    openSearch() {
      calls.push({ method: "openSearch" });
    },
    followLink(link) {
      calls.push({ method: "followLink", arg: link });
    },
    openPageByRef(ref, blockId) {
      calls.push({ method: "openPageByRef", arg: { ref, blockId } });
    },
    revealBlock(blockId) {
      calls.push({ method: "revealBlock", arg: blockId });
    },
  };
}

export function createFakeAppHost(): AppHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    toggleSidebar: () => calls.push("toggleSidebar"),
    openSettings: () => calls.push("openSettings"),
    openPluginManager: () => calls.push("openPluginManager"),
    openShortcuts: () => calls.push("openShortcuts"),
    openDiagnostics: () => calls.push("openDiagnostics"),
    toggleTheme: () => calls.push("toggleTheme"),
    hideKeyboard: () => calls.push("hideKeyboard"),
    syncNow: () => {
      calls.push("syncNow");
    },
    undo: () => calls.push("undo"),
    redo: () => calls.push("redo"),
  };
}
