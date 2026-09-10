/**
 * `ui.highlight` / `ui_highlight` (ADR 015 §2.5): a thin wrapper over
 * `ui_run('nav.revealBlock', { blockId })` for "point at Y without navigating away."
 */

import { z } from "zod";
import { defineOp } from "../ops/registry.js";
import { BlockId } from "../ops/schemas.js";
import { runRemoteCommand } from "./run-remote-command.js";

export const uiHighlight = defineOp({
  name: "ui.highlight",
  summary: "Point at a block in a live window without navigating away",
  description:
    "Scrolls to and briefly flashes one block in a live nooklet window, without changing the " +
    "human's current page/zoom/editing focus - use this to draw attention to a block you just " +
    "read or wrote, as opposed to ui_navigate which actually opens/zooms to it. Shares " +
    "ui_run's not_found/ambiguous-window error cases.",
  input: z
    .object({
      block_id: BlockId,
      window_id: z.string().optional(),
    })
    .strict(),
  output: z.object({ window_id: z.string() }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ["read", "ui:control"],
  render: (out) => `highlighted a block in window ${out.window_id}`,
  handler: async (input, ctx) => {
    const out = await runRemoteCommand(ctx, {
      commandId: "nav.revealBlock",
      commandArgs: { blockId: input.block_id },
      windowId: input.window_id,
    });
    return { window_id: out.window_id };
  },
});
