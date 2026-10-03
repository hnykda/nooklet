/**
 * B-631: what "Discard the local copy and re-sync" (`views/GraphMismatchView.tsx`) deletes — the
 * active graph's replica and the per-graph state kept for it, all keyed by replica since B-611 — and
 * nothing that belongs to another graph. It used to remove every OPFS entry: the `opfs-sahpool`
 * directory holds every graph's replica, so a local-only graph's notes, which exist nowhere else,
 * went with it.
 */
import { clearStoredShelf } from "../app/shelf.js";
import { discardThisReplica } from "../db/client.js";
import { clearReplicaDrafts } from "./journal-draft-store.js";

export async function discardActiveReplica(): Promise<void> {
  // The replica first: when it cannot be deleted (another tab holds it), nothing else is touched.
  await discardThisReplica();
  clearReplicaDrafts();
  clearStoredShelf();
}
