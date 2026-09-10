/**
 * `ui.state` / `ui_state` (ADR 015 §2.3/§2.5): what is on screen right now in one (or the
 * most-recently-active) window. Reads never guess-and-fail the way `ui_run` does — with several
 * windows open and no `window_id`, this resolves to the most-recently-active one and lists the
 * rest in `other_windows` (ADR 015 §2's read-vs-write asymmetry).
 */

import { z } from "zod";
import { defineOp, OpError } from "../ops/registry.js";
import { DEFAULT_RPC_TIMEOUT_MS, sendRequest } from "./rpc.js";
import { OtherWindow, UiWindowState } from "./schemas.js";
import { resolveForRead } from "./window-resolution.js";
import { toOtherWindow } from "./wire.js";

export const uiState = defineOp({
  name: "ui.state",
  summary: "What is on screen right now",
  description:
    "Reads what a human is currently looking at in a live nooklet window: which page, which " +
    "block is focused or selected, cursor position, scroll position, open panels/dialogs. Omit " +
    "window_id if you expect exactly one window open; if several are open the response is " +
    "resolved to the most-recently-active one and lists the others in other_windows so you can " +
    "target a specific one next time. If no window is open anywhere, this returns live: false - " +
    "not an error; the data tools (search, page_read, ...) work the same whether or not anyone " +
    "has nooklet open.",
  input: z
    .object({
      window_id: z.string().optional().describe("From ui_windows; omit to auto-resolve"),
    })
    .strict(),
  output: z.object({
    live: z.boolean(),
    window_id: z.string().optional(),
    resolved_by: z.enum(["only_window", "most_recently_active", "requested"]).optional(),
    reachable: z
      .boolean()
      .optional()
      .describe(
        "false if the window did not answer within ~2s (busy tab, navigating); state is absent " +
          "in that case. Not an error - retry, or check ui_windows.",
      ),
    state: UiWindowState.optional().describe(
      "Absent when live is false or the window is unreachable",
    ),
    other_windows: z
      .array(OtherWindow)
      .optional()
      .describe("Present when more than one window was live and window_id was auto-resolved"),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ["read", "ui:control"],
  render: (out) => {
    if (!out.live) return "no nooklet window is currently open anywhere";
    if (out.reachable === false) return `window ${out.window_id} did not answer in time`;
    return `state of window ${out.window_id}${out.state?.page ? ` (${out.state.page.name})` : ""}`;
  },
  handler: async (input, ctx) => {
    const resolution = resolveForRead(ctx.db, input.window_id);
    if (resolution.kind === "none") return { live: false };
    if (resolution.kind === "not_found") {
      throw new OpError(
        "not_found",
        `no live window with id "${input.window_id}"`,
        "it may have just closed; call ui_windows again",
      );
    }
    const { window, resolvedBy, others } = resolution;
    const otherWindows = others.length > 0 ? others.map(toOtherWindow) : undefined;

    const result = await sendRequest(
      ctx.db,
      window.ws,
      { type: "state.get" },
      {
        timeoutMs: DEFAULT_RPC_TIMEOUT_MS,
      },
    );
    if (result.timedOut) {
      return {
        live: true,
        window_id: window.windowId,
        resolved_by: resolvedBy,
        reachable: false,
        other_windows: otherWindows,
      };
    }
    const msg = result.data as { state?: unknown };
    return {
      live: true,
      window_id: window.windowId,
      resolved_by: resolvedBy,
      reachable: true,
      state: msg.state as z.output<typeof UiWindowState>,
      other_windows: otherWindows,
    };
  },
});
