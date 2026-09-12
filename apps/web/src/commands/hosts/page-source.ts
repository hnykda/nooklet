/**
 * `PageSource`/`BlockSource` — the read-only seams the command palette's pages mode, `nav.
 * switchPage`, and the `[[`/`#`/`((` autocomplete popups need. `data/store.ts` (the reactive data
 * seam other agents build on) does not yet expose "list all pages" or "full-text search blocks" —
 * only `usePageTree`/`useJournalStream`/`applyOps`/`useSyncStatus` — so this is a genuinely new
 * seam, not a re-export of an existing one. The integrator implements it (most naturally as a
 * small addition alongside `data/store.ts`, reusing `db/client.ts#query`) and passes it to
 * `<CommandProvider>`; fakes below back this package's own tests.
 */

export interface PageSummary {
  id: string;
  title: string;
  aliases: string[];
  updatedAt: number;
}

export interface PageSource {
  /** All pages/journals, for palette + `[[`/`#` autocomplete ranking (R56-R57, R72). Cheap enough
   * to call per keystroke — cache/memoize inside the implementation if needed; this package does
   * not. */
  listPages(): Promise<PageSummary[]>;
  /** Create a new page named `title` (the `[[`/`#` popups' "Create "<query>"" affordance, R56)
   * and return its id. */
  createPage(title: string): Promise<PageSummary>;
}

export interface BlockSummary {
  id: string;
  /** Short rendered-text snippet of the block's content. */
  snippet: string;
  pageTitle: string;
}

export interface BlockSource {
  /** Full-text fuzzy search over the local replica's block content, for `((` autocomplete (R58) —
   * matches the whole block body, not just a title. */
  searchBlocks(query: string, limit?: number): Promise<BlockSummary[]>;
}

export function createFakePageSource(
  initial: PageSummary[] = [],
): PageSource & { pages: PageSummary[] } {
  const pages = [...initial];
  return {
    pages,
    async listPages() {
      return pages;
    },
    async createPage(title) {
      const page: PageSummary = {
        id: `page-${pages.length + 1}`,
        title,
        aliases: [],
        updatedAt: Date.now(),
      };
      pages.push(page);
      return page;
    },
  };
}

export function createFakeBlockSource(blocks: BlockSummary[] = []): BlockSource {
  return {
    async searchBlocks(query, limit = 20) {
      const q = query.toLowerCase();
      return blocks.filter((b) => b.snippet.toLowerCase().includes(q)).slice(0, limit);
    },
  };
}
