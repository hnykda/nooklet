/**
 * M7 refactor commands (research/13 §4.2 items 3-4; ADR 020): "Turn into page" and "Move to
 * page…" for the bullet context menu, "Merge this page into…" and "Find and replace…" for the
 * palette. Like every other registration here they are host-agnostic: the actual work — a server
 * op call, a page picker, a route change — goes through `RefactorHost`, which `app/refactor-host.tsx`
 * implements for real and `createFakeRefactorHost()` fakes for the tests.
 *
 * The block commands act on the focused block, or on the first selected one when nothing is
 * being edited — the same block the context menu opened on (right-click puts the caret there,
 * `editor/BlockTree.tsx`'s `onContextMenu`).
 */
import type { Command, CommandContext } from "../types.js";

export interface RefactorHost {
  /** Turn `blockId` into a page (the server's `block.to_page`). */
  turnBlockIntoPage(blockId: string): Promise<void>;
  /** Move `blockId`'s subtree to the end of page `page` (`block.move_to_page`). */
  moveBlockToPage(blockId: string, page: string): Promise<void>;
  /** Merge page `source` into page `target` (`page.merge`) and open `target`. */
  mergePageInto(source: string, target: string): Promise<void>;
  /** Ask the person for a page name with a fuzzy picker; `null` when dismissed. */
  pickPage(opts: { title: string; allowCreate: boolean }): Promise<string | null>;
  /** The page the current route shows, or `null` off a page route (journals, search…). */
  currentPageName(): string | null;
  /** Open the Find & Replace view. */
  openFindReplace(): void;
}

function targetBlock(ctx: CommandContext): string | null {
  return ctx.focusedBlockId ?? ctx.selectedBlockIds[0] ?? null;
}

/**
 * "Turn into page" REWRITES the block under the caret (its text becomes `[[First line]]`), and
 * `BlockTree` never pushes a refetched text into the buffer being typed into (it cannot tell a
 * stale read from an external change, B-66). Left in edit mode, the editor kept showing the old
 * first line, and the next keystroke wrote it back over the link — seen in a probe on 2026-09-13
 * (`"[[Probe kickoff]]"` became `"Probe kickoff typed"`); B-192. `block.selectBlock` ends editing
 * before the op, so the row renders from the tree. "Move to page…" needs no such step: the block
 * leaves the page, and the tree ends editing on its own when it does (B-88).
 */
async function leaveEditing(ctx: CommandContext): Promise<void> {
  if (ctx.editorFocused) await ctx.exec("block.selectBlock");
}

export function createRefactorCommands(deps: { refactor: RefactorHost }): Command[] {
  const { refactor } = deps;
  return [
    {
      id: "block.turnIntoPage",
      title: "Turn into page",
      description: "First line becomes a page; children become its blocks; this block links to it",
      category: "Block",
      defaultKeys: {},
      when: "editorFocused || blockSelected",
      async run(ctx) {
        const id = targetBlock(ctx);
        if (!id) return;
        await leaveEditing(ctx);
        await refactor.turnBlockIntoPage(id);
      },
    },
    {
      id: "block.moveToPage",
      title: "Move to page…",
      description: "Move this block and its children to the end of another page",
      category: "Block",
      defaultKeys: {},
      when: "editorFocused || blockSelected",
      async run(ctx) {
        const id = targetBlock(ctx);
        if (!id) return;
        const page = await refactor.pickPage({ title: "Move to page", allowCreate: true });
        if (!page) return;
        // No `leaveEditing`: the block leaves this page, and `BlockTree` ends editing when the pull
        // takes it away (B-88).
        await refactor.moveBlockToPage(id, page);
      },
    },
    {
      // `edit.`, not `page.`: R2's core areas are a closed set the registry enforces at boot, and
      // an unknown area is a thrown CommandRegistrationError before the first render — a blank
      // app (B-87). Same for `search.findReplace` below.
      id: "edit.mergePage",
      title: "Merge this page into…",
      description: "Move every block to another page, rewrite links, keep the name as an alias",
      category: "App",
      defaultKeys: {},
      when: "true",
      async run() {
        // `when` cannot see the route (WhenContext is a closed set), so this is checked here: off
        // a page there is nothing to merge and the command quietly does nothing.
        const source = refactor.currentPageName();
        if (!source) return;
        const target = await refactor.pickPage({
          title: `Merge "${source}" into`,
          allowCreate: false,
        });
        if (target) await refactor.mergePageInto(source, target);
      },
    },
    {
      id: "search.findReplace",
      title: "Find and replace…",
      description: "Search every block for text or a pattern and replace all, undoably",
      category: "Navigation",
      defaultKeys: {},
      when: "true",
      run() {
        refactor.openFindReplace();
      },
    },
  ];
}

export function createFakeRefactorHost(opts?: { pick?: string | null; page?: string | null }): {
  host: RefactorHost;
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = (method: string, ...args: unknown[]): void => {
    calls.push({ method, args });
  };
  const host: RefactorHost = {
    async turnBlockIntoPage(blockId) {
      record("turnBlockIntoPage", blockId);
    },
    async moveBlockToPage(blockId, page) {
      record("moveBlockToPage", blockId, page);
    },
    async mergePageInto(source, target) {
      record("mergePageInto", source, target);
    },
    async pickPage(o) {
      record("pickPage", o);
      return opts?.pick ?? null;
    },
    currentPageName() {
      return opts?.page ?? null;
    },
    openFindReplace() {
      record("openFindReplace");
    },
  };
  return { host, calls };
}
