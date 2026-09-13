/**
 * Page portability and favourites (exposure audit §2 items 9, 10, 13; B-220, B-221, B-222):
 * copy a page as markdown, export it as a `.md` file, print it, and favourite/unfavourite it —
 * from the palette, and from the page's title row, which runs these same commands with the page
 * named in `args` (`views/PageActions.tsx`).
 *
 * Host-agnostic like every registration here: the clipboard, the download, the property write and
 * `window.print()` live behind `PageActionsHost` (`app/page-actions-host.ts` for real,
 * `createFakePageActionsHost()` for tests).
 *
 * Ids use the `app.` area, not `page.`: R2's core areas are a closed set and an unknown area throws
 * at registration, before the first render (B-87 — the same reason `edit.mergePage` is `edit.`).
 *
 * Which page: `args.page` (a page name) when given — the title row, or an agent through `ui_run` —
 * else the page the route shows. `WhenContext` cannot see the route, so off a page (the journal
 * stream, search) the three page commands quietly do nothing, as `edit.mergePage` does. Printing
 * needs no page: it prints whatever view is open.
 */
import type { Command, CommandContext } from "../types.js";

export interface PageActionsHost {
  /** The page the current route shows, or `null` off a page route. */
  currentPageName(): string | null;
  /** Put the page on the clipboard as outline markdown without block ids. Must START the
   * clipboard write synchronously (WebKit's user-gesture rule — see `app/page-actions.ts`). */
  copyPageMarkdown(page: string): Promise<void>;
  /** Download the page as the mirror's `.md` file, ids included. */
  exportPageMarkdown(page: string): Promise<void>;
  /** Add the page to favourites, or remove it. */
  toggleFavorite(page: string): Promise<void>;
  /** Open the print dialog. */
  printPage(): void;
}

/** `args.page` if it is a non-empty string, else the routed page. */
export function targetPageName(ctx: Pick<CommandContext, "args">, host: PageActionsHost) {
  const args = ctx.args as { page?: unknown } | undefined;
  if (typeof args?.page === "string" && args.page !== "") return args.page;
  return host.currentPageName();
}

export function createPageActionCommands(deps: { pageActions: PageActionsHost }): Command[] {
  const host = deps.pageActions;
  // Not `async`: `run` must reach the host in the same tick the key or click arrived in, or WebKit
  // refuses the clipboard write (`copyPageMarkdown` above).
  const onPage =
    (act: (page: string) => Promise<void>) =>
    (ctx: CommandContext): Promise<void> | undefined => {
      const page = targetPageName(ctx, host);
      return page === null ? undefined : act(page);
    };
  return [
    {
      id: "app.copyPageMarkdown",
      title: "Copy page as markdown",
      description: "The whole page as outline markdown, without block ids",
      category: "App",
      defaultKeys: {},
      when: "true",
      run: onPage((page) => host.copyPageMarkdown(page)),
    },
    {
      id: "app.exportPageMarkdown",
      title: "Export page as markdown",
      description: "Download the page as a .md file — the same text the markdown mirror writes",
      category: "App",
      defaultKeys: {},
      when: "true",
      run: onPage((page) => host.exportPageMarkdown(page)),
    },
    {
      id: "app.printPage",
      title: "Print page",
      description: "Print or save as PDF: just the page, with collapsed blocks expanded",
      category: "App",
      defaultKeys: {},
      when: "true",
      run() {
        host.printPage();
      },
    },
    {
      id: "app.toggleFavorite",
      title: "Toggle favourite",
      description: "Add this page to the sidebar's Favourites, or remove it",
      category: "App",
      defaultKeys: {},
      when: "true",
      run: onPage((page) => host.toggleFavorite(page)),
    },
  ];
}

export function createFakePageActionsHost(opts?: { page?: string | null }): {
  host: PageActionsHost;
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const host: PageActionsHost = {
    currentPageName: () => opts?.page ?? null,
    async copyPageMarkdown(page) {
      calls.push({ method: "copyPageMarkdown", args: [page] });
    },
    async exportPageMarkdown(page) {
      calls.push({ method: "exportPageMarkdown", args: [page] });
    },
    async toggleFavorite(page) {
      calls.push({ method: "toggleFavorite", args: [page] });
    },
    printPage() {
      calls.push({ method: "printPage", args: [] });
    },
  };
  return { host, calls };
}
