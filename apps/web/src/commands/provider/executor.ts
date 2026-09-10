/**
 * Builds a `CommandContext`'s `exec` closure: the ONE path every trigger (keybinding, palette,
 * slash menu, toolbar, menu, another command) runs a command through (R4, R71). Recording MRU
 * here — not in each surface — is what makes R71's "updated whenever a command successfully runs
 * via `ctx.exec` (any trigger)" true by construction rather than by every caller remembering to.
 */

import type { MruStore } from "../ranking/mru.js";
import type { CommandRegistry } from "../registry.js";
import type { CommandContext } from "../types.js";

/** Build a full `CommandContext` from everything but `exec`/`args`. `base`'s fields are read
 * fresh by the caller each time (a `WhenContext` snapshot per the Definitions section: "computed
 * fresh before every keydown dispatch and before every palette/menu render") — this function just
 * wires `exec` on top of whatever snapshot it's given. */
export function createCommandContext(
  base: Omit<CommandContext, "exec" | "args">,
  registry: CommandRegistry,
  mru: MruStore,
): CommandContext {
  const ctx: CommandContext = {
    ...base,
    args: undefined,
    async exec(commandId, args) {
      const command = registry.get(commandId);
      if (!command) return;
      const invocationCtx: CommandContext = args !== undefined ? { ...ctx, args } : ctx;
      await command.run(invocationCtx);
      mru.record("command", commandId);
    },
  };
  return ctx;
}
