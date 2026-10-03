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
 */

/** Thrown for a `--link` value the app would refuse anyway; `cli.ts` prints the message. */
export class PairingLinkError extends Error {}

export function pairingLink(publicUrl: string, token: string, graphId: string): string {
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
  const server = `${url.origin}${path || `/g/${graphId}`}`;
  return `nooklet://connect?url=${encodeURIComponent(server)}&token=${encodeURIComponent(token)}`;
}
