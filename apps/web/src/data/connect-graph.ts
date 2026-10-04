/**
 * Verify a token against a graph, then remember it — the one piece of logic `ConnectView.tsx`
 * (this device's own onboarding gate) and `shell/GraphSwitcher.tsx` (ADR 025's "add an existing
 * remote graph" move, available any time after) both need identically. Kept out of
 * `data/bootstrap.ts` itself to avoid a cycle: `data/api-client.ts` (whose `describeError` this
 * needs) already imports FROM `bootstrap.ts`.
 */
import { describeError } from "./api-client.js";
import { samePathGraphPrefix, setConnectedGraphToken } from "./bootstrap.js";

export type ConnectResult = { ok: true } | { ok: false; error: string };

/**
 * B-613: everything the re-pair screen (`ConnectView.tsx`'s `repair` prop) needs to put a new token
 * on an EXISTING entry rather than create one. `connectBase` is what `connectToGraph` gets: `null`
 * for a same-origin entry (web/desktop, `baseUrl` like `/g/default`), which updates the active
 * entry in place; the absolute address for a Capacitor entry, which `setConnectedGraphToken`
 * matches back to the same entry. Either way the entry keeps its id, so its local replica (keyed
 * by that id) and its unpushed `pending_op` rows are the ones that sync once the token works.
 */
export interface RepairTarget {
  connectBase: string | null;
  /** Shown read-only: the address is the entry's, not something to change while re-pairing. */
  displayUrl: string;
  /** Where to ask `/api/session` whether this browser would simply be handed a new token. */
  sessionBase: string;
  /** The `/g/<slug>` the entry points at, for the `nooklet token create --graph` hint. */
  graphSlug?: string;
}

export function repairTargetFor(baseUrl: string | undefined, origin: string): RepairTarget {
  const graphSlug = graphSlugOf(baseUrl);
  if (baseUrl && /^https?:\/\//i.test(baseUrl)) {
    return { connectBase: baseUrl, displayUrl: baseUrl, sessionBase: baseUrl, graphSlug };
  }
  return {
    connectBase: null,
    displayUrl: `${origin}${baseUrl ?? ""}`,
    sessionBase: baseUrl ?? "",
    graphSlug,
  };
}

/** `baseUrl: null` means "this page's own origin" (the non-Capacitor path — see
 * `setConnectedGraphToken`'s own doc comment for why that is a distinct case, not just an empty
 * string). Verifies before storing, so a typo or a token that was revoked fails here with a
 * readable reason rather than becoming a silent permanent "offline" screens later. */
export async function connectToGraph(
  typedBaseUrl: string | null,
  token: string,
): Promise<ConnectResult> {
  const baseUrl = typedBaseUrl === null ? null : graphBaseUrl(typedBaseUrl);
  // Same-origin: verify against THIS page's graph. A bare "" resolved to the server's bare-origin
  // redirect, i.e. always the default graph, so on `/g/work` a valid `work` token was "rejected".
  const base = baseUrl ?? samePathGraphPrefix() ?? "";
  try {
    const res = await fetch(`${base}/api/v1/graph.overview`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: "{}",
    });
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        error: "That token was rejected. Check it was copied whole, and not revoked.",
      };
    }
    if (!res.ok) {
      return { ok: false, error: `Server returned ${res.status}. Is this the right address?` };
    }
    // B-618: the graph's own label names the entry, rather than "This graph"/"Remote graph".
    const overview = (await res.json().catch(() => undefined)) as
      | { graph?: { label?: unknown } }
      | undefined;
    const label = typeof overview?.graph?.label === "string" ? overview.graph.label : undefined;
    // Only remembered once the server has actually answered — a bad address/token must not stick.
    setConnectedGraphToken(baseUrl, token, label);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: baseUrl
        ? `Could not reach ${baseUrl}: ${describeError(err)}`
        : `Could not reach the server: ${describeError(err)}`,
    };
  }
}

/**
 * A server address typed with no path (`http://192.168.1.5:6100`, `https://nooklet.example.ts.net`)
 * means that server's default graph, so it is stored as `<origin>/g/default` — the same place the
 * server's own bare-origin 307 fallback sends a plain HTTP request.
 *
 * Storing the bare origin instead LOOKS fine (every fetch follows the 307) but is not: a
 * WebSocket never follows a redirect, so `/sync/live` at bare origin never opens and live sync
 * silently never connects (`tools/probes/ws-bare-origin.mjs`). An address that already has a path
 * (`/g/work`, or a reverse-proxy subpath) is kept exactly as typed.
 */
export function graphBaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.pathname === "/" || parsed.pathname === "") {
      return `${url.replace(/\/+$/, "")}/g/default`;
    }
  } catch {
    // Not absolute — leave it to the fetch to fail with a readable reason.
  }
  return url;
}

/** `http://` or `https://` required rather than guessed, so a bare `nooklet.example.com` (missing
 * scheme) fails here with a readable reason instead of `fetch` treating it as a relative path and
 * failing three screens later with no context. */
export function parseServerUrl(raw: string): { url: string } | { error: string } {
  const value = raw.trim().replace(/\/+$/, "");
  if (!value) return { error: "Enter the server's address." };
  if (!/^https?:\/\//i.test(value)) {
    return {
      error:
        "Include http:// or https:// — e.g. https://nooklet.example.com or http://192.168.1.5:6100.",
    };
  }
  return { url: value };
}

/** A one-time pairing code (B-655). Matches the server's `PAIRING_CODE_RE`
 * (`packages/server/src/auth/pairing-codes.ts`). */
export const PAIRING_CODE_RE = /^nkp_[A-Za-z0-9_-]{22}$/;

export type PairingLink = {
  /** The server address, validated as by `parseServerUrl` (so a bare origin is still mapped to
   * `/g/default` later by `connectToGraph`, exactly as for a typed address). */
  serverUrl: string;
  /** This page's own graph (the browser path of the pairing page): connect same-origin, as the
   * web/desktop connect screen does, rather than adding a "remote" entry for our own address. */
  sameOrigin?: boolean;
} & ({ token: string; code?: undefined } | { code: string; token?: undefined });

/**
 * B-603: `nooklet://connect?url=<server address>&token=<device token>`, as printed by
 * `nooklet token create --link <public url>` (server `cli.ts`), and (B-655) the same with
 * `code=<one-time pairing code>` instead of a token, from the QR pairing page. Returns `undefined`
 * for a `nooklet://` link that is not a pairing link at all, so other deep links can be added later
 * without this claiming them.
 *
 * Strict on purpose. Anything that can open a URL on the phone can craft one of these: a web page,
 * a QR code on a poster, a message. The link is therefore never acted on silently (the app shows
 * the connect screen pre-filled, with the address in plain view, and waits for a tap), and what is
 * shown must be what would be contacted: only http(s), and no `user:pass@` part, which would let
 * `https://my-server@evil.example` read as "my-server" at a glance.
 */
export function parsePairingLink(raw: string): PairingLink | { error: string } | undefined {
  let link: URL;
  try {
    link = new URL(raw);
  } catch {
    return undefined;
  }
  if (link.protocol !== "nooklet:") return undefined;
  // `nooklet://connect?...` parses with host "connect" in a browser engine; a URL parser that treats
  // the scheme as opaque gives pathname "//connect" instead. Accept both.
  const target = (link.host || link.pathname.replace(/^\/+/, "")).replace(/\/+$/, "");
  if (target !== "connect") return undefined;

  const url = link.searchParams.get("url");
  const token = link.searchParams.get("token")?.trim();
  const code = link.searchParams.get("code")?.trim();
  if (!url) return { error: "This pairing link has no server address (url=…)." };
  // Exactly one credential. Both at once is not something either producer writes.
  if (token && code) return { error: "This pairing link has both a token and a code." };
  if (!token && !code) return { error: "This pairing link has no pairing code (code=…)." };
  if (token !== undefined && !/^[A-Za-z0-9_-]{8,256}$/.test(token)) {
    return { error: "This pairing link's token is not a nooklet token." };
  }
  if (code !== undefined && !PAIRING_CODE_RE.test(code)) {
    return { error: "This pairing link's code is not a nooklet pairing code." };
  }
  const parsed = parseServerUrl(url);
  if ("error" in parsed)
    return { error: `This pairing link's server address is not usable. ${parsed.error}` };
  let server: URL;
  try {
    server = new URL(parsed.url);
  } catch {
    return { error: "This pairing link's server address is not a valid URL." };
  }
  if (server.username || server.password) {
    return { error: "This pairing link's server address contains a user name; refusing it." };
  }
  return code ? { serverUrl: parsed.url, code } : { serverUrl: parsed.url, token: token as string };
}

export type CreateGraphResult =
  | { ok: true; baseUrl: string; token: string }
  | { ok: false; error: string };

/**
 * ADR 025 move 2 — "promote a local-only graph": `POST /graphs` against `serverUrl` with the
 * server's ROOT token (a different, more sensitive credential than a graph token — it can create
 * and list every graph the server hosts, not just read/write one). The server creates the graph
 * genuinely empty, so pointing this device's EXISTING local-only entry at the result (its
 * `baseUrl`/`token`, done by the caller — see `shell/GraphSwitcher.tsx`) is a push, not a merge:
 * this device's own `pending_op` backlog (still there in full, since a local-only replica has
 * never had anywhere to push it — verified against `sync-client.test.ts`'s B-301 coverage before
 * writing this) drains to the new graph the moment a reload reconnects, no new sync-engine code
 * needed.
 */
export async function createGraphOnServer(
  serverUrl: string,
  graphId: string,
  label: string,
  rootToken: string,
): Promise<CreateGraphResult> {
  try {
    const res = await fetch(`${serverUrl}/graphs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${rootToken}` },
      body: JSON.stringify({ id: graphId, label }),
    });
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        error: "That root token was rejected. Check it was copied whole, and not revoked.",
      };
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as
        | { error?: { message?: string } }
        | undefined;
      return { ok: false, error: body?.error?.message ?? `Server returned ${res.status}.` };
    }
    const body = (await res.json()) as { id: string; token: string };
    return { ok: true, baseUrl: `${serverUrl}/g/${body.id}`, token: body.token };
  } catch (err) {
    return { ok: false, error: `Could not reach ${serverUrl}: ${describeError(err)}` };
  }
}

/**
 * B-618: the label the server has for the graph at `baseUrl`, via the same graph-scoped
 * `graph.overview` the connect flow verifies with (so any token that can sync can name its graph;
 * `GET /graphs` needs the root token). `undefined` on any failure — callers fall back to the slug.
 */
export async function fetchGraphLabel(baseUrl: string, token: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/graph.overview`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: "{}",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { graph?: { label?: unknown } };
    return typeof body.graph?.label === "string" ? body.graph.label : undefined;
  } catch {
    return undefined;
  }
}

/** The `/g/<slug>` an address points at, if any. */
export function graphSlugOf(baseUrl: string | undefined): string | undefined {
  return baseUrl ? /\/g\/([a-z0-9-]+)\/?$/.exec(baseUrl)?.[1] : undefined;
}

/** The server an address belongs to: the address with any trailing `/g/<slug>` removed (a reverse
 * proxy's own subpath, if there is one, is kept). */
export function serverRootOf(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/g\/[a-z0-9-]+$/, "");
}

export interface ServerGraph {
  id: string;
  label: string;
  /** The address to add it by: `<server root>/g/<id>`. */
  url: string;
}

export type ListGraphsResult = { ok: true; graphs: ServerGraph[] } | { ok: false; error: string };

/**
 * B-618: the graphs a server hosts, for the switcher's add form to offer. `GET /graphs` is gated
 * by the server's ROOT token (ADR 025) — a device token cannot list, and says so readably.
 */
export async function listServerGraphs(typedUrl: string, token: string): Promise<ListGraphsResult> {
  const root = serverRootOf(typedUrl);
  try {
    const res = await fetch(`${root}/graphs`, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        error:
          "Listing a server's graphs needs its root token (run `nooklet token root` there). A device token can only open the graph it was made for.",
      };
    }
    if (!res.ok) return { ok: false, error: `Server returned ${res.status}.` };
    const body = (await res.json()) as { graphs?: Array<{ id?: unknown; label?: unknown }> };
    const graphs = (body.graphs ?? []).flatMap((g) =>
      typeof g.id === "string"
        ? [
            {
              id: g.id,
              label: typeof g.label === "string" && g.label ? g.label : g.id,
              url: `${root}/g/${g.id}`,
            },
          ]
        : [],
    );
    return { ok: true, graphs };
  } catch (err) {
    return { ok: false, error: `Could not reach ${root}: ${describeError(err)}` };
  }
}
