/**
 * B-662: on iOS the soft keyboard's Return reaches the page as Shift+Enter whenever the keyboard's
 * shift is lit — and with auto-capitalisation that is at the start of every sentence: an empty
 * line, after ". ". Simulator log (`tools/probes/phone-input/`): `keydown "Enter" 13 shift=true`,
 * on a keyboard where `shiftKey` was true even for the lowercase letters typed before it. Shift+Enter
 * is the soft line break here (`block.newline`, the draft's own newline), so Return put a newline in
 * the line instead of starting a block, in today's empty draft and in a block alike.
 *
 * CodeMirror drops the shift for the same reason (`@codemirror/view` 6.43.11, `InputState.keydown`:
 * "On iOS with autocapitalize, drop the shift modifier for these keys, since it will be set at the
 * start of every sentence"), but our keys never reach that code: the command layer takes Enter at
 * the document first. Same rule here: iOS, the soft keyboard up, a field that auto-capitalises.
 * A hardware keyboard (an iPad's) has no soft keyboard up, so its Shift+Enter is left alone.
 */
import { detectPlatform } from "../commands/keymap/platform.js";

export interface EnterShiftFacts {
  key: string;
  shiftKey: boolean;
  ios: boolean;
  /** The soft keyboard is on screen (`kb-open` on <html>, from the keyboard inset watcher). */
  softKeyboardOpen: boolean;
  /** The focused field's `autocapitalize` ("" when unset, which iOS treats as sentences). */
  autocapitalize: string;
}

/** Whether this Enter's shift is iOS's auto-capitalisation, not a Shift the person held. */
export function isAutoCapsShift(f: EnterShiftFacts): boolean {
  return (
    f.key === "Enter" &&
    f.shiftKey &&
    f.ios &&
    f.softKeyboardOpen &&
    !/^(off|none)$/.test(f.autocapitalize)
  );
}

let ios: boolean | undefined;

/** `isAutoCapsShift` for a real event in this page. */
export function enterShiftIsAutoCaps(e: KeyboardEvent): boolean {
  if (e.key !== "Enter" || !e.shiftKey) return false;
  ios ??=
    typeof navigator !== "undefined" &&
    detectPlatform({
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
    }) === "ios";
  const target = e.target instanceof HTMLElement ? e.target : null;
  return isAutoCapsShift({
    key: e.key,
    shiftKey: e.shiftKey,
    ios,
    softKeyboardOpen: document.documentElement.classList.contains("kb-open"),
    autocapitalize: target?.autocapitalize ?? "",
  });
}
