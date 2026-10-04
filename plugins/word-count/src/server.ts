/**
 * `word-count`'s server half (M4's "worked example" built-in, `docs/spec/api-and-plugin-types.md`
 * §5): a `page.wordcount` op exposed over BOTH HTTP and MCP from one `defineOp` call
 * (`plugin.ops.register`), plus the same counting logic exposed over `plugin.rpc` so the client
 * half's status-bar item (`./client.ts`) can ask "how many words on the page I have open right
 * now" without duplicating the walk.
 *
 * Only the public `@nooklet/plugin-api` surface is used here — no import of `@nooklet/server`
 * internals — per M4's dogfooding requirement (PLAN §13 / the milestone's exit criterion).
 *
 * Refines the spec's worked example in one way: that example's handler calls only
 * `data.pages.get({ name: page })`, which does not actually resolve "today"/"yesterday"/
 * "tomorrow"/`YYYY-MM-DD` (`pages.journal`'s job, a separate `DataApi` method) despite the input
 * schema's own description promising it. A plugin only has `ctx.data` (not the core's internal
 * resolver `ops/resolve.ts` uses), so this falls back to `pages.journal` when a plain name lookup
 * misses, actually delivering what the description says.
 */

import type { BlockNode, ServerPluginModule } from "@nooklet/plugin-api";
import { defineOp, OpError } from "@nooklet/plugin-api";
import { z } from "zod";
import { countWords } from "./count.js";

interface WordCountResult {
  page: string;
  blockCount: number;
  wordCount: number;
}

/** The count, or `null` when no page answers to `pageRef`. */
async function countPage(
  data: import("@nooklet/plugin-api").DataApi,
  pageRef: string,
): Promise<WordCountResult | null> {
  let target = await data.pages.get({ name: pageRef });
  if (!target) {
    // `pages.journal` throws (rather than returning null) for a ref that isn't a valid
    // "today"/"yesterday"/"tomorrow"/`YYYY-MM-DD` — that's not an error for word-count's purposes,
    // just "this wasn't a journal reference either", so fall through to the not_found below.
    try {
      target = await data.pages.journal(pageRef);
    } catch {
      target = null;
    }
  }
  if (!target) return null;
  const tree = await data.blocks.tree({ page: target.id });
  let blockCount = 0;
  let wordCount = 0;
  const walk = (nodes: BlockNode[]): void => {
    for (const n of nodes) {
      blockCount++;
      wordCount += countWords(n.content);
      walk(n.children);
    }
  };
  walk(tree);
  return { page: target.name, blockCount, wordCount };
}

const WordCountInput = z
  .object({
    page: z.string().min(1).max(512).describe('Page name, journal date (YYYY-MM-DD), or "today"'),
  })
  .strict();
const WordCountOutput = z
  .object({ page: z.string(), block_count: z.number().int(), word_count: z.number().int() })
  .strict();

export default {
  async activate(plugin) {
    plugin.ops.register(
      defineOp({
        name: "page.wordcount",
        summary: "Count words in a page",
        description:
          "Counts words across all blocks of a page or journal day. Read-only and cheap; " +
          "call before deciding whether to read the full page.",
        input: WordCountInput,
        output: WordCountOutput,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        scopes: ["read"],
        // Plugin ops default to HTTP-only (mcp: false) — opt in explicitly to appear in tools/list.
        expose: { http: true, mcp: true },
        render: (out) => `${out.page}: ${out.word_count} words across ${out.block_count} blocks`,
        async handler({ page }, opCtx) {
          const result = await countPage(opCtx.data, page);
          if (!result) {
            // A caller asking by name (an agent, the API) gets a proper 404 with a hint.
            throw new OpError(
              "not_found",
              `no page named "${page}"`,
              'check the exact name with page.list, or pass a journal date / "today"',
            );
          }
          return {
            page: result.page,
            block_count: result.blockCount,
            word_count: result.wordCount,
          };
        },
      }),
    );

    // The client -> server bridge (api-and-plugin-types.md §5): a separate, plugin-owned channel
    // from `ctx.data`, so the status-bar item on the client half can reuse this exact counting
    // logic without going through HTTP + auth itself.
    plugin.rpc.expose("count", async (pageRef) => {
      if (typeof pageRef !== "string") throw new Error("count(pageRef: string) — missing pageRef");
      const result = await countPage(plugin.data, pageRef);
      // `null`, not a throw: the status bar asks about the page on screen, which can be one that
      // was just deleted (the client fires `page.changed` as it goes) or one not yet synced. A
      // throw here was an unhandled error in the rpc route — a 500 and a server-log stack trace
      // for an ordinary moment (B-610). "No such page" is an answer, not a failure.
      if (!result) return null;
      return { page: result.page, wordCount: result.wordCount, blockCount: result.blockCount };
    });
  },
} satisfies ServerPluginModule;
