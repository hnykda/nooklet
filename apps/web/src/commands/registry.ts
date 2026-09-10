/**
 * The command registry (BUILD item 1): `register`/`unregister`/`list`/`get`. "Nothing bypasses
 * the registry" (R1) — every command, including the structural ones this package only delegates
 * to the editor, is registered here so the palette/keymap/slash-menu can find it.
 */

import type { Command } from "./types.js";
import { compileWhen, WhenClauseError } from "./when/index.js";

/** R2: one `area` segment, a dot, one `verb` segment (camelCase). Plugin ids additionally allow
 * dots after `plugin.<pluginId>.` (checked separately, see `isValidPluginId`), so this base
 * pattern intentionally allows any number of dot-separated camelCase segments; command-specific
 * shape rules (core areas vs. `plugin.<id>.<verb>`) are enforced by `validateCommandId`. */
const ID_RE = /^[a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*$/;
const PLUGIN_ID_RE = /^plugin\.[a-zA-Z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*$/;

const CORE_AREAS = new Set([
  "block",
  "task",
  "nav",
  "palette",
  "search",
  "format",
  "edit",
  "app",
  "sync",
]);

export class CommandRegistrationError extends Error {
  constructor(
    public readonly commandId: string,
    message: string,
  ) {
    super(`cannot register command '${commandId}': ${message}`);
    this.name = "CommandRegistrationError";
  }
}

function validateCommandId(id: string): void {
  if (id.startsWith("plugin.")) {
    if (!PLUGIN_ID_RE.test(id)) {
      throw new CommandRegistrationError(
        id,
        "plugin command ids must match 'plugin.<pluginId>.<verb>' (R2)",
      );
    }
    return;
  }
  if (!ID_RE.test(id)) {
    throw new CommandRegistrationError(
      id,
      "id must match '^[a-z][a-zA-Z0-9]*\\.[a-zA-Z][a-zA-Z0-9]*$' (R2)",
    );
  }
  const area = id.slice(0, id.indexOf("."));
  if (!CORE_AREAS.has(area)) {
    throw new CommandRegistrationError(
      id,
      `unrecognized core area '${area}' — core areas are ${[...CORE_AREAS].join(", ")} (R2)`,
    );
  }
}

export interface CommandRegistry {
  register(command: Command): void;
  unregister(id: string): void;
  get(id: string): Command | undefined;
  list(): Command[];
  has(id: string): boolean;
}

/** Create a fresh, empty registry. Tests should always use their own instance rather than a
 * shared module-level singleton, so a bad `when` string in one test's fixture can never leak into
 * another's. */
export function createCommandRegistry(): CommandRegistry {
  const commands = new Map<string, Command>();

  return {
    register(command) {
      validateCommandId(command.id);
      if (commands.has(command.id)) {
        throw new CommandRegistrationError(
          command.id,
          "a command with this id is already registered",
        );
      }
      if (command.when !== undefined) {
        try {
          compileWhen(command.when);
        } catch (err) {
          if (err instanceof WhenClauseError) {
            throw new CommandRegistrationError(
              command.id,
              `invalid \`when\` clause: ${err.message}`,
            );
          }
          throw err;
        }
      }
      commands.set(command.id, command);
    },

    unregister(id) {
      commands.delete(id);
    },

    get(id) {
      return commands.get(id);
    },

    list() {
      return [...commands.values()];
    },

    has(id) {
      return commands.has(id);
    },
  };
}
