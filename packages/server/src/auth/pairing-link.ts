/**
 * B-603: the `nooklet://connect?url=…&token=…` link `nooklet token create --link <public url>`
 * prints. The app side is `apps/web/src/data/connect-graph.ts#parsePairingLink`, which is the
 * stricter of the two. This side only has to produce something that passes it.
 *
 * The link CONTAINS the token. Whoever sees it can sync with the graph until the token is revoked,
 * so it leaks wherever the link travels: the clipboard (and Universal Clipboard to every device on
 * the Apple ID), shell history if pasted into a command, chat apps, screenshots, the history of
 * the browser it is opened from. The app never connects without the owner confirming the address,
 * but that protects the phone, not the token. Mint a token per device and revoke on any doubt.
 *
 * Superseded for new pairings by one-time codes (`nooklet pair`, Settings → Devices;
 * `./pairing-codes.ts`): a code in a link is dead after one use or ten minutes. The token link
 * keeps working (`token create --link`) for scripts and for a device that cannot reach the
 * server's pairing page, but is documented as the less safe option.
 */

/** Thrown for a `--link` value the app would refuse anyway; `cli.ts` prints the message. */
export class PairingLinkError extends Error {}

export function pairingLink(publicUrl: string, token: string, graphId: string): string {
  const server = graphAddress(publicUrl, graphId);
  return `nooklet://connect?url=${encodeURIComponent(server)}&token=${encodeURIComponent(token)}`;
}

/**
 * QR pairing (B-655): the https page a phone's camera opens, `<graph address>/pair#code=<code>`.
 *
 * Why https and not `nooklet://connect?…&code=…` directly: whether the iOS Camera app offers to
 * open a QR holding a custom-scheme URL is undocumented, and developer reports say it treats one as
 * text or hands it to the browser (`docs/progress/qr-pairing.md`, "Camera"). Every camera opens an
 * https URL. The page (`apps/web/src/pair/`) then offers "Open in the nooklet app" (the custom
 * scheme, from a tap, which iOS does honour) or "use this browser".
 *
 * The code sits in the FRAGMENT: browsers never send it, so it does not reach the server's, a
 * proxy's or Tailscale's access logs, and the page served is the same static file for every code.
 */
export function pairingPageUrl(publicUrl: string, code: string, graphId: string): string {
  return `${graphAddress(publicUrl, graphId)}/pair#code=${encodeURIComponent(code)}`;
}

/** The app-side link with a one-time code instead of a token (`parsePairingLink` in the app). */
export function pairingCodeLink(publicUrl: string, code: string, graphId: string): string {
  const server = graphAddress(publicUrl, graphId);
  return `nooklet://connect?url=${encodeURIComponent(server)}&code=${encodeURIComponent(code)}`;
}

/** `<origin>[<path>]` naming one graph, validated as the app would. */
export function graphAddress(publicUrl: string, graphId: string): string {
  let url: URL;
  try {
    url = new URL(publicUrl.trim());
  } catch {
    throw new PairingLinkError(
      `--link needs the address devices use to reach this server, e.g. --link http://192.168.1.5:6100 (got "${publicUrl}")`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PairingLinkError(
      `--link must be an http:// or https:// address (got "${publicUrl}")`,
    );
  }
  if (url.username || url.password) {
    throw new PairingLinkError("--link must not contain a user name or password");
  }
  if (url.search || url.hash) {
    throw new PairingLinkError("--link must be a plain server address, without ?query or #hash");
  }
  // A bare address names this graph explicitly, so the link is right for `--graph work` too, and
  // a WebSocket never has to rely on the server's bare-origin redirect (B-599).
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path || `/g/${graphId}`}`;
}
