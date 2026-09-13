/**
 * What the date picker does with a key, and holding keys for it before it exists (B-147).
 *
 * The picker takes the keyboard from a window capture listener while the editor keeps DOM focus
 * (`DatePicker.tsx` says why). Two holes in that, both closed here:
 *
 * 1. Type-ahead. Between `/scheduled` + Enter and the picker's listener there is a replica read and
 *    a lazy `import()` — 6-25 ms measured, much longer on a cold or slow load. Keys pressed in that
 *    gap went into the block: `tom` typed at once gave the block `t` and the picker `om`. So the
 *    host starts a hold the moment it is asked to open (`holdPickerInput`), the hold takes those
 *    keys exactly as the picker would, and the picker replays them before anything else can arrive.
 * 2. Text with no keydown. An IME commit, dictation, an emoji picker or a virtual keyboard delivers
 *    `beforeinput` (`insertText`) without a keydown of its own, so a keydown listener never saw it
 *    and the text landed in the block. Both the hold and the open picker take `insertText`.
 *
 * Still not covered, and not coverable while the editor keeps focus: text composed in place
 * (`insertCompositionText` — an IME's marked text, a dead-key accent on some layouts). That
 * `beforeinput` cannot be cancelled, so the composition happens in the block behind the picker.
 * See docs/bugs-inbox/focus.md B-147.
 *
 * Plain DOM, no Solid: the host (`./host.ts`) must stay importable in Node.
 */

/** A keydown as the picker needs it. */
export interface PickerKey {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
}

/** Something typed while a picker was on its way. */
export type HeldInput = { kind: "key"; key: PickerKey } | { kind: "text"; text: string };

export type PickerKeyAction =
  /** Not the picker's business, and harmless to let through (a lone modifier, a composing key). */
  | { kind: "ignore" }
  /** Cmd/Ctrl+V: leave it alone, it comes back as a `paste` event. */
  | { kind: "paste" }
  /** Any other Cmd/Ctrl shortcut: the picker closes and the shortcut does what it always does. */
  | { kind: "shortcut" }
  /** Cmd/Ctrl+Backspace: clear what was typed. */
  | { kind: "clear" }
  /** The picker's own key (typing, Enter, Escape, arrows, Tab…): consumed. */
  | { kind: "key"; key: PickerKey };

const LONE_MODIFIERS = new Set(["Shift", "Alt", "Meta", "Control", "CapsLock"]);

/** The picker's reading of a keydown — one function for the open picker and the hold before it,
 * so a key typed a few milliseconds early means exactly what it would have meant a bit later. */
export function pickerKeyAction(
  e: Pick<KeyboardEvent, "key" | "shiftKey" | "altKey" | "metaKey" | "ctrlKey" | "isComposing">,
): PickerKeyAction {
  if (e.isComposing) return { kind: "ignore" };
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key === "Backspace") return { kind: "clear" };
  if (mod && (e.key === "v" || e.key === "V")) return { kind: "paste" };
  if (mod) return { kind: "shortcut" };
  if (LONE_MODIFIERS.has(e.key)) return { kind: "ignore" };
  return { kind: "key", key: { key: e.key, shiftKey: e.shiftKey, altKey: e.altKey } };
}

/** `beforeinput` text the picker should take: typed-in text that came without a keydown. */
export function insertedText(e: Pick<InputEvent, "inputType" | "data">): string | null {
  return e.inputType === "insertText" && e.data ? e.data : null;
}

export interface PickerInputHold {
  /** Everything held so far, in order; empties the buffer. */
  take(): HeldInput[];
  /** True once something meant "never mind" before the picker appeared — a Cmd/Ctrl shortcut
   * (left to do its job) or a press elsewhere on the page. The picker should not open. */
  cancelled(): boolean;
  /** Stop holding. Idempotent. */
  release(): void;
}

/**
 * Start holding the picker's input on `target` (the window): keys are taken in the capture phase
 * — before the global keymap and CodeMirror, like the picker itself — and kept for `take()`.
 */
export function holdPickerInput(target: Window): PickerInputHold {
  let held: HeldInput[] = [];
  let wasCancelled = false;
  let released = false;

  const swallow = (e: Event): void => {
    e.preventDefault();
    e.stopPropagation();
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    const action = pickerKeyAction(e);
    switch (action.kind) {
      case "ignore":
      case "paste":
        return;
      case "shortcut":
        wasCancelled = true;
        release();
        return;
      case "clear":
        swallow(e);
        held.push({ kind: "key", key: { key: "Backspace", shiftKey: false, altKey: true } });
        return;
      case "key":
        swallow(e);
        if (action.key.key === "Escape") {
          // Escape can only ever mean "cancel", so there is no picker to wait for, and whatever is
          // typed next is the block's again. Swallowed all the same: the editor's keymap would
          // otherwise read it as "leave editing".
          wasCancelled = true;
          release();
          return;
        }
        held.push({ kind: "key", key: action.key });
        return;
    }
  };
  const onBeforeInput = (e: InputEvent): void => {
    const text = insertedText(e);
    if (text === null) return;
    swallow(e);
    held.push({ kind: "text", text });
  };
  const onPaste = (e: ClipboardEvent): void => {
    swallow(e);
    held.push({ kind: "text", text: e.clipboardData?.getData("text/plain") ?? "" });
  };
  const onPointerDown = (): void => {
    wasCancelled = true;
    release();
  };

  function release(): void {
    if (released) return;
    released = true;
    target.removeEventListener("keydown", onKeyDown, true);
    target.removeEventListener("beforeinput", onBeforeInput, true);
    target.removeEventListener("paste", onPaste, true);
    target.removeEventListener("pointerdown", onPointerDown, true);
  }

  target.addEventListener("keydown", onKeyDown, true);
  target.addEventListener("beforeinput", onBeforeInput, true);
  target.addEventListener("paste", onPaste, true);
  target.addEventListener("pointerdown", onPointerDown, true);

  return {
    take() {
      const out = held;
      held = [];
      return out;
    },
    cancelled: () => wasCancelled,
    release,
  };
}
