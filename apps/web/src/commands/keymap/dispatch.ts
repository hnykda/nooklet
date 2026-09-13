/**
 * `handleKeyDown` — the single entry point the editor/app calls on every keydown (BUILD item 2 /
 * R12-R13). Implements the fixed dispatch order: composing passthrough, autocomplete-popup
 * passthrough for its own keys, chord resolution over the compiled keymap (R63's 1500ms window),
 * then "not handled."
 */
import type { CommandContext, ResolvedBinding } from "../types.js";
import { matchesWhen } from "../when/index.js";
import { chordSteps, type KeyboardEventLike, keyTokenFromEvent } from "./notation.js";

/** R63: "matched over a 1500ms window between key presses (exceeding it cancels the
 * chord-in-progress with no effect)". */
const CHORD_WINDOW_MS = 1500;

/** R12 step 2: while an autocomplete/slash popup is open, these keys belong to
 * `@codemirror/autocomplete`'s own keymap, never the command layer. Checked against the raw
 * `KeyboardEvent.key` (e.g. "ArrowUp"), not this module's normalized "Up" token vocabulary. */
const POPUP_PASSTHROUGH_KEYS = new Set(["Escape", "Enter", "ArrowUp", "ArrowDown", "Tab"]);

export interface DispatchableKeyboardEvent extends KeyboardEventLike {
  preventDefault(): void;
}

export interface DispatcherDeps {
  /** Live accessor so a keybindings.json edit is picked up on the very next keydown without
   * reconstructing the dispatcher. */
  getBindings: () => readonly ResolvedBinding[];
  /** Injectable clock for chord-window tests. */
  now?: () => number;
  /** R12 step 2, precisely: is this key the open popup's? Consulted only while `popupOpen`.
   * Defaults to "any of the popup keys, whatever the modifiers"; the provider passes
   * `popup-keys.ts#popupTakesKey`, which knows that a popup the editor feeds never receives a
   * Cmd/Ctrl/Alt key, so yielding one to it drops the key on the floor (B-203). */
  popupTakesKey?: (event: KeyboardEventLike) => boolean;
}

interface PendingChord {
  steps: string[];
  startedAt: number;
}

export interface Dispatcher {
  handleKeyDown(event: DispatchableKeyboardEvent, ctx: CommandContext): boolean;
  /** Test/debug hook: discard any in-progress chord. */
  resetChord(): void;
}

/**
 * R33: commands whose keybinding row only DISPLAYS a gesture the browser implements itself. They
 * stay in the compiled keymap (the palette, Help → Keyboard shortcuts and the settings UI list them)
 * but are never matched here. `edit.paste`'s Cmd/Ctrl+V is the native paste: the editor handles the
 * `paste` EVENT that key produces (`editor/surface.ts`). Matching the key called `preventDefault()`,
 * which cancels that event, and ran a command with no editor side — so Cmd+V into a block pasted
 * nothing, in a browser and in the desktop app alike (B-536).
 */
const NATIVE_GESTURE_COMMANDS: ReadonlySet<string> = new Set(["edit.paste"]);

function candidatesForKey(bindings: readonly ResolvedBinding[], key: string): ResolvedBinding[] {
  const matching = bindings.filter((b) => b.key === key && !NATIVE_GESTURE_COMMANDS.has(b.command));
  // R12 step 3: "user rows, reverse array order, then secondary defaults, then base defaults."
  const user = [...matching.filter((b) => b.source === "user")].sort((a, b) => b.order - a.order);
  const secondary = [...matching.filter((b) => b.source === "secondary")].sort(
    (a, b) => a.order - b.order,
  );
  const base = [...matching.filter((b) => b.source === "base")].sort((a, b) => a.order - b.order);
  return [...user, ...secondary, ...base];
}

function firstMatch(
  bindings: readonly ResolvedBinding[],
  key: string,
  ctx: CommandContext,
): ResolvedBinding | undefined {
  for (const row of candidatesForKey(bindings, key)) {
    if (matchesWhen(row.when, ctx)) return row;
  }
  return undefined;
}

/** Multi-step chord bindings whose steps start with `prefix`, in order (strictly longer). */
function chordsStartingWith(
  bindings: readonly ResolvedBinding[],
  prefix: string[],
): ResolvedBinding[] {
  return bindings.filter((b) => {
    const steps = chordSteps(b.key);
    if (steps.length <= prefix.length) return false;
    return prefix.every((p, i) => steps[i] === p);
  });
}

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const now = deps.now ?? (() => Date.now());
  const popupTakesKey =
    deps.popupTakesKey ?? ((event: KeyboardEventLike) => POPUP_PASSTHROUGH_KEYS.has(event.key));
  let pending: PendingChord | null = null;

  // Every trigger — keybinding, palette, slash menu, toolbar (R71) — runs a command through
  // `ctx.exec`, never `command.run()` directly, so MRU tracking (owned by whoever builds `exec`,
  // see provider/) stays in exactly one place regardless of how the command was invoked.
  function runRow(row: ResolvedBinding, ctx: CommandContext): void {
    void ctx.exec(row.command, row.args);
  }

  function handleKeyDown(event: DispatchableKeyboardEvent, ctx: CommandContext): boolean {
    // R12 step 1: never touch the document mid-IME.
    if (ctx.composing) return false;

    // R12 step 2: autocomplete's own keymap owns these keys while a popup is open.
    if (ctx.popupOpen && popupTakesKey(event)) return false;

    const token = keyTokenFromEvent(event);
    if (token === null) {
      pending = null;
      return false;
    }

    const bindings = deps.getBindings();

    if (pending) {
      if (now() - pending.startedAt <= CHORD_WINDOW_MS) {
        const attempted = [...pending.steps, token];
        const fullKey = attempted.join(" ");
        const exact = firstMatch(bindings, fullKey, ctx);
        if (exact) {
          pending = null;
          event.preventDefault();
          runRow(exact, ctx);
          return true;
        }
        if (chordsStartingWith(bindings, attempted).length > 0) {
          pending = { steps: attempted, startedAt: pending.startedAt };
          event.preventDefault();
          return true;
        }
        // This key doesn't continue the pending chord. The chord cancels "with no effect" (R63)
        // — it does not also swallow the key that broke it, so fall through and try `token` as a
        // fresh, ordinary dispatch below.
      }
      pending = null;
    }

    const exact = firstMatch(bindings, token, ctx);
    if (exact) {
      event.preventDefault();
      runRow(exact, ctx);
      return true;
    }

    if (chordsStartingWith(bindings, [token]).length > 0) {
      pending = { steps: [token], startedAt: now() };
      event.preventDefault();
      return true;
    }

    return false;
  }

  return {
    handleKeyDown,
    resetChord() {
      pending = null;
    },
  };
}
