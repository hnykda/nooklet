/**
 * Where the client gets its own credentials.
 *
 * When the server serves this build (`packages/server/src/http/web-client.ts`), it injects
 * `window.__NOOKLET__` into the shell with a token minted for this process — but only for a
 * loopback caller, because over a LAN that would hand a write credential to anyone who loads the
 * page. When Vite serves it in development there is no injection, so the `VITE_*` env vars stand
 * in.
 *
 * Before this existed the client had no credential at all in a production build: `search`,
 * `page.backlinks`, `/sync/*` and `/ui/live` are all authenticated, so a served app rendered but
 * could never load references, search, or sync — and, because nothing surfaced the 401, it looked
 * like an permanent spinner rather than an error. `reason` exists so the diagnostics panel can say
 * *why* there is no token instead of just showing "disconnected".
 */

/**
 * Where a device token is kept when the server did not inject one — i.e. any client that is not
 * on loopback: a phone, a laptop, anything reaching a self-hosted server over a LAN, a tailnet or
 * the internet. Per device and per browser by design; it is a credential, and it never syncs.
 */
const TOKEN_STORAGE_KEY = "nooklet.deviceToken";

export function storedToken(): string | undefined {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined; // private mode / storage disabled
  }
}

/** Persist (or clear) this device's token. The caller reloads: the sync worker is handed its
 * token once at startup (`db/client.ts#initDb`), so changing it mid-session would leave the
 * already-running transport on the old credential. */
export function setStoredToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
    cached = undefined;
  } catch {
    // Non-fatal: the token simply will not survive a reload.
  }
}

export interface BootstrapConfig {
  /** Bearer token for this origin's API, or `null` when the server declined to issue one. */
  token: string | null;
  /** Why there is no token, when there isn't one. */
  reason?: string;
  /** Identity of the graph this server is serving (`server/src/graph-identity.ts`). */
  graphId?: string;
  /**
   * True when this device holds a replica of a DIFFERENT graph than the server is serving.
   *
   * The local replica lives in OPFS, keyed by origin — so pointing `127.0.0.1:6100` at another
   * data directory leaves the browser happily reusing the copy it already had. The symptom is
   * brutal to diagnose from the inside: the sidebar lists a thousand pages from the old graph
   * while search and backlinks answer from the new, empty one, and nothing anywhere says the two
   * halves disagree.
   */
  graphMismatch?: boolean;
}

/** The graph this device's replica belongs to. */
const GRAPH_KEY = "nooklet.graphId";

export function knownGraphId(): string | undefined {
  try {
    return localStorage.getItem(GRAPH_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function rememberGraphId(id: string): void {
  try {
    localStorage.setItem(GRAPH_KEY, id);
  } catch {
    // Private mode: the check simply will not fire next time.
  }
}

interface InjectedWindow {
  __NOOKLET__?: { token?: string | null; reason?: string; graphId?: string };
}

function injected(): { token?: string | null; reason?: string } | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as InjectedWindow).__NOOKLET__;
}

let cached: BootstrapConfig | undefined;

/**
 * Fetch this client's credentials from the server, then memoise them. Call once, before rendering
 * and before `initDb`.
 *
 * Why a fetch rather than reading the HTML: the service worker precaches `index.html` at BUILD
 * time, so from the second load onward the injected `window.__NOOKLET__` is whatever the build
 * contained — nothing. The app silently lost its token on every reload. The shell is static and
 * cacheable; a credential is neither.
 *
 * Falls back to whatever is available locally (a stored device token, the injected value, the dev
 * env var) when the request fails, so a genuinely offline launch still opens the local replica.
 */
export async function initBootstrap(): Promise<BootstrapConfig> {
  try {
    const res = await fetch(`${apiBaseUrl()}/api/session`, {
      headers: { accept: "application/json" },
    });
    if (res.ok) {
      const body = (await res.json()) as {
        token?: string | null;
        reason?: string;
        graphId?: string;
      };
      // A stored device token wins only when the server offers none: on loopback the server mints
      // a fresh token per process, and a token stored by an earlier run would be stale.
      const token = body.token ?? storedToken() ?? import.meta.env.VITE_NOOKLET_TOKEN ?? null;
      const graphId = body.graphId;
      const known = knownGraphId();
      // A first run has nothing to compare against, so adopt whatever the server says. Only a
      // CHANGE is a mismatch.
      if (graphId && !known) rememberGraphId(graphId);
      cached = {
        token,
        reason: token ? undefined : (body.reason ?? "no_token_available"),
        graphId,
        graphMismatch: Boolean(graphId && known && known !== graphId),
      };
      return cached;
    }
  } catch {
    // Offline, or no server at this origin — fall through to local sources.
  }
  cached = undefined;
  return bootstrapConfig();
}

export function bootstrapConfig(): BootstrapConfig {
  if (cached) return cached;
  const w = injected();
  // The env vars are the development path and a deliberate escape hatch: they let you point a
  // Vite dev server at a running backend, and they let a LAN/tailnet user supply the token the
  // server refused to inject.
  const envToken = import.meta.env.VITE_NOOKLET_TOKEN;
  // Injected first: on loopback the server mints a fresh token per process, so a token stored by
  // an earlier run would be stale. Stored second, which is the path every remote device takes.
  const token = w?.token ?? storedToken() ?? envToken ?? null;
  cached = {
    token,
    reason: token ? undefined : (w?.reason ?? "no_token_available"),
  };
  return cached;
}

export function authToken(): string | undefined {
  return bootstrapConfig().token ?? undefined;
}

/**
 * Base URL for the API and sync endpoints. Empty string means "same origin", which is the case
 * whenever the server serves the client — and it is why nothing needs configuring in that setup.
 */
export function apiBaseUrl(): string {
  return import.meta.env.VITE_API_BASE_URL ?? import.meta.env.VITE_SYNC_BASE_URL ?? "";
}

/** Test seam: reset the memoised config. */
export function resetBootstrapForTests(): void {
  cached = undefined;
}
