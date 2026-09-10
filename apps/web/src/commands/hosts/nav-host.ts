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
  back(): void;
  forward(): void;
  openSearch(): void;
  /** Navigate to a link resolved by `EditorHost.getLinkAtCaret()` (R43). */
  followLink(link: LinkAtCaret): void;
}

export interface AppHost {
  toggleSidebar(): void;
  openSettings(): void;
  openPluginManager(): void;
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
  };
}

export function createFakeAppHost(): AppHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    toggleSidebar: () => calls.push("toggleSidebar"),
    openSettings: () => calls.push("openSettings"),
    openPluginManager: () => calls.push("openPluginManager"),
    toggleTheme: () => calls.push("toggleTheme"),
    hideKeyboard: () => calls.push("hideKeyboard"),
    syncNow: () => {
      calls.push("syncNow");
    },
    undo: () => calls.push("undo"),
    redo: () => calls.push("redo"),
  };
}
