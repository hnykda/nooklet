/**
 * R15 key-token notation: parsing, platform resolution (`Mod` -> `Cmd`/`Ctrl`), canonical
 * ordering, chords, and converting a real `KeyboardEvent` into the same literal token format so
 * dispatch (`dispatch.ts`) can do a plain string lookup with no further platform logic.
 */
import type { WhenContext } from "../types.js";
import { resolveModForPlatform } from "./platform.js";

export interface ModifierFlags {
  cmd: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

const NAMED_BASE_KEYS = new Set([
  "Enter",
  "Escape",
  "Tab",
  "Backspace",
  "Delete",
  "Up",
  "Down",
  "Left",
  "Right",
  "Space",
  "Home",
  "End",
]);

const PUNCTUATION_BASE_KEYS = new Set([".", ",", "[", "]", "\\", "/"]);

function isValidBaseKey(base: string): boolean {
  if (NAMED_BASE_KEYS.has(base)) return true;
  if (PUNCTUATION_BASE_KEYS.has(base)) return true;
  if (base.length === 1 && /[A-Z0-9]/.test(base)) return true;
  return false;
}

/** Join modifier flags + base into the canonical `Mod, Alt, Shift` order (R15). `cmd`/`ctrl` are
 * mutually meaningful (a resolved token has at most one of them set; a hand-built one that sets
 * both — a literal `Cmd+Ctrl+X` chord step — still orders Cmd before Ctrl deterministically). */
export function formatKey(mods: ModifierFlags, base: string): string {
  const parts: string[] = [];
  if (mods.cmd) parts.push("Cmd");
  if (mods.ctrl) parts.push("Ctrl");
  if (mods.alt) parts.push("Alt");
  if (mods.shift) parts.push("Shift");
  parts.push(base);
  return parts.join("+");
}

export interface ParsedToken {
  mod: boolean;
  mods: ModifierFlags;
  base: string;
}

export class KeyNotationError extends Error {
  constructor(
    message: string,
    public readonly token: string,
  ) {
    super(`${message}: '${token}'`);
    this.name = "KeyNotationError";
  }
}

/** Parse one (non-chord) key-token step into its modifier flags + base key. Exported for
 * `build.ts`, which needs to inspect whether a fully-resolved user token names `Mod`/`Cmd`
 * explicitly (R63's platform-applicability rule) without re-implementing this parsing. */
export function parseSingleToken(token: string): ParsedToken {
  const parts = token.split("+");
  if (parts.length < 1 || parts.some((p) => p.length === 0)) {
    throw new KeyNotationError("invalid key token", token);
  }
  const base = parts[parts.length - 1] as string;
  const mods: ModifierFlags = { cmd: false, ctrl: false, alt: false, shift: false };
  let mod = false;
  for (const m of parts.slice(0, -1)) {
    switch (m) {
      case "Mod":
        mod = true;
        break;
      case "Cmd":
        mods.cmd = true;
        break;
      case "Ctrl":
        mods.ctrl = true;
        break;
      case "Alt":
        mods.alt = true;
        break;
      case "Shift":
        mods.shift = true;
        break;
      default:
        throw new KeyNotationError(`unknown modifier '${m}' in key token`, token);
    }
  }
  if (!isValidBaseKey(base)) {
    throw new KeyNotationError(`unrecognized base key '${base}' in key token`, token);
  }
  return { mod, mods, base };
}

/** Resolve one (non-chord) key token to its canonical, platform-concrete form (R15): substitutes
 * a neutral `Mod` for `Cmd`/`Ctrl` per platform and reorders modifiers to the canonical
 * `Mod, Alt, Shift` sequence. A token with an explicit `Cmd`/`Ctrl` (no `Mod`) is platform-
 * independent by design — R63's worked example: a literal `Ctrl+D` row "applies literally on
 * every platform, including mac", so this function must NOT touch an already-explicit modifier. */
export function resolveSingleKeyToken(token: string, platform: WhenContext["platform"]): string {
  const { mod, mods, base } = parseSingleToken(token);
  const resolved: ModifierFlags = { ...mods };
  if (mod) {
    if (resolveModForPlatform(platform) === "Cmd") resolved.cmd = true;
    else resolved.ctrl = true;
  }
  return formatKey(resolved, base);
}

/** Resolve a possibly-chorded token (space-separated key steps, per the spec's "Chord"
 * definition) to its canonical form, one resolved step per chord, joined by a single space. */
export function resolveKeyToken(token: string, platform: WhenContext["platform"]): string {
  return token
    .trim()
    .split(/\s+/)
    .map((part) => resolveSingleKeyToken(part, platform))
    .join(" ");
}

/** `true` iff `token` contains more than one space-separated step (the spec's "Chord"). */
export function isChord(token: string): boolean {
  return token.trim().split(/\s+/).length > 1;
}

/** The individual chord steps of an already-resolved (or still-neutral) token, in order. */
export function chordSteps(token: string): string[] {
  return token.trim().split(/\s+/);
}

// ── Event -> token ────────────────────────────────────────────────────────────────────────────

const ARROW_MAP: Record<string, string> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};

const PLAIN_NAMED_KEYS = new Set(["Enter", "Escape", "Tab", "Backspace", "Delete", "Home", "End"]);

/** The subset of `KeyboardEvent` this module needs — kept minimal so tests can pass a plain
 * object instead of constructing a real DOM event. */
export interface KeyboardEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Map a raw `KeyboardEvent.key` to this notation's base-key vocabulary. Returns `null` for a
 * bare modifier keypress or any key outside R15's vocabulary (function keys, media keys, IME
 * composition keys, etc.) — such an event simply cannot match any binding. */
export function baseKeyFromEvent(e: Pick<KeyboardEventLike, "key">): string | null {
  const k = e.key;
  if (k === "Shift" || k === "Control" || k === "Alt" || k === "Meta") return null;
  const arrow = ARROW_MAP[k];
  if (arrow !== undefined) return arrow;
  if (k === " ") return "Space";
  if (PLAIN_NAMED_KEYS.has(k)) return k;
  if (k.length === 1) {
    if (/[a-zA-Z]/.test(k)) return k.toUpperCase();
    if (/[0-9]/.test(k) || PUNCTUATION_BASE_KEYS.has(k)) return k;
  }
  return null;
}

/** Build the literal chord-step token for one physical keydown. No platform parameter is needed:
 * `metaKey`/`ctrlKey` already tell us exactly which physical modifier was held, so the result is
 * already a resolved/literal token in this notation — `Mod` only ever appears in *authored*
 * `keybindings.json` rows, never in a token derived from a live event. */
export function keyTokenFromEvent(e: KeyboardEventLike): string | null {
  const base = baseKeyFromEvent(e);
  if (base === null) return null;
  return formatKey({ cmd: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey }, base);
}
