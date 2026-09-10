/**
 * `ui.navigate` / `ui_navigate` (ADR 015 §2.5): a thin wrapper over
 * `ui_run('nav.openPage', { page, blockId })` for the single most common remote action —
 * "go look at X" — so an agent never has to know the underlying command id.
 */

import { z } from "zod";
import { defineOp } from "../ops/registry.js";
import { BlockId, PageRef } from "../ops/schemas.js";
import { runRemoteCommand } from "./run-remote-command.js";

export const uiNavigate = defineOp({
  name: "ui.navigate",
  summary: "Open a page in a live window",
  description:
    "Opens a page (and optionally zooms to a block) in a live nooklet window - the same window a " +
    "human is looking at. Shares ui_run's not_found/ambiguous-window error cases: pass " +
    "window_id when more than one window might be open (see ui_windows).",
  input: z
    .object({
      page: PageRef,
      block_id: BlockId.optional().describe("Also zoom to this block"),
      window_id: z.string().optional(),
    })
    .strict(),
  output: z.object({ window_id: z.string(), page: z.string() }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ["read", "ui:control"],
  render: (out) => `opened ${out.page} in window ${out.window_id}`,
  handler: async (input, ctx) => {
    const out = await runRemoteCommand(ctx, {
      commandId: "nav.openPage",
      commandArgs: { page: input.page, blockId: input.block_id },
      windowId: input.window_id,
    });
    return { window_id: out.window_id, page: input.page };
  },
});
