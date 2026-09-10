/**
 * `docs/spec/api-and-plugin-types.md` §7.1. `Command`/`CommandKeys`/`Platform` are owned here and
 * reused verbatim by `docs/spec/commands-and-keymap.md` (the full default keymap, `when`-clause
 * grammar, and `keybindings.json` user-override format) and by `PluginContributes.commands`/
 * `ClientPluginContext.registerCommand` (`manifest.ts`, `client-context.ts`). This module fixes
 * only the type shape; the exhaustive core command table is that other spec's to write.
 */
import type { EditorApi } from "./client-context.js";
import type { Json } from "./json.js";
import type { Origin } from "./op-def.js";

export type Platform = "mac" | "win" | "linux";

/** "Mod" = Cmd on mac, Ctrl on win/linux. Set `default` for the common case; override per-platform
 * only when the keys genuinely differ. */
export interface CommandKeys {
  default?: string;
  mac?: string;
  win?: string;
  linux?: string;
}

export interface Command {
  /** "area.verb" — same shape as an op name, but commands and ops are never compared or
   * deduplicated against each other (rule 20). */
  id: string;
  title: string;
  description: string;
  /** Palette grouping, e.g. "Navigation" | "Editing" | "Tasks" | "Properties" | "Search" | "Sync" |
   * "Settings", or a plugin-defined category. */
  category: string;
  /**
   * A boolean expression string over host-defined context keys (editorFocus, blockSelected, ...).
   * The full grammar and context-key list are owned by `commands-and-keymap.md`; this type fixes
   * only the field's type (string, evaluated by the host).
   */
  when?: string;
  defaultKeys?: CommandKeys;
  run(
    args: Json | undefined,
    info: { editor?: EditorApi; origin: Origin },
  ): Json | void | Promise<Json | void>;
}
