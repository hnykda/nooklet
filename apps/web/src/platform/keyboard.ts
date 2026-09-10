/**
 * Keyboard inset math (research/08-mobile.md §3.2). `computeKeyboardInset` is the pure part —
 * given the numbers a real `visualViewport` would report, it returns the `--kb` pixel value — and
 * is unit tested in node (`keyboard.test.ts`). `createWebKeyboardWatcher` is the DOM wiring around
 * it (real `window`/`visualViewport`/`requestAnimationFrame`) and is NOT unit tested: it needs a
 * browser. See apps/web/README.md's "needs manual browser verification" list, which calls out
 * specifically the iOS 26.0/26.1 `visualViewport.height` residual-24px bug this dead-band and the
 * post-blur re-measure exist to absorb.
 */

import type { KeyboardHandle } from "./types.js";

/** Below this, treat the viewport delta as URL-bar collapse / iOS residue, not a real keyboard. */
const DEAD_BAND_PX = 80;
/** Re-measure this long after blur: iOS 26 leaves a stale `visualViewport.height` for a beat. */
const POST_BLUR_REMEASURE_MS = 350;

export function computeKeyboardInset(
  innerHeight: number,
  vvHeight: number,
  vvOffsetTop: number,
): number {
  const inset = Math.max(0, innerHeight - vvHeight - vvOffsetTop);
  return inset < DEAD_BAND_PX ? 0 : Math.round(inset);
}

export interface KeyboardStyleTarget {
  style: { setProperty(name: string, value: string): void };
  classList: { toggle(name: string, force: boolean): void };
}

/** Write `--kb` (and toggle `.kb-open`) on `root`. Exported so `../platform/capacitor.ts` can
 * drive the exact same CSS contract from `@capacitor/keyboard`'s real height events instead of
 * this file's `visualViewport` heuristics — the app's CSS (`../styles/shell.css`,
 * `../commands/styles.css`) never needs to know which adapter is live. */
export function applyInset(root: KeyboardStyleTarget, px: number): void {
  root.style.setProperty("--kb", `${px}px`);
  root.classList.toggle("kb-open", px > 0);
}

/** Wire `computeKeyboardInset` to the real `visualViewport` and write `--kb` on `root`. */
export function createWebKeyboardWatcher(
  root: KeyboardStyleTarget = document.documentElement,
): KeyboardHandle {
  const vv = window.visualViewport;
  if (!vv) {
    applyInset(root, 0);
    return { stop() {} };
  }

  let raf = 0;
  const measure = () => {
    raf = 0;
    applyInset(root, computeKeyboardInset(window.innerHeight, vv.height, vv.offsetTop));
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(measure);
  };
  // Blur/focus between blocks fires hide/show pairs; re-measure once the hide animation settles
  // rather than trusting the immediately-post-blur value (research/08 §3.3 pitfall 3/4).
  const onBlur = () => setTimeout(schedule, POST_BLUR_REMEASURE_MS);

  vv.addEventListener("resize", schedule);
  vv.addEventListener("scroll", schedule);
  window.addEventListener("focusout", onBlur);
  measure();

  return {
    stop() {
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
      window.removeEventListener("focusout", onBlur);
      applyInset(root, 0);
    },
  };
}
