/**
 * `ui.windows` / `ui_windows` (ADR 015 §2.5): list every currently-connected `/ui/live` window
 * across all of this graph's devices. Never errors except `internal` — an empty result is a
 * normal, common state (nobody has nooklet open right now), not a fault.
 */

import { z } from "zod";
import { defineOp } from "../ops/registry.js";
import { listWindows } from "./registry.js";
import { WindowSummary } from "./schemas.js";
import { toWindowSummary } from "./wire.js";

export const uiWindows = defineOp({
  name: "ui.windows",
  summary: "List live nooklet windows",
  description:
    "Lists the nooklet windows currently connected and visible to a human right now, across all " +
    "of this graph's devices. Returns an empty list if nobody has nooklet open; that is a normal " +
    "result, not an error. Use this before ui_run/ui_navigate if you are unsure whether more than " +
    "one window is open.",
  input: z.object({}).strict(),
  output: z.object({
    live: z.boolean().describe("false if no window is currently open anywhere"),
    windows: z.array(WindowSummary),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  // ADR 015 §7: `ui:control` is required by every ui_* tool, in addition to whatever read/write
  // scope it separately needs (`../ops/registry.ts`'s `Permission` doc comment explains why this
  // is a plain fourth scope value rather than a parallel capability system).
  scopes: ["read", "ui:control"],
  render: (out) =>
    out.live
      ? `${out.windows.length} live nooklet window(s)`
      : "no nooklet window is currently open anywhere",
  handler: (_input, ctx) => {
    const windows = listWindows(ctx.db).map((w) => toWindowSummary(ctx.db, w));
    return { live: windows.length > 0, windows };
  },
});
