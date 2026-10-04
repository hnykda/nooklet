/**
 * QR pairing with one-time codes (B-655), client side.
 *
 * The admin device (Settings → Devices) asks the server for a code (`pairing.create`) and shows a
 * QR of `<graph address>/pair#code=<code>`. A phone's camera opens that page (`../pair/`), whose
 * button hands `nooklet://connect?url=<graph address>&code=<code>` to the app; the app's confirm
 * screen trades the code for a token of its own (`pairing.redeem`) and connects with it.
 *
 * Why the QR holds an https page and not the custom scheme: see `docs/progress/qr-pairing.md`
 * ("Camera") — the iOS Camera app's handling of custom schemes is undocumented and reported
 * unreliable; every camera opens https. The code rides in the fragment, which browsers never send.
 */

import { callOp, describeError } from "./api-client.js";
import { graphBaseUrl, PAIRING_CODE_RE } from "./connect-graph.js";

export { PAIRING_CODE_RE };

/** `https://host[/proxy-path]/g/<id>` + `/pair#code=…`. */
export function pairingPageUrl(graphAddress: string, code: string): string {
  return `${graphAddress.replace(/\/+$/, "")}/pair#code=${encodeURIComponent(code)}`;
}

/** What the page's "Open in the nooklet app" button opens. */
export function pairingAppLink(graphAddress: string, code: string): string {
  return `nooklet://connect?url=${encodeURIComponent(graphAddress.replace(/\/+$/, ""))}&code=${encodeURIComponent(code)}`;
}

/** Whether this page load is the pairing page: `[/proxy-path]/g/<id>/pair`. Anchored on `/g/<id>`
 * so a page called "pair" (`/g/<id>/page/pair`) is still a page. Every pairing URL names its
 * graph (`pairingPageUrl` callers pass a graph address). */
export function isPairPath(pathname: string): boolean {
  return /\/g\/[a-z0-9-]+\/pair\/?$/.test(pathname);
}

/** The code from `#code=…`, if it looks like one. */
export function pairCodeFromHash(hash: string): string | undefined {
  const code = new URLSearchParams(hash.replace(/^#/, "")).get("code") ?? undefined;
  return code && PAIRING_CODE_RE.test(code) ? code : undefined;
}

/** A starting name for the token this device gets; the owner can change it before connecting. */
export function defaultDeviceLabel(userAgent: string): string {
  if (/iPhone/.test(userAgent)) return "iPhone";
  if (/iPad/.test(userAgent)) return "iPad";
  if (/Android/.test(userAgent)) return "Android";
  if (/Macintosh/.test(userAgent)) return "Mac";
  if (/Windows/.test(userAgent)) return "Windows PC";
  if (/Linux/.test(userAgent)) return "Linux PC";
  return "New device";
}

export type RedeemResult = { ok: true; token: string } | { ok: false; error: string };

/** `POST <graph>/api/v1/pairing.redeem` with no token: the one op a device can call before it has
 * one. `base` is the graph address (`""` for this page's own graph). */
export async function redeemPairingCode(
  base: string,
  code: string,
  label: string,
): Promise<RedeemResult> {
  const graph = base === "" ? "" : graphBaseUrl(base.replace(/\/+$/, ""));
  try {
    const res = await fetch(`${graph}/api/v1/pairing.redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, label }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => undefined)) as
      | { token?: string; error?: { message?: string } }
      | undefined;
    if (res.ok && typeof body?.token === "string") return { ok: true, token: body.token };
    if (res.status === 401)
      return {
        ok: false,
        error:
          "This pairing code is no longer valid: it expires after 10 minutes and works once. Make a new one on the device that showed it.",
      };
    if (res.status === 429)
      return { ok: false, error: "Too many attempts. Wait a minute, then try again." };
    return { ok: false, error: body?.error?.message ?? `Server returned ${res.status}.` };
  } catch (err) {
    return {
      ok: false,
      error: `Could not reach ${graph || "the server"}: ${describeError(err)}`,
    };
  }
}

// --- Device management (admin sessions only; Settings → Devices) --------------------------------

export interface DeviceToken {
  id: string;
  label: string;
  scope: "read" | "write" | "admin";
  sync: boolean;
  ui_control: boolean;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  current: boolean;
}

export async function listDevices(): Promise<DeviceToken[]> {
  return (await callOp<{ tokens: DeviceToken[] }>("token.list", {})).tokens;
}

export async function revokeDevice(id: string): Promise<void> {
  await callOp("token.revoke", { id });
}

export interface PairingCode {
  code: string;
  expires_at: number;
}

export async function createPairingCode(): Promise<PairingCode> {
  return callOp<PairingCode>("pairing.create", { scope: "write", sync: true });
}
