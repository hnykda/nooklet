/**
 * "Open on shelf" as commands (exposure audit §2 item 6, B-160). Until these, the shelf's only
 * way in was a Shift+click on a bullet or a `[[link]]`, which nothing on screen mentions and no
 * keyboard can do. As commands they are reachable from the palette and the bullet context menu,
 * and rebindable like everything else.
 *
 * Host-agnostic like every registration: putting something on the shelf, and knowing which page
 * the current route shows, go through `ShelfHost` (`app/shelf-host.ts` for real,
 * `createFakeShelfHost` for tests).
 *
 * The page command is `nav.`, not `page.`: R2's core areas are a closed set enforced at boot, and
 * an unknown area blanks the app (B-87).
 */
import type { Command } from "../types.js";

export interface ShelfHost {
  /** Put block `blockId` on the shelf (it resolves the block's page itself). */
  openBlock(blockId: string): void | Promise<void>;
  /** Put the page the current route shows on the shelf. Off a page route (journals, search…)
   * there is no such page and this does nothing — `when` cannot see the route (WhenContext is a
   * closed set), the same limitation `edit.mergePage` documents. */
  openCurrentPage(): void;
}

export function createShelfCommands(deps: { shelf: ShelfHost }): Command[] {
  const { shelf } = deps;
  return [
    {
      id: "block.openOnShelf",
      title: "Open on shelf",
      description: "Keep this block beside the page you are reading",
      category: "Block",
      defaultKeys: {},
      when: "editorFocused || blockSelected",
      async run(ctx) {
        // The focused block, or the first of a selection — the block a right-click opened the
        // context menu on (right-click puts the caret there, `editor/BlockTree.tsx`).
        const id = ctx.focusedBlockId ?? ctx.selectedBlockIds[0] ?? null;
        if (id) await shelf.openBlock(id);
      },
    },
    {
      id: "nav.openPageOnShelf",
      title: "Open this page on shelf",
      description: "Keep the current page beside whatever you open next",
      category: "Navigation",
      defaultKeys: {},
      when: "true",
      run() {
        shelf.openCurrentPage();
      },
    },
  ];
}

export function createFakeShelfHost(): ShelfHost & {
  calls: Array<{ method: string; arg?: string }>;
} {
  const calls: Array<{ method: string; arg?: string }> = [];
  return {
    calls,
    openBlock(blockId) {
      calls.push({ method: "openBlock", arg: blockId });
    },
    openCurrentPage() {
      calls.push({ method: "openCurrentPage" });
    },
  };
}
