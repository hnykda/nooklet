/**
 * Local-first search, then enrich (server-search). The pure half: asking the server for semantic
 * matches under a time bound, merging its answer into what the device already shows, and the one
 * line that says which of the two answered. `./search-session.ts` wires it to signals.
 *
 * Why local first and not "ask the server, fall back on a timeout": on a phone over Tailscale a
 * server round trip plus embedding the query is roughly 0.2–1 s, local FTS a few milliseconds. A
 * timeout-based fallback would make every search slow exactly when the network is mediocre. So the
 * device's keyword hits are on screen at once, and the server's are added when (if) they come.
 */

import {
  ApiError,
  type CallOpOptions,
  describeError,
  type SearchFallback,
  type SearchHit,
  type SearchInput,
  type SearchResult,
} from "./api-client.js";

/**
 * How long to wait for the server's semantic matches before giving up on them. It never delays
 * anything on screen — the device's keyword hits are already there — it only ends "asking the
 * server…". A warm embedding model answers in well under a second; a cold Ollama loads the model
 * on the first query after its keep-alive lapses (1.4–5.9 s measured for bge-m3, see the
 * server's `QUERY_EMBED_TIMEOUT_MS`), so a first query after a long idle may miss this and the
 * next one, a warm model, will not.
 */
export const ENRICH_TIMEOUT_MS = 6_000;
/** Typing pause before the server is asked: a request per keystroke would queue embeddings for
 * queries nobody reads. Local search runs on every keystroke regardless. */
export const ENRICH_DEBOUNCE_MS = 250;

/** What the server contributed to the search on screen. */
export type ServerAnswer =
  /** Not asked: keyword mode (the device answers that alone), no server, or offline. */
  | { kind: "not-asked"; why: "keyword-mode" | "local-only" | "offline" }
  | { kind: "pending" }
  /** Semantic matches arrived. `adoptOrder` is decided once, at arrival (see `mergeHits`). */
  | { kind: "answered"; result: SearchResult; adoptOrder: boolean }
  /** The server answered but semantic search did not run there (not set up, indexing, …). */
  | { kind: "fell-back"; fallback?: SearchFallback }
  | { kind: "timed-out" }
  | { kind: "failed"; message: string };

export interface EnrichDeps {
  search(input: SearchInput, opts: CallOpOptions): Promise<SearchResult>;
  timeoutMs?: number;
}

/**
 * Ask the server for `input` under `ENRICH_TIMEOUT_MS`. Never throws; an abort by `signal`
 * (the query changed) resolves to `undefined`, so a slow answer for an old query is never shown.
 */
export async function askServer(
  input: SearchInput,
  signal: AbortSignal,
  deps: EnrichDeps,
): Promise<Exclude<ServerAnswer, { kind: "not-asked" | "pending" }> | undefined> {
  const timeoutMs = deps.timeoutMs ?? ENRICH_TIMEOUT_MS;
  try {
    const result = await deps.search(input, { signal, timeoutMs });
    if (signal.aborted) return undefined;
    if (result.modeUsed === "keyword") return { kind: "fell-back", fallback: result.fallback };
    return { kind: "answered", result, adoptOrder: true };
  } catch (err) {
    if (signal.aborted) return undefined;
    if (err instanceof ApiError && err.code === "timeout") return { kind: "timed-out" };
    // `describeError`: the address it tried and the server's hint, not just "Failed to fetch" (B-330).
    return { kind: "failed", message: describeError(err) };
  }
}

/** A hit as the Search view shows it. */
export interface ShownHit extends SearchHit {
  /** Found by the server's semantic search and not by the device's keyword search. */
  semantic: boolean;
  /** The replica has it, so it opens here. False for a hit the server has and this device has
   * not synced yet. */
  onDevice: boolean;
}

const keyOf = (h: Pick<SearchHit, "kind" | "id">): string => `${h.kind}:${h.id}`;

/**
 * The device's keyword hits with the server's answer folded in.
 *
 * - A server hit this device also found keeps the device's snippet (its text may be newer than
 *   the server's) and is not marked semantic: the keyword match already explains it.
 * - A server hit the device did not find is marked `semantic`. If the replica has it deleted, it
 *   is dropped (this device is ahead); if the replica lacks it, it is kept with `onDevice: false`.
 * - Order: `adoptOrder` takes the server's ranking (fusion of keyword and meaning), then any
 *   device-only hits — those the server has not seen yet. Without it, the device's rows stay
 *   exactly where they are and the server's additions go below them: a row must not move under a
 *   pointer or a focus the reader has already put on the list (the palette's B-493 is what a
 *   re-sort under a resting pointer does). The view decides which, once, when the answer arrives.
 */
export function mergeHits(
  local: readonly SearchHit[],
  server: readonly SearchHit[] | undefined,
  presence: ReadonlyMap<string, "live" | "deleted">,
  adoptOrder: boolean,
): ShownHit[] {
  const localByKey = new Map(local.map((h) => [keyOf(h), h]));
  const shownLocal: ShownHit[] = local.map((h) => ({ ...h, semantic: false, onDevice: true }));
  if (!server || server.length === 0) return shownLocal;

  const fromServer: ShownHit[] = [];
  const seen = new Set<string>();
  for (const h of server) {
    const key = keyOf(h);
    if (seen.has(key)) continue;
    seen.add(key);
    const mine = localByKey.get(key);
    if (mine) {
      fromServer.push({ ...mine, semantic: false, onDevice: true });
      continue;
    }
    const state = presence.get(key);
    if (state === "deleted") continue;
    fromServer.push({ ...h, semantic: true, onDevice: state === "live" });
  }

  if (adoptOrder) {
    return [...fromServer, ...shownLocal.filter((h) => !seen.has(keyOf(h)))];
  }
  return [...shownLocal, ...fromServer.filter((h) => !localByKey.has(keyOf(h)))];
}

function sameHit(a: ShownHit, b: ShownHit): boolean {
  return (
    a.snippet === b.snippet &&
    a.page === b.page &&
    a.semantic === b.semantic &&
    a.onDevice === b.onDevice &&
    a.updatedAt === b.updatedAt &&
    a.breadcrumb.length === b.breadcrumb.length &&
    a.breadcrumb.every((c, i) => c === b.breadcrumb[i])
  );
}

/**
 * `next`, reusing `prev`'s object for every hit that did not change. `<For>` keys rows by
 * reference: without this, every merge (the server answering, a pull re-running local search)
 * rebuilt every row's DOM, and a row the reader had focused lost focus while staying put.
 */
export function stabilizeHits(prev: readonly ShownHit[], next: readonly ShownHit[]): ShownHit[] {
  const byKey = new Map(prev.map((h) => [keyOf(h), h]));
  return next.map((h) => {
    const old = byKey.get(keyOf(h));
    return old && sameHit(old, h) ? old : h;
  });
}

/** The quiet line under the search box: which side answered. `null` while a server fallback note
 * (`SearchFallbackNote`) says it instead. */
export function searchSourceLine(answer: ServerAnswer, semanticCount: number): string | null {
  switch (answer.kind) {
    case "not-asked":
      return answer.why === "keyword-mode"
        ? "Keyword search on this device."
        : answer.why === "local-only"
          ? "Keyword search on this device (local-only)."
          : "Keyword search on this device (offline).";
    case "pending":
      return "Keyword results from this device · asking the server for semantic matches…";
    case "answered":
      return semanticCount > 0
        ? `Keyword (this device) and semantic (server) · ${semanticCount} found by meaning.`
        : "Keyword (this device) and semantic (server).";
    case "fell-back":
      return null;
    case "timed-out":
      return "Keyword search on this device · the server did not answer in time.";
    case "failed":
      return `Keyword search on this device · the server's semantic search failed: ${answer.message}`;
  }
}
