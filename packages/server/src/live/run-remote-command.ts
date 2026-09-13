/**
 * The shared core of `ui.run`/`ui.navigate`/`ui.highlight` (ADR 015 §2.4/§2.5): resolve a
 * target window under the strict (refuse-to-guess) write policy, check `control_enabled`, and send
 * `command.run` over `/ui/live`. `ui.navigate`/`ui.highlight` are thin wrappers that just fix
 * `command_id`/`args` and reshape the output (ADR 015 §2.5: "share ui_run's not_found/
 * no_live_window/ambiguous_window error cases and add nothing new").
 *
 * Error-code note: the research this implements (`docs/research/09-live-ui-control.md` §2.5)
 * sketches illustrative error names `no_live_window`/`ambiguous_window`, but
 * `docs/spec/mcp-tools.md` §3.8 fixes a closed `OpErrorCode` enum with no such members ("There is
 * no separate ambiguous error code"). This implementation matches that house style: both cases use
 * the existing `not_found`/`conflict` codes, with `details.reason` carrying the more specific
 * machine-readable marker an agent can branch on, and a `hint` spelling out what to do.
 */

import { z } from "zod";
import { defineOp, OpError } from "../ops/registry.js";
import { BlockId } from "../ops/schemas.js";
import { DEFAULT_RPC_TIMEOUT_MS, sendRequest } from "./rpc.js";
import { resolveForWrite } from "./window-resolution.js";

export const ChangedSummary = z.object({
  created: z.array(BlockId),
  updated: z.array(BlockId),
  deleted: z.array(BlockId),
  seq: z.number().int().describe("Safe to pass to changes_since/batch_undo"),
});

export const RunCommandOutput = z.object({
  window_id: z.string(),
  when_result: z.enum(["ran", "skipped_when_false", "unknown_command", "not_permitted"]),
  result: z.unknown().optional(),
  changed: ChangedSummary.optional().describe("Present when the command produced graph mutations"),
});

export type RunCommandOutputT = z.output<typeof RunCommandOutput>;

interface CommandResultMessage {
  window_id?: string;
  when_result?: string;
  result?: unknown;
  changed?: unknown;
  /** Set instead of `when_result` when the command threw in the window (B-148). */
  error?: unknown;
}

/** Shared by all three ops' handlers (see file header). `windowId` is `input.window_id`, already
 * validated by each op's own Zod schema. */
export async function runRemoteCommand(
  ctx: import("../ops/registry.js").OpContext,
  args: { commandId: string; commandArgs?: unknown; windowId?: string },
): Promise<RunCommandOutputT> {
  const resolution = resolveForWrite(ctx.db, args.windowId);
  if (resolution.kind === "none") {
    throw new OpError(
      "not_found",
      "no nooklet window is currently open anywhere",
      "no live window to run a command in; use page_append/block_update to edit headlessly instead",
      { reason: "no_live_window" },
    );
  }
  if (resolution.kind === "not_found") {
    throw new OpError(
      "not_found",
      `no live window with id "${args.windowId}"`,
      "it may have just closed; call ui_windows again",
      { reason: "not_found" },
    );
  }
  if (resolution.kind === "ambiguous") {
    throw new OpError(
      "conflict",
      "more than one nooklet window is open; pick one",
      "call ui_windows to see the candidates, then pass window_id",
      {
        reason: "ambiguous_window",
        windows: resolution.windows.map((w) => ({
          window_id: w.windowId,
          device_id: w.deviceId,
          page: w.page?.name ?? null,
          last_active_at: new Date(w.lastActiveAt).toISOString(),
        })),
      },
    );
  }

  const { window } = resolution;
  if (!window.controlEnabled) {
    throw new OpError(
      "forbidden",
      `window "${window.windowId}" has not enabled remote control`,
      'ask the user to turn on "let agents control this window" for that window',
      { reason: "control_disabled" },
    );
  }

  const rpcResult = await sendRequest(
    ctx.db,
    window.ws,
    {
      type: "command.run",
      command_id: args.commandId,
      args: args.commandArgs,
      actor: ctx.actor.label,
      client: ctx.transport,
    },
    { timeoutMs: DEFAULT_RPC_TIMEOUT_MS },
  );
  if (rpcResult.timedOut) {
    throw new OpError(
      "internal",
      `window "${window.windowId}" did not respond in time`,
      "the window may be busy; check ui_windows and try again",
    );
  }

  const msg = rpcResult.data as CommandResultMessage;
  if (typeof msg.error === "string") {
    // The command ran and threw — most often it refused its args (`task.setScheduled` given
    // "banana"). The window used to send nothing at all, so this op waited out the timeout above
    // and told the agent to try again: the same input, failing the same way (B-148). `invalid`,
    // because retrying unchanged cannot help; the window's own message says what to change.
    throw new OpError(
      "invalid",
      `${args.commandId} failed in window "${window.windowId}": ${msg.error.slice(0, 1000)}`,
      "the command refused this call; change args (or command_id) rather than retrying as is",
      { reason: "command_failed", window_id: window.windowId },
    );
  }
  const whenResult = RunCommandOutput.shape.when_result.safeParse(msg.when_result);
  return {
    window_id: window.windowId,
    when_result: whenResult.success ? whenResult.data : "unknown_command",
    result: msg.result,
    changed: msg.changed as RunCommandOutputT["changed"],
  };
}

export const uiRun = defineOp({
  name: "ui.run",
  summary: "Run a command in a live window",
  description:
    "Runs a nooklet command in a live window - the same command ids the palette, slash menu, and " +
    "keybindings use. This is how an agent drives the actual UI a human has open, as opposed to " +
    "editing the graph headlessly. args shape depends on command_id. A command whose when clause " +
    "does not hold for the window's current state is skipped, not an error - check when_result. " +
    "Prefer ui_navigate/ui_highlight for the two most common cases (open a page; point at a " +
    "block) instead of calling this directly with nav.openPage/nav.revealBlock.",
  input: z
    .object({
      command_id: z
        .string()
        .regex(/^[a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*$/)
        .describe('e.g. "task.setMarkerDone", "block.zoomIn", "nav.openPage"'),
      args: z.unknown().optional(),
      window_id: z.string().optional(),
    })
    .strict(),
  output: RunCommandOutput,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  // Only ui:control at the op level (ADR 015 §2.5's table): the invoked command's own `when`
  // clause and `Command.remoteInvocable` flag are enforced client-side (ADR 015 §2.4) — the server
  // has no manifest of what a given command_id does, so it cannot itself check a finer per-command
  // scope. ADR 015's own "Consequences" section leaves a third, narrower ui:control tier as an
  // explicitly open question for exactly this reason.
  scopes: ["ui:control"],
  render: (out) => `${out.window_id}: ${out.when_result}`,
  handler: (input, ctx) =>
    runRemoteCommand(ctx, {
      commandId: input.command_id,
      commandArgs: input.args,
      windowId: input.window_id,
    }),
});
