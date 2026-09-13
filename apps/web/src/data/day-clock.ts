/**
 * The device's local calendar day as a Solid signal — what "today" means to every view that
 * shows it: the journal stream's Today section, the "Scheduled and deadline" list, and a
 * ```` ```query ```` fence's `today` (B-94, B-170).
 *
 * Reading `todayJournalDay()` during render is correct only until midnight: the value is not
 * tracked, so nothing re-renders when the date changes, and a tab left open overnight — the
 * normal state of a desktop outliner — kept yesterday as "today" until something unrelated
 * refetched. Read `currentDay()` inside a tracking scope instead; it changes exactly once per
 * day rollover.
 *
 * Three ways the change is noticed, because no single one is reliable:
 * - A timer aimed just past the next local midnight. Capped at `MAX_TIMER_MS`, because browser
 *   timers run on a monotonic clock that stops while the machine sleeps: a laptop closed at
 *   22:00 and opened at 08:00 would otherwise fire its "in 2 hours" timer at 10:00. The cap
 *   bounds that lag to a few minutes at the price of one no-op date comparison per interval.
 * - `visibilitychange` to visible: a phone or a background tab whose timers were suspended or
 *   throttled — the moment the page is looked at again is the moment the day must be right.
 * - window `focus`: a visible window on a desktop that slept, where no visibility event fires.
 */

import { dateToJournalDay, type JournalDay } from "@nooklet/core";
import { type Accessor, createSignal } from "solid-js";

/** The longest one timer is trusted to wait (see the module comment on sleeping machines). */
export const MAX_TIMER_MS = 5 * 60_000;

/** Timers may fire slightly early; aiming this far past midnight means the check that runs
 * already sees the new day instead of re-arming for a few milliseconds. */
const MIDNIGHT_SLACK_MS = 250;

/** Milliseconds from `nowMs` to the next local midnight. Built from local date parts, so a
 * 23- or 25-hour day at a daylight-saving change is measured correctly. */
export function msUntilNextLocalMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  return next.getTime() - nowMs;
}

/** The part of `document`/`window` the clock listens on — narrow so a test can hand in a fake. */
export interface ListenTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface DayClockEnv {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Absent outside a browser: the timer alone then keeps the day. */
  document?: ListenTarget & { visibilityState?: string };
  window?: ListenTarget;
}

export interface DayClock {
  /** The local day, YYYYMMDD. Tracked: changes once per rollover, never on a no-op check. */
  day: Accessor<JournalDay>;
  /** Re-read the wall clock now (and re-arm the timer). */
  check: () => void;
  /** Stop the timer and remove the listeners. */
  dispose: () => void;
}

function browserEnv(): DayClockEnv {
  return {
    // Looked up on every call rather than captured, so a test's fake timers installed after this
    // module loaded are still the ones used.
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    document: typeof document === "undefined" ? undefined : document,
    window: typeof window === "undefined" ? undefined : window,
  };
}

export function createDayClock(overrides: Partial<DayClockEnv> = {}): DayClock {
  const env: DayClockEnv = { ...browserEnv(), ...overrides };
  const [day, setDay] = createSignal<JournalDay>(dateToJournalDay(new Date(env.now())));
  let timer: unknown;
  let disposed = false;

  function arm(): void {
    if (timer !== undefined) env.clearTimer(timer);
    const wait = Math.min(msUntilNextLocalMidnight(env.now()) + MIDNIGHT_SLACK_MS, MAX_TIMER_MS);
    timer = env.setTimer(() => {
      timer = undefined;
      check();
    }, wait);
  }

  function check(): void {
    if (disposed) return;
    // A signal set to an equal value notifies nobody, so the capped re-checks are free for
    // every reader; only a real rollover re-runs anything.
    setDay(dateToJournalDay(new Date(env.now())));
    arm();
  }

  const onVisibility = (): void => {
    if (env.document?.visibilityState !== "hidden") check();
  };
  env.document?.addEventListener("visibilitychange", onVisibility);
  env.window?.addEventListener("focus", check);
  arm();

  return {
    day,
    check,
    dispose() {
      disposed = true;
      if (timer !== undefined) env.clearTimer(timer);
      timer = undefined;
      env.document?.removeEventListener("visibilitychange", onVisibility);
      env.window?.removeEventListener("focus", check);
    },
  };
}

let shared: DayClock | undefined;

/** Today's local day, tracked. One clock for the whole app, created on first read. */
export function currentDay(): JournalDay {
  shared ??= createDayClock();
  return shared.day();
}

/** Tests only: drop the shared clock so the next `currentDay()` builds one against the current
 * (possibly faked) timers. */
export function resetSharedDayClock(): void {
  shared?.dispose();
  shared = undefined;
}
