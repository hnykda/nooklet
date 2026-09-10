/**
 * Theme preference: light / dark / system, cycled by `app.toggleTheme` (commands-and-keymap.md
 * R52) and applied as a `data-theme` attribute the stylesheet keys off.
 *
 * Stored per device in `localStorage`, deliberately NOT in the synced graph: which appearance a
 * given screen should use is a property of that screen (a phone in bed at night, a monitor in
 * daylight), not of the notes, so syncing it would make one device's choice fight another's.
 * `"system"` follows the OS and keeps following it as it changes.
 */

export type ThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "nooklet.theme";

function readStored(): ThemePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // Private mode / storage disabled: fall through to the default.
  }
  return "system";
}

function resolve(pref: ThemePreference): "light" | "dark" {
  if (pref !== "system") return pref;
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function apply(pref: ThemePreference): void {
  document.documentElement.dataset.theme = resolve(pref);
}

export interface Theme {
  get(): ThemePreference;
  set(pref: ThemePreference): void;
}

let current: ThemePreference | undefined;
let mediaBound = false;

export function useTheme(): Theme {
  if (current === undefined) {
    current = readStored();
    apply(current);
    // Keep following the OS while the preference is "system".
    if (!mediaBound && globalThis.matchMedia) {
      mediaBound = true;
      globalThis.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
        if (current === "system") apply(current);
      });
    }
  }
  return {
    get: () => current ?? "system",
    set(pref) {
      current = pref;
      try {
        localStorage.setItem(STORAGE_KEY, pref);
      } catch {
        // Non-fatal: the theme still applies for this session.
      }
      apply(pref);
    },
  };
}
