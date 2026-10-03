/**
 * Client-side page auto-creation (B-568): a scoped mirror of
 * `packages/server/src/ref-pages.ts`'s `planReferencedPages`, for the one case that mechanism can
 * never reach — a device with no server at all (B-563's "Just this device"). `ref-pages.ts`'s own
 * doc comment: "Only the server decides ... Clients never create a page implicitly" — true for the
 * server-synced case; this file is what makes the same "pages exist once referenced" promise
 * (ADR 024) hold locally too, using only the client's own `page` table (no `ref`/`page_tag` index
 * — those are server-only derived tables, so this cannot and does not try to match the server's
 * logic byte-for-byte, only its outward behavior for the cases listed below).
 *
 * Scope, deliberately narrower than the server: `[[page]]`/`#tag`/`#[[multi word]]` refs from a
 * block's content, and the `Task` tag from a `block.create`'s marker — the common editor-driven
 * case, and what the owner's own report was about. NOT covered here (server-only for now, logged
 * as B-578): refs inside property values (`tags::` etc.), and the Task tag from a `block.prop`
 * marker change on an existing block (only a freshly-created marked block is covered). Also not
 * covered, deliberately, per B-568's own entry: the junk-cleanup side — a page this module creates
 * is never auto-deleted if the reference that prompted it is later removed.
 *
 * Deliberately does NOT use `REFERENCE_DEVICE_ID` (`packages/server/src/ref-pages.ts`) — that id
 * is reserved specifically so no real device can ever produce it; a client-created page is owned by
 * this device's own real id, like any other local write.
 *
 * Convergence with the server, once this device does sync: the `page.create` op this module mints
 * travels through the same `pending_op` outbox as the edit that prompted it, in the same batch —
 * so by the time the server's own `planReferencedPages` looks at the reference, it already resolves
 * (to the page this device created), and does not mint a competing one.
 *
 * B-585: only a device with no server runs this (`db/worker-core.ts#WorkerDbOptions.
 * localReferencePages`). On a synced device the server already mints these pages AND reclaims the
 * junk ones (a link edited one character at a time, a link deleted before anyone wrote in its page,
 * B-445's revival) — but only pages carrying `REFERENCE_DEVICE_ID`. A page minted here carries this
 * device's real id, so the server can never tell it from one the owner made on purpose: running
 * this on a synced device left every intermediate name of a slowly-typed link as a permanent page.
 *
 * Synchronous on purpose (B-585): it runs inside the worker's `applyLocalOps`, against the replica
 * directly. It used to run on the main thread before the batch was posted, awaiting a worker round
 * trip per lookup — which let a later `forceSync()` overtake the batch (Turn into page pushed the
 * block without its last keystrokes) and delayed the B-247 crash-safe copy of the batch.
 */
import {
  canonicalRefName,
  extractRefs,
  namespaceAncestors,
  normalizePageName,
  type Op,
  parseJournalTitle,
  TASK_TAG,
} from "@nooklet/core";

/** Mirrors `ref-pages.ts#referenceKey` exactly (same two calls) — kept local rather than a new
 * core export for two one-line functions used on just one side each. */
function referenceKey(name: string): string {
  return normalizePageName(canonicalRefName(name));
}

/** Mirrors `ref-pages.ts#isMintableName`: never a journal day (those come from the journal stream,
 * not a reference — see that file's header), never blank. */
function isMintableName(name: string): boolean {
  return name.trim() !== "" && parseJournalTitle(name) === null;
}

/** The page/tag names a batch's `block.text`/`block.create` ops reference, in op order — the
 * client-visible slice of `ref-pages.ts#pageNamesReferencedByBlock` (see header for what's out of
 * scope). `[]` for the overwhelmingly common edit that references nothing, which callers should
 * treat as a fast path — nothing else in this module does anything for an empty result. */
export function namesReferencedByOps(ops: readonly Op[]): string[] {
  const names: string[] = [];
  for (const op of ops) {
    if (op.payload.kind === "block.text") {
      const refs = extractRefs(op.payload.content, {});
      names.push(...refs.pageRefs, ...refs.tags);
    } else if (op.payload.kind === "block.create") {
      const refs = extractRefs(op.payload.content, {});
      names.push(...refs.pageRefs, ...refs.tags);
      if (op.payload.marker) names.push(TASK_TAG);
    }
  }
  return names;
}

/**
 * `name` and every namespace ancestor that is mintable and not already resolved by `pageExists` —
 * ancestors first, mirroring `ref-pages.ts#WantedPages.want`'s ordering ("so `A` is created before
 * `A/B`, as a reader would expect"). `wanted` accumulates key -> display name across the whole
 * batch so two references to the same missing page/ancestor mint exactly once.
 */
function want(
  name: string,
  wanted: Map<string, string>,
  pageExists: (key: string) => boolean,
): void {
  const trimmed = name.trim();
  if (!isMintableName(trimmed)) return;
  for (const n of [trimmed, ...namespaceAncestors(trimmed)].reverse()) {
    if (!isMintableName(n)) continue;
    const key = referenceKey(n);
    if (wanted.has(key)) continue;
    if (pageExists(key)) continue;
    wanted.set(key, n);
  }
}

/**
 * The `page.create` ops (this device's own id — see header) a batch needs so every reference it
 * introduces resolves to a real page locally, `[]` for the ordinary edit that references nothing
 * new. `pageExists`/`mint` are injected so this stays testable with fakes, no worker/DB/HLC clock
 * needed — the real caller (`db/worker-core.ts#WorkerDb.applyLocalOps`) wires them to the replica's
 * `page` table and the device's one clock.
 */
export function planLocalReferencedPages(
  ops: readonly Op[],
  pageExists: (key: string) => boolean,
  mint: (name: string) => Op,
): Op[] {
  const names = namesReferencedByOps(ops);
  if (names.length === 0) return [];
  const wanted = new Map<string, string>();
  for (const name of names) want(name, wanted, pageExists);
  if (wanted.size === 0) return [];
  const out: Op[] = [];
  for (const name of wanted.values()) out.push(mint(name));
  return out;
}
