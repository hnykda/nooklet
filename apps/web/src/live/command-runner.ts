/**
 * Executes a `command.run` request from `/ui/live` (ADR 015 §2.4) through the app's REAL command
 * registry/context/exec — never a parallel path. `registry`/`buildContext` here are the exact
 * instances `<CommandProvider>` (`../commands/provider/CommandProvider.tsx`) already built for
 * keyboard/palette/toolbar dispatch (wired in `../app/CommandLayer.tsx`); this module only adds
 * the one thing `ctx.exec` does not do on its own — checking the command's `when` clause BEFORE
 * running it, exactly as `../commands/keymap/dispatch.ts#firstMatch` does for a keypress (`ctx.exec`
 * itself is deliberately `when`-blind, since every other caller already checked before calling it).
 */

import type { CommandContext, CommandRegistry } from "../commands/index.js";
import { matchesWhen } from "../commands/index.js";
import { flashRemoteTouch } from "./flash-bus.js";

export type WhenResult = "ran" | "skipped_when_false" | "unknown_command" | "not_permitted";

export interface CommandRunResult {
  when_result: WhenResult;
  result?: unknown;
}

export interface CommandRunDeps {
  registry: CommandRegistry;
  /** A fresh `WhenContext`/`CommandContext` base, read live — called twice (before and after
   * running the command) so the post-run flash heuristic below reflects the command's actual
   * effect, not a stale snapshot. */
  contextBase: () => Omit<CommandContext, "exec" | "args">;
  buildContext: (base: Omit<CommandContext, "exec" | "args">) => CommandContext;
  /** Best-effort: force an immediate sync push rather than waiting out the normal debounce (ADR
   * 015 §2.4 — "the whole reason a caller uses the live-UI channel instead of the headless tools
   * is speed"). Failures are swallowed; the command already ran regardless of whether this push
   * succeeds immediately or the next debounced push picks it up. */
  forceSync?: () => Promise<void>;
}

/**
 * Runs `commandId` with `args` exactly as a keybinding would: unknown id -> `unknown_command`
 * (not an error — the caller checks `when_result`); `remoteInvocable: false` -> `not_permitted`;
 * `when` false against the CURRENT, real focus state -> `skipped_when_false` (an expected outcome,
 * e.g. `task.setPriorityA` on a block that isn't a task, not a fault); otherwise runs it via the
 * same `ctx.exec` every other trigger uses, flashes whatever ended up focused/selected afterward
 * (the v1 heuristic for "attribute whatever this command touched" — see `./flash-bus.ts`), and
 * best-effort forces an immediate sync push.
 */
export async function runRemoteCommand(
  deps: CommandRunDeps,
  commandId: string,
  args: unknown,
): Promise<CommandRunResult> {
  const command = deps.registry.get(commandId);
  if (!command) return { when_result: "unknown_command" };
  if (command.remoteInvocable === false) return { when_result: "not_permitted" };

  const before = deps.contextBase();
  if (!matchesWhen(command.when, before)) return { when_result: "skipped_when_false" };

  const ctx = deps.buildContext(before);
  await ctx.exec(commandId, args);

  const after = deps.contextBase();
  if (after.focusedBlockId) {
    flashRemoteTouch(after.focusedBlockId);
  } else {
    for (const id of after.selectedBlockIds) flashRemoteTouch(id);
  }

  try {
    await deps.forceSync?.();
  } catch {
    // Best-effort only — see this function's doc comment.
  }

  return { when_result: "ran" };
}
