/**
 * Assembles the runtime keymap (R64): base defaults, then secondary defaults, then user
 * `keybindings.json` rows applied in array order (additions and `-`-prefixed removals, R65-R66).
 * Built once per load for one concrete `platform` (R64: "assembled once per load"), so unlike
 * `Command.defaultKeys` (which always carries both platform slots), every `ResolvedBinding` this
 * module produces already belongs to exactly one session's platform — a user row that doesn't
 * apply to the current platform simply contributes zero rows.
 */
import type {
  Command,
  KeybindingEntry,
  KeybindingsFile,
  ResolvedBinding,
  WhenContext,
} from "../types.js";
import { parseSingleToken, resolveKeyToken } from "./notation.js";
import { SECONDARY_DEFAULTS } from "./secondary-defaults.js";

export interface BuildKeymapOptions {
  platform: WhenContext["platform"];
  /** Default `true` (desktop). Only matters for `ios`/`android`, where R14 says neither
   * `defaultKeys` slot resolves without an attached hardware keyboard. */
  hasHardwareKeyboard?: boolean;
}

/** R14: does `slot` ("mac" | "other") resolve for `platform` (+ keyboard presence)? mac/windows/
 * linux are desktop-only platforms in this taxonomy and always have a keyboard; ios/android need
 * one attached. An iPad hardware keyboard carries a Cmd-equivalent key, so ios-with-keyboard maps
 * to the "mac" slot (R14: "`other` is the fallback whenever `mac` does not apply"); an Android
 * hardware keyboard has no such key, so android-with-keyboard maps to "other". */
function slotResolves(
  slot: "mac" | "other",
  platform: WhenContext["platform"],
  hasHardwareKeyboard: boolean,
): boolean {
  switch (platform) {
    case "mac":
      return slot === "mac";
    case "windows":
    case "linux":
      return slot === "other";
    case "ios":
      return hasHardwareKeyboard && slot === "mac";
    case "android":
      return hasHardwareKeyboard && slot === "other";
    default:
      return false;
  }
}

/** `true` iff any chord step of `token` (already fully resolved — no `Mod`) carries an explicit
 * `Cmd` modifier. Used for R63's "a resolved token ... applies only on the platform it names":
 * `Cmd` names mac exclusively; every other explicit modifier/base key is a physical key present
 * on every platform's keyboard, so a token like `Ctrl+D` "applies literally on every platform,
 * including mac" (R63's worked example). */
function namesMacOnly(token: string): boolean {
  return token
    .trim()
    .split(/\s+/)
    .some((step) => parseSingleToken(step).mods.cmd);
}

function tokenHasMod(token: string): boolean {
  return token
    .trim()
    .split(/\s+/)
    .some((step) => parseSingleToken(step).mod);
}

/** Resolve one `KeybindingEntry.key` (R63's three shapes) to the single literal token that
 * applies for this session's platform, or `null` if the row doesn't apply at all. */
function resolveUserKey(
  key: KeybindingEntry["key"],
  platform: WhenContext["platform"],
  hasHardwareKeyboard: boolean,
): string | null {
  if (typeof key === "string") {
    if (tokenHasMod(key)) return resolveKeyToken(key, platform);
    if (namesMacOnly(key)) {
      return slotResolves("mac", platform, hasHardwareKeyboard)
        ? resolveKeyToken(key, platform)
        : null;
    }
    return resolveKeyToken(key, platform);
  }
  // Platform-pair object: pick whichever slot resolves for this session.
  if (slotResolves("mac", platform, hasHardwareKeyboard) && key.mac !== undefined) {
    return resolveKeyToken(key.mac, platform);
  }
  if (slotResolves("other", platform, hasHardwareKeyboard) && key.other !== undefined) {
    return resolveKeyToken(key.other, platform);
  }
  return null;
}

export function buildKeymap(
  commands: readonly Command[],
  userRows: KeybindingsFile,
  opts: BuildKeymapOptions,
): ResolvedBinding[] {
  const platform = opts.platform;
  const hasHardwareKeyboard = opts.hasHardwareKeyboard ?? true;
  let order = 0;
  const rows: ResolvedBinding[] = [];

  // 1. Base defaults: one row per command per resolved platform slot (R64 step 1).
  for (const cmd of commands) {
    for (const slot of ["mac", "other"] as const) {
      const raw = cmd.defaultKeys[slot];
      if (raw === undefined) continue;
      if (!slotResolves(slot, platform, hasHardwareKeyboard)) continue;
      rows.push({
        key: resolveKeyToken(raw, platform),
        command: cmd.id,
        when: cmd.when,
        source: "base",
        order: order++,
      });
    }
  }

  // 2. Secondary defaults (R64 step 2).
  for (const sec of SECONDARY_DEFAULTS) {
    rows.push({
      key: resolveKeyToken(sec.key, platform),
      command: sec.command,
      when: sec.when,
      source: "secondary",
      order: order++,
    });
  }

  // 3. User rows, applied in array order (R64 step 3 / R65-R66).
  const commandById = new Map(commands.map((c) => [c.id, c] as const));
  for (const entry of userRows) {
    const resolvedKey = resolveUserKey(entry.key, platform, hasHardwareKeyboard);
    if (resolvedKey === null) continue;

    const isRemoval = entry.command.startsWith("-");
    if (isRemoval) {
      const targetCommand = entry.command.slice(1);
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i] as ResolvedBinding;
        if (row.key !== resolvedKey || row.command !== targetCommand) continue;
        // R66: an explicit `when` on the removal row removes only that exact `when` string;
        // omitted `when` removes every row for that key+command regardless of its `when`.
        if (entry.when !== undefined && row.when !== entry.when) continue;
        rows.splice(i, 1);
      }
      continue; // A removal row with no matching row is a no-op (R66), never adds a candidate.
    }

    // R65: an addition. Omitted `when` inherits the target command's own `when` (not "always");
    // an explicit `when` on the row replaces it for this binding only.
    const targetCommand = entry.command;
    const when = entry.when !== undefined ? entry.when : commandById.get(targetCommand)?.when;
    rows.push({
      key: resolvedKey,
      command: targetCommand,
      when,
      source: "user",
      order: order++,
      args: entry.args,
    });
  }

  return rows;
}
