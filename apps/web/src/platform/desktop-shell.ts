/**
 * The desktop app's side of the client (ADR 016, ADR 032): the Tauri shell loads this same client
 * from the graph's own origin, so the only way it can tell the client anything is what it injects
 * into the page. From `apps/desktop/src-tauri/src/main.rs`:
 *
 * - `window.__NOOKLET_DESKTOP__` (`shell_script`), defined before any page script runs — so "am I
 *   inside the desktop app?" is a synchronous read, never a guess from the user agent. Since
 *   proposal 005 it also carries the shell's graph list (the only list on desktop), the open server
 *   graph's device token (only in that graph's own documents), and the key the page signs its
 *   requests with;
 * - a `nooklet:desktop-menu` event on `window` when a native menu item the client owns is chosen
 *   (`on_menu`): Settings…, Graphs… and Help → Keyboard Shortcuts (B-533);
 * - a `nooklet:desktop-reply` event answering a request (below).
 *
 * The page asks the shell for things by navigating to `http://nooklet-desktop.invalid/<kind>`
 * (`shellRequest`): a server's page gets no IPC from Tauri, but every navigation reaches the shell.
 *
 * Deliberately not part of `Platform` (`./types.ts`): that adapter is web vs Capacitor, and the
 * desktop app is the web platform — same storage, same service worker — with a shell attached.
 */

/** A graph in the shell's list (`main.rs#PageGraph`). */
export interface DesktopGraph {
  /** `mac:<id>` or `server:<id>`: how requests name it. */
  key: string;
  /** On this Mac (the bundled server's `<data>/graphs/<id>`) or on a server. */
  place: "mac" | "server";
  id: string;
  label: string;
  /** Its address: `http://127.0.0.1:<port>/g/<id>`, or the server graph's `https://…/g/<id>`. */
  address: string;
}

/** What the shell injects. Frozen on its side; read-only here. */
export interface DesktopShell {
  /** Rust's `std::env::consts::OS`: "macos", "windows", "linux". */
  platform: string;
  /** The port the shell's bundled server listens on (`NOOKLET_PORT`, default 6100). */
  port: number;
  /** B-736: the shell saves `<a download>` to ~/Downloads and answers with
   * `DESKTOP_DOWNLOAD_EVENT`. */
  downloads: boolean;
  /** B-789: the shell answers `reveal-asset` ("Show in Finder" on an image). */
  reveal: boolean;
  /** Signs every request; only this window's main-frame documents have it. */
  key: string;
  /** Every graph this Mac knows: This Mac's own, then servers', as the shell lists them. */
  graphs: DesktopGraph[];
  /** The open server graph's device token, from the keychain. Set only in that graph's own
   * documents (the shell checks origin and path before any page script runs); `null` everywhere
   * else, including This Mac, whose server hands its own page a token itself. */
  graphToken: string | null;
}

/** B-736: the shell's report on a finished download — `{ ok, name }`, `name` being the file it
 * wrote in ~/Downloads (wry de-duplicates it, so it may not be the name the page asked for). */
export const DESKTOP_DOWNLOAD_EVENT = "nooklet:desktop-download";

/** The host is reserved never to resolve (RFC 2606): outside the shell a request fails instead
 * of reaching anyone. */
const SHELL_REQUEST_ORIGIN = "http://nooklet-desktop.invalid";

/** What a page can ask the shell (`main.rs#ShellRequest`). Opening a graph is not one: the page
 * navigates to its address, and the shell routes that navigation. */
export type ShellRequest =
  | { kind: "new-local-graph"; label: string }
  /** Checked by the shell, from Rust (no CORS): the token, or a one-time pairing code (ADR 029)
   * traded for a token named `device` on that server. Opens the graph when it works. */
  | {
      kind: "connect-server";
      address: string;
      token?: string;
      code?: string;
      device?: string;
    }
  | { kind: "rename"; graph: string; label: string }
  | { kind: "remove"; graph: string }
  /** B-789: select an asset's file in Finder. `graph` is a `mac:` key, `asset` the asset's id; the
   * shell finds the file itself, in that graph's own folder. */
  | { kind: "reveal-asset"; graph: string; asset: string };

export function shellRequestUrl(request: ShellRequest, key: string, req: string): string {
  const params = new URLSearchParams({ key, req });
  for (const [name, value] of Object.entries(request)) {
    if (name !== "kind" && typeof value === "string") params.set(name, value);
  }
  return `${SHELL_REQUEST_ORIGIN}/${request.kind}?${params.toString()}`;
}

/** The shell's answer to a request (`main.rs#reply`). A request that opened a graph is answered
 * only when it failed: when it worked, this page is gone. */
export const DESKTOP_REPLY_EVENT = "nooklet:desktop-reply";

export interface ShellReply {
  ok: boolean;
  error?: string;
  /** The list as it now is, after a rename or a removal. */
  graphs?: DesktopGraph[];
}

let nextReq = 0;

/**
 * Sends `request` and resolves with the shell's answer. A request that opens a graph (creating
 * one, connecting to one) never resolves when it works: the shell replaces this window.
 */
export function shellRequest(
  shell: DesktopShell,
  request: ShellRequest,
  win: Window = window,
): Promise<ShellReply> {
  nextReq += 1;
  const req = `r${Date.now().toString(36)}-${nextReq}`;
  return new Promise((resolve) => {
    const onReply = (event: Event): void => {
      const detail = (event as CustomEvent<unknown>).detail as Record<string, unknown> | null;
      if (!detail || detail.req !== req) return;
      win.removeEventListener(DESKTOP_REPLY_EVENT, onReply);
      resolve({
        ok: detail.ok === true,
        error: typeof detail.error === "string" ? detail.error : undefined,
        graphs: Array.isArray(detail.graphs) ? readGraphs(detail.graphs) : undefined,
      });
    };
    win.addEventListener(DESKTOP_REPLY_EVENT, onReply);
    win.location.assign(shellRequestUrl(request, shell.key, req));
  });
}

/** Whether this page is the bundled server's own (This Mac), not a remote server's. */
export function onBundledServer(shell: DesktopShell, loc: Location = location): boolean {
  return loc.origin === `http://127.0.0.1:${shell.port}`;
}

/** The graph in `graphs` this page is showing: the one whose address this page is at or under. */
export function currentDesktopGraph(
  graphs: readonly DesktopGraph[],
  loc: { origin: string; pathname: string } = location,
): DesktopGraph | undefined {
  let best: DesktopGraph | undefined;
  for (const graph of graphs) {
    try {
      const address = new URL(graph.address);
      const path = address.pathname.replace(/\/+$/, "");
      const under = loc.pathname === path || loc.pathname.startsWith(`${path}/`);
      if (address.origin === loc.origin && under) {
        if (!best || graph.address.length > best.address.length) best = graph;
      }
    } catch {
      // Not an address: not this page.
    }
  }
  return best;
}

/** The menu items the client answers — the same strings as `MENU_*` in `main.rs`. */
export type DesktopMenuAction = "settings" | "shortcuts" | "graphs";

export const DESKTOP_MENU_EVENT = "nooklet:desktop-menu";

type ShellWindow = Window & { __NOOKLET_DESKTOP__?: unknown };

function readGraphs(raw: unknown[]): DesktopGraph[] {
  return raw.flatMap((g) => {
    if (typeof g !== "object" || g === null) return [];
    const { key, place, id, label, address } = g as Record<string, unknown>;
    if (
      typeof key !== "string" ||
      (place !== "mac" && place !== "server") ||
      typeof id !== "string" ||
      typeof label !== "string" ||
      typeof address !== "string"
    ) {
      return [];
    }
    return [{ key, place, id, label, address }];
  });
}

/** The shell's flag, or `null` in a browser (or anything that injected something malformed). */
export function desktopShell(win: Window | undefined = globalThis.window): DesktopShell | null {
  const raw = (win as ShellWindow | undefined)?.__NOOKLET_DESKTOP__;
  if (typeof raw !== "object" || raw === null) return null;
  const { platform, port, downloads, reveal, key, graphs, graphToken } = raw as Record<
    string,
    unknown
  >;
  if (typeof platform !== "string" || typeof port !== "number") return null;
  return {
    platform,
    port,
    downloads: downloads === true,
    reveal: reveal === true,
    key: typeof key === "string" ? key : "",
    graphs: Array.isArray(graphs) ? readGraphs(graphs) : [],
    graphToken: typeof graphToken === "string" && graphToken ? graphToken : null,
  };
}

/**
 * Routes native menu items to `handlers` for as long as the returned function is not called.
 * Outside the desktop shell it listens to nothing: nobody else sends these, and a page script
 * pretending to be the menu should not be able to drive the app either.
 */
export function listenToDesktopMenu(
  handlers: Partial<Record<DesktopMenuAction, () => void>>,
  win: Window = window,
): () => void {
  if (!desktopShell(win)) return () => {};
  const onMenu = (event: Event): void => {
    const action = (event as CustomEvent<unknown>).detail;
    if (action === "settings" || action === "shortcuts" || action === "graphs") {
      handlers[action]?.();
    }
  };
  win.addEventListener(DESKTOP_MENU_EVENT, onMenu);
  return () => win.removeEventListener(DESKTOP_MENU_EVENT, onMenu);
}
