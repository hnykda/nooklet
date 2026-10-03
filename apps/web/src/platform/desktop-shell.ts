/**
 * The desktop app's side of the client (ADR 016): the Tauri shell loads this same client from the
 * server's origin, so the only way it can tell the client anything is what it injects into the
 * page. Two things, both from `apps/desktop/src-tauri/src/main.rs`:
 *
 * - `window.__NOOKLET_DESKTOP__` (`shell_script`), defined before any page script runs — so "am I
 *   inside the desktop app?" is a synchronous read, never a guess from the user agent;
 * - a `nooklet:desktop-menu` event on `window` when a native menu item the client owns is chosen
 *   (`on_menu`): Settings… and Help → Keyboard Shortcuts (B-533). Reload, Documentation, Report a
 *   Bug and Switch Server… are the shell's own and never arrive here — the last one is how a
 *   running app reaches the standalone-vs-remote-server picker again (`../../launcher/`); it quits
 *   the app rather than sending the client anything, since the client cannot act on it anyway.
 *
 * Deliberately not part of `Platform` (`./types.ts`): that adapter is web vs Capacitor, and the
 * desktop app is the web platform — same storage, same service worker — with a menu bar attached.
 */

/** What the shell injects. Frozen and non-writable on its side; read-only here. */
export interface DesktopShell {
  /** Rust's `std::env::consts::OS`: "macos", "windows", "linux". */
  platform: string;
  /** The port the shell's server listens on (`NOOKLET_PORT`, default 6100). */
  port: number;
}

/** The menu items the client answers — the same strings as `MENU_*` in `main.rs`. */
export type DesktopMenuAction = "settings" | "shortcuts";

export const DESKTOP_MENU_EVENT = "nooklet:desktop-menu";

type ShellWindow = Window & { __NOOKLET_DESKTOP__?: unknown };

/** The shell's flag, or `null` in a browser (or anything that injected something malformed). */
export function desktopShell(win: Window | undefined = globalThis.window): DesktopShell | null {
  const raw = (win as ShellWindow | undefined)?.__NOOKLET_DESKTOP__;
  if (typeof raw !== "object" || raw === null) return null;
  const { platform, port } = raw as Record<string, unknown>;
  if (typeof platform !== "string" || typeof port !== "number") return null;
  return { platform, port };
}

/**
 * Routes native menu items to `handlers` for as long as the returned function is not called.
 * Outside the desktop shell it listens to nothing: nobody else sends these, and a page script
 * pretending to be the menu should not be able to drive the app either.
 */
export function listenToDesktopMenu(
  handlers: Record<DesktopMenuAction, () => void>,
  win: Window = window,
): () => void {
  if (!desktopShell(win)) return () => {};
  const onMenu = (event: Event): void => {
    const action = (event as CustomEvent<unknown>).detail;
    if (action === "settings" || action === "shortcuts") handlers[action]();
  };
  win.addEventListener(DESKTOP_MENU_EVENT, onMenu);
  return () => win.removeEventListener(DESKTOP_MENU_EVENT, onMenu);
}
