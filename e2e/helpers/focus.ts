/**
 * Focus tracing. Lifted from `autocomplete.spec.ts`, where it was written for B-42.
 *
 * The standard for focus tests in this suite: check focus SYNCHRONOUSLY after every keystroke, and
 * record every `focusout` with the JS stack that caused it — so a failure names the culprit, not
 * just the symptom. An auto-retrying `toBeFocused()` would wait out a transient loss and pass on
 * exactly the behaviour under test.
 */

import type { Page } from "@playwright/test";

export interface FocusLoss {
  afterKey: string;
  activeElement: string;
  /** Where focus went, if a `focusout` fired at all — a detached editor loses focus silently. */
  focusout: Array<{ to: string | null; stack: string }>;
}

interface TraceWindow {
  __focusout?: Array<{ to: string | null; stack: string }>;
  __focusTraceInstalled?: boolean;
}

/** Start recording `focusout` events (with stacks). Idempotent per document. */
export async function installFocusTrace(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as TraceWindow;
    w.__focusout = [];
    if (w.__focusTraceInstalled) return;
    w.__focusTraceInstalled = true;
    document.addEventListener(
      "focusout",
      (e) => {
        const to = e.relatedTarget as Element | null;
        w.__focusout?.push({
          to: to ? `${to.tagName.toLowerCase()}.${to.className}` : null,
          stack: (new Error().stack ?? "").split("\n").slice(2, 8).join(" | "),
        });
      },
      true,
    );
  });
}

/** Drain the recorded `focusout`s and report whether the editor holds focus right now. */
export async function readFocusTrace(page: Page): Promise<{
  focused: boolean;
  activeElement: string;
  focusout: Array<{ to: string | null; stack: string }>;
}> {
  return page.evaluate(() => {
    const w = window as unknown as TraceWindow;
    const out = w.__focusout ?? [];
    w.__focusout = [];
    const active = document.activeElement;
    return {
      focused: !!active?.closest(".cm-content"),
      activeElement: active ? `${active.tagName.toLowerCase()}.${active.className}` : "none",
      focusout: out,
    };
  });
}

/**
 * Types `text` one character at a time and checks focus after each. Returns every keystroke after
 * which the editor was not focused or a `focusout` had fired — an empty array is the pass.
 */
export async function typeWatchingFocus(page: Page, text: string): Promise<FocusLoss[]> {
  await installFocusTrace(page);
  const losses: FocusLoss[] = [];
  for (const ch of text) {
    await page.keyboard.type(ch, { delay: 30 });
    const state = await readFocusTrace(page);
    if (!state.focused || state.focusout.length > 0) {
      losses.push({ afterKey: ch, activeElement: state.activeElement, focusout: state.focusout });
    }
  }
  return losses;
}

/**
 * Presses `keys` (one `page.keyboard.press` each) and checks focus after each, same contract as
 * `typeWatchingFocus`. For the structural keys — Enter, Tab, arrows — where the row being edited
 * is re-rendered and focus historically fell to `<body>` for a frame.
 */
export async function pressWatchingFocus(page: Page, keys: string[]): Promise<FocusLoss[]> {
  await installFocusTrace(page);
  const losses: FocusLoss[] = [];
  for (const key of keys) {
    await page.keyboard.press(key);
    const state = await readFocusTrace(page);
    if (!state.focused) {
      losses.push({ afterKey: key, activeElement: state.activeElement, focusout: state.focusout });
    }
  }
  return losses;
}
