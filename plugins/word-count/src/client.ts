/**
 * `word-count`'s client half: a status-bar item showing the word count of the currently open
 * page, refreshed on `block.*`/`page.*` change events and whenever the editor opens a different
 * page. Gets its number from the SERVER half's `rpc.expose("count", ...)` (`./server.ts`) over
 * `ctx.rpc.call` — never re-implements the walk client-side, and never touches `ctx.data` for
 * this (that facade is for blocks/pages/query, not a plugin's own custom logic).
 */
import type { ClientPluginModule, Disposable } from "@nooklet/plugin-api";

interface CountResult {
  page: string;
  wordCount: number;
  blockCount: number;
}

export default {
  async activate(ctx) {
    ctx.registerStatusItem({
      id: "word-count",
      mount(el) {
        let disposed = false;
        el.textContent = "";

        const refresh = async (): Promise<void> => {
          const page = ctx.editor.currentPage();
          if (!page || disposed) {
            el.textContent = "";
            return;
          }
          try {
            const result = await ctx.rpc.call<CountResult>("count", page.name);
            if (!disposed) el.textContent = `${result.wordCount} words`;
          } catch (e) {
            ctx.log.warn("word-count: failed to refresh count:", e);
          }
        };

        void refresh();
        const subs: Disposable[] = [
          ctx.on("page.opened", () => void refresh()),
          ctx.on("block.created", () => void refresh()),
          ctx.on("block.updated", () => void refresh()),
          ctx.on("block.deleted", () => void refresh()),
        ];

        return {
          dispose() {
            disposed = true;
            for (const s of subs) s.dispose();
          },
        };
      },
    });
  },
} satisfies ClientPluginModule;
