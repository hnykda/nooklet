/**
 * B-641's rule for reads the replica can answer and the server can too (references, the link
 * graph): the device's answer, always — it works offline and in local-only mode and is the same
 * code as the server's — and the server's only when the device could not answer at all (its
 * SQLite could not build the reference index) and there is a server to ask. A device answer is
 * never second-guessed by the server: there is no "real reason" to, once the replica holds the
 * graph.
 */

import { hasSyncTarget } from "./bootstrap.js";

export async function localFirst<T>(
  local: () => Promise<T>,
  server: () => Promise<T>,
  hasServer: () => boolean = hasSyncTarget,
): Promise<T> {
  try {
    return await local();
  } catch (err) {
    if (hasServer()) return server();
    throw err;
  }
}
