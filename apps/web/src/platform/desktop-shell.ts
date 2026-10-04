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

/** One of This Mac's own graphs: a graph on the app's bundled server (`main.rs#LocalGraph`). */
export interface DesktopLocalGraph {
  id: string;
  label: string;
}

/** What the shell injects. Frozen and non-writable on its side; read-only here. */
export interface DesktopShell {
  /** Rust's `std::env::consts::OS`: "macos", "windows", "linux". */
  platform: string;
  /** The port the shell's server listens on (`NOOKLET_PORT`, default 6100). */
  port: number;
  /** B-643: every graph on the bundled server, whichever server the window is showing. Empty from
   * an older shell, which did not send it. */
  localGraphs: DesktopLocalGraph[];
}

/** B-643: what a page can ask the shell to do (`main.rs#ShellRequest`). There is no IPC from a
 * server's page, so the request is a navigation the shell intercepts; the host is reserved never
 * to resolve (RFC 2606), so outside the shell it fails instead of reaching anyone. */
const SHELL_REQUEST_ORIGIN = "http://nooklet-desktop.invalid";

export function shellRequestUrl(
  request: { kind: "new-local-graph"; label: string } | { kind: "open-local-graph"; id: string },
): string {
  const params =
    request.kind === "new-local-graph"
      ? new URLSearchParams({ label: request.label })
      : new URLSearchParams({ id: request.id });
  return `${SHELL_REQUEST_ORIGIN}/${request.kind}?${params.toString()}`;
}

/** The shell's answer when a request failed (`main.rs#report_to_page`): `detail` is the reason. */
export const DESKTOP_ERROR_EVENT = "nooklet:desktop-error";

/** The address of This Mac's graph `id` on the bundled server. */
export function localGraphAddress(shell: DesktopShell, id: string): string {
  return `http://127.0.0.1:${shell.port}/g/${id}`;
}

/** Whether this page is the bundled server's own (This Mac), not a remote server's. */
export function onBundledServer(shell: DesktopShell, loc: Location = location): boolean {
  return loc.origin === `http://127.0.0.1:${shell.port}`;
}

/** The menu items the client answers — the same strings as `MENU_*` in `main.rs`. */
export type DesktopMenuAction = "settings" | "shortcuts";

export const DESKTOP_MENU_EVENT = "nooklet:desktop-menu";

type ShellWindow = Window & { __NOOKLET_DESKTOP__?: unknown };

/** The shell's flag, or `null` in a browser (or anything that injected something malformed). */
export function desktopShell(win: Window | undefined = globalThis.window): DesktopShell | null {
  const raw = (win as ShellWindow | undefined)?.__NOOKLET_DESKTOP__;
  if (typeof raw !== "object" || raw === null) return null;
  const { platform, port, localGraphs } = raw as Record<string, unknown>;
  if (typeof platform !== "string" || typeof port !== "number") return null;
  const graphs = Array.isArray(localGraphs)
    ? localGraphs.filter(
        (g): g is DesktopLocalGraph =>
          typeof g === "object" &&
          g !== null &&
          typeof (g as DesktopLocalGraph).id === "string" &&
          typeof (g as DesktopLocalGraph).label === "string",
      )
    : [];
  return { platform, port, localGraphs: graphs };
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
