/**
 * The consent toggles (ADR 015 §2.6/BUILD item 8): two independent, per-device, unsynced booleans
 * — "let agents view this window" (default **on**; off on a phone since B-708, see
 * `./device-default.ts`) and "let agents control this window" (default
 * **off**). Stored in `localStorage`, deliberately never in the synced graph, for the same reason
 * `../app/theme.ts` keeps theme device-local: a device-local trust decision must never silently
 * turn on control on a phone because a desktop enabled it.
 *
 * Storage-agnostic (mirrors `../commands/ranking/mru.ts`'s `MruStorageAdapter` idiom) so tests
 * never touch a real `localStorage`.
 */

import { liveOffByDefault } from "./device-default.js";

export interface ConsentStorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const VIEW_KEY = "nooklet.live.viewEnabled";
const CONTROL_KEY = "nooklet.live.controlEnabled";

function readBool(storage: ConsentStorageAdapter, key: string, fallback: boolean): boolean {
  try {
    const raw = storage.getItem(key);
    if (raw === "true") return true;
    if (raw === "false") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function writeBool(storage: ConsentStorageAdapter, key: string, value: boolean): void {
  try {
    storage.setItem(key, value ? "true" : "false");
  } catch {
    // Non-fatal: the in-memory ConsentStore below still reflects the change for this session.
  }
}

export interface ConsentState {
  /** "Let agents view this window" — read-only, answers ui_state/ui_windows. Default ON: this is
   * what makes the feature discoverable, and carries no write risk. */
  viewEnabled: boolean;
  /** "Let agents control this window" — required before ui_run/ui_navigate/ui_highlight will do
   * anything to this window. Default OFF: one deliberate opt-in per window/device. */
  controlEnabled: boolean;
}

export interface ConsentStore {
  get(): ConsentState;
  setViewEnabled(v: boolean): void;
  setControlEnabled(v: boolean): void;
  /** Notify `fn` on every change (from this store instance); returns an unsubscribe function. */
  subscribe(fn: (state: ConsentState) => void): () => void;
}

function memoryAdapter(): ConsentStorageAdapter {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

/** Create a consent store. Pass no adapter to get an in-memory-only store (tests, SSR, or a
 * browser with storage disabled) — reads/writes never throw either way, matching
 * `../commands/ranking/mru.ts#createMruStore`'s contract. */
export function createConsentStore(
  storage?: ConsentStorageAdapter,
  /** B-708: the view default when this device has stored no choice — off on a phone
   * (`./device-default.ts`). A stored choice always wins. */
  defaults: { viewEnabled: boolean } = { viewEnabled: true },
): ConsentStore {
  const backing = storage ?? memoryAdapter();
  const listeners = new Set<(state: ConsentState) => void>();

  let state: ConsentState = {
    viewEnabled: readBool(backing, VIEW_KEY, defaults.viewEnabled),
    controlEnabled: readBool(backing, CONTROL_KEY, false),
  };

  function notify(): void {
    for (const fn of listeners) fn(state);
  }

  return {
    get: () => state,
    setViewEnabled(v) {
      writeBool(backing, VIEW_KEY, v);
      state = { ...state, viewEnabled: v };
      notify();
    },
    setControlEnabled(v) {
      writeBool(backing, CONTROL_KEY, v);
      state = { ...state, controlEnabled: v };
      notify();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

function safeLocalStorageAdapter(): ConsentStorageAdapter | undefined {
  try {
    // Accessing `localStorage` itself can throw (private mode in some browsers); probing here
    // once, rather than in every read/write, keeps the hot paths above exception-free.
    const probe = "nooklet.live.__probe__";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return undefined;
  }
}

/** The app-wide consent store (`../shell/AppShell.tsx`'s `<ConsentBadge>` and
 * `../app/CommandLayer.tsx`'s socket wiring both read this SAME instance, so a toggle flipped from
 * the badge is reflected immediately without any prop-drilling — same module-singleton idiom
 * `../app/theme.ts#useTheme` and `../data/api-client.ts#apiClient` already use). */
export const liveConsent: ConsentStore = createConsentStore(safeLocalStorageAdapter(), {
  viewEnabled: !liveOffByDefault(),
});

/** B-708: whether the top-bar badge is drawn. Always on a desktop; on a phone only while the
 * owner has turned agent access on (Settings), so the consent signal is there exactly when it
 * means something (ADR 015 §6). */
export function liveBadgeShown(state: ConsentState, offByDefault: boolean): boolean {
  return !offByDefault || state.viewEnabled || state.controlEnabled;
}
