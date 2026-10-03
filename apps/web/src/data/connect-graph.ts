/**
 * Verify a token against a graph, then remember it — the one piece of logic `ConnectView.tsx`
 * (this device's own onboarding gate) and `shell/GraphSwitcher.tsx` (ADR 025's "add an existing
 * remote graph" move, available any time after) both need identically. Kept out of
 * `data/bootstrap.ts` itself to avoid a cycle: `data/api-client.ts` (whose `describeError` this
 * needs) already imports FROM `bootstrap.ts`.
 */
import { describeError } from "./api-client.js";
import { setConnectedGraphToken } from "./bootstrap.js";

export type ConnectResult = { ok: true } | { ok: false; error: string };

/** `baseUrl: null` means "this page's own origin" (the non-Capacitor path — see
 * `setConnectedGraphToken`'s own doc comment for why that is a distinct case, not just an empty
 * string). Verifies before storing, so a typo or a token that was revoked fails here with a
 * readable reason rather than becoming a silent permanent "offline" screens later. */
export async function connectToGraph(
  typedBaseUrl: string | null,
  token: string,
): Promise<ConnectResult> {
  const baseUrl = typedBaseUrl === null ? null : graphBaseUrl(typedBaseUrl);
  const base = baseUrl ?? "";
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
    // Only remembered once the server has actually answered — a bad address/token must not stick.
    setConnectedGraphToken(baseUrl, token);
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

export interface PairingLink {
  /** The server address, validated as by `parseServerUrl` (so a bare origin is still mapped to
   * `/g/default` later by `connectToGraph`, exactly as for a typed address). */
  serverUrl: string;
  token: string;
}

/**
 * B-603: `nooklet://connect?url=<server address>&token=<device token>`, as printed by
 * `nooklet token create --link <public url>` (server `cli.ts`). Returns `undefined` for a
 * `nooklet://` link that is not a pairing link at all, so other deep links can be added later
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
  if (!url) return { error: "This pairing link has no server address (url=…)." };
  if (!token) return { error: "This pairing link has no token (token=…)." };
  if (!/^[A-Za-z0-9_-]{8,256}$/.test(token)) {
    return { error: "This pairing link's token is not a nooklet token." };
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
  return { serverUrl: parsed.url, token };
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
