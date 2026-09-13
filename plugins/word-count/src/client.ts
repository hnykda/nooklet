/**
 * `word-count`'s client half: a status-bar item showing the word count of the currently open
 * page, refreshed whenever the open page (or its content) changes. Gets its number from the
 * SERVER half's `rpc.expose("count", ...)` (`./server.ts`) over `ctx.rpc.call` — never
 * re-implements the walk client-side, and never touches `ctx.data` for this (that facade is for
 * blocks/pages/query, not a plugin's own custom logic).
 *
 * Listens to the client-only `page.changed` rather than `page.opened` + `block.created`/
 * `block.updated`/`block.deleted`: the client host cannot deliver the block events with real
 * payloads (ADR 023), `page.opened` says nothing when you leave a page for the journals (the count
 * would stay up for a page no longer shown), and `page.changed` also fires when the server catches
 * up with a local edit — exactly when a count read through the server becomes right again.
 */
import type { ClientPluginModule } from "@nooklet/plugin-api";

// A `type`, not an `interface`: `rpc.call<T extends Json>` needs an index-signature-compatible
// shape, and TypeScript only grants that to type aliases. This file had never been typechecked —
// it was bundled by esbuild, which strips types — until the web build started compiling it.
type CountResult = {
  page: string;
  wordCount: number;
  blockCount: number;
};

export default {
  async activate(ctx) {
    ctx.registerStatusItem({
      id: "word-count",
      mount(el) {
        let disposed = false;
        // Responses can arrive out of order (open page A, then B, A's answer lands last); only the
        // latest request may write.
        let latest = 0;
        el.textContent = "";

        const refresh = async (): Promise<void> => {
          const page = ctx.editor.currentPage();
          const request = ++latest;
          if (!page || disposed) {
            el.textContent = "";
            return;
          }
          try {
            const result = await ctx.rpc.call<CountResult>("count", page.name);
            if (disposed || request !== latest) return;
            el.textContent = `${result.wordCount} ${result.wordCount === 1 ? "word" : "words"}`;
            el.title = `${result.blockCount} ${result.blockCount === 1 ? "block" : "blocks"} on ${result.page}`;
          } catch (e) {
            // A page that exists locally but has not reached the server yet is a 404 there: say
            // nothing rather than a stale number for the previous page.
            if (!disposed && request === latest) el.textContent = "";
            ctx.log.warn("word-count: failed to refresh count:", e);
          }
        };

        void refresh();
        const changed = ctx.on("page.changed", () => void refresh());

        return {
          dispose() {
            disposed = true;
            changed.dispose();
          },
        };
      },
    });
  },
} satisfies ClientPluginModule;
