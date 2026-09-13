/** Find in page (audit §2 #16) — `search.findInPage`, category `Navigation`. */
import type { Command } from "../types.js";

/** The seam to whatever renders the find bar (`app/page-find.ts` in the web app). */
export interface PageFindHost {
  /** Open the find bar on the current page, or refocus it if already open. */
  open(): void;
}

export function createPageFindCommands(deps: { pageFind: PageFindHost }): Command[] {
  return [
    {
      id: "search.findInPage",
      title: "Find in page",
      description: "Show only the blocks on this page that contain the text",
      category: "Navigation",
      defaultKeys: { mac: "Cmd+F", other: "Ctrl+F" },
      // Only where there is a page to search. Everywhere else no binding matches, the keydown is
      // left alone, and the browser's own find opens as it always did.
      when: "pageView",
      run() {
        deps.pageFind.open();
      },
    },
  ];
}

export function createFakePageFindHost(): PageFindHost & { opened: number } {
  const host = {
    opened: 0,
    open() {
      host.opened++;
    },
  };
  return host;
}
