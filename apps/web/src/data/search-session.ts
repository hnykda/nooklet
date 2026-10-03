/**
 * The Search view's data: the device's keyword hits at once, the server's semantic matches added
 * when they arrive (server-search; the reasoning is in `./search-enrich.ts`).
 *
 * - Local: a resource over `searchLocal`, re-run on every keystroke and whenever the replica's
 *   `block`/`page` tables change (a pull bringing in what was just written elsewhere).
 * - Server: asked only when there is a server, sync is not offline, and the mode is not keyword;
 *   debounced, bounded by `ENRICH_TIMEOUT_MS`, and aborted the moment the query changes, so an old
 *   query's answer is never merged into a new query's list.
 */

import {
  type Accessor,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  onCleanup,
  type Resource,
  untrack,
} from "solid-js";
import { apiClient, type SearchInput, type SearchResult } from "./api-client.js";
import { hasSyncTarget } from "./bootstrap.js";
import { presenceOnDevice, searchLocal } from "./local-search.js";
import {
  askServer,
  ENRICH_DEBOUNCE_MS,
  mergeHits,
  type ServerAnswer,
  type ShownHit,
  stabilizeHits,
} from "./search-enrich.js";
import { stampedFor, useSyncStatus } from "./store.js";

export interface SearchSession {
  /** The device's own keyword answer. Errored only when the replica cannot search at all. */
  local: Resource<SearchResult | undefined>;
  /** What the server contributed (or why it did not). */
  server: Accessor<ServerAnswer>;
  /** The list to show: local hits with the server's folded in. */
  hits: Accessor<ShownHit[]>;
  /** Ask both again (the fallback note's Try again / Check again). */
  refetch(): void;
}

export interface SearchSessionOptions {
  /** True once the reader has put a pointer or focus on the result list; read once, when the
   * server's answer arrives, to decide whether it may re-rank (see `mergeHits`). */
  listTouched: Accessor<boolean>;
}

export function useSearch(
  input: Accessor<SearchInput | undefined>,
  opts: SearchSessionOptions,
): SearchSession {
  const [local, { refetch: refetchLocal }] = createResource(
    () => {
      const i = input();
      return i === undefined ? undefined : stampedFor(i, ["block", "page"]);
    },
    ({ value }) => searchLocal(value),
  );

  const syncStatus = useSyncStatus();
  const [server, setServer] = createSignal<ServerAnswer>({
    kind: "not-asked",
    why: "keyword-mode",
  });
  const [nonce, setNonce] = createSignal(0);

  createEffect(
    on([input, nonce], ([i], prev) => {
      if (i === undefined) {
        setServer({ kind: "not-asked", why: "keyword-mode" });
        return;
      }
      if (i.mode === "keyword") {
        setServer({ kind: "not-asked", why: "keyword-mode" });
        return;
      }
      if (!hasSyncTarget()) {
        setServer({ kind: "not-asked", why: "local-only" });
        return;
      }
      // Untracked: going offline mid-search should not re-ask, and coming back is a new search.
      if (untrack(syncStatus)?.state === "offline") {
        setServer({ kind: "not-asked", why: "offline" });
        return;
      }
      // "Try again" / "Check again" on a fallback note asks about the same query: the note stays
      // until the new answer replaces it. Unmounting it for the wait dropped the focus of the
      // button that was just pressed (B-525).
      const retry = prev !== undefined && prev[0] === i;
      if (!(retry && untrack(server).kind === "fell-back")) setServer({ kind: "pending" });
      const controller = new AbortController();
      const timer = setTimeout(() => {
        void askServer(i, controller.signal, {
          search: (si, o) => apiClient.search(si, o),
        }).then((answer) => {
          if (answer === undefined || controller.signal.aborted) return;
          setServer(
            answer.kind === "answered"
              ? { ...answer, adoptOrder: !untrack(opts.listTouched) }
              : answer,
          );
        });
      }, ENRICH_DEBOUNCE_MS);
      onCleanup(() => {
        clearTimeout(timer);
        controller.abort();
      });
    }),
  );

  const serverHits = createMemo(() => {
    const a = server();
    return a.kind === "answered" ? a.result.hits : undefined;
  });
  // Re-read when the replica changes too: a hit "not on this device yet" opens once it syncs.
  const [presence] = createResource(
    () => {
      const hits = serverHits();
      return hits && hits.length > 0 ? stampedFor(hits, ["block", "page"]) : undefined;
    },
    async ({ value }) => ({ for: value, map: await presenceOnDevice(value) }),
  );

  const merged = createMemo<ShownHit[]>(() => {
    const l = local.error === undefined ? (local()?.hits ?? []) : [];
    const a = server();
    const p = presence.error === undefined ? presence() : undefined;
    // Until the replica has said which server hits it holds, show only the device's own: a hit
    // marked "not on this device" for a frame and then opening would flicker.
    // `p.for`: a presence read for an earlier answer's hits says nothing about this one's.
    if (a.kind !== "answered" || p?.for !== a.result.hits) {
      return mergeHits(l, undefined, new Map(), false);
    }
    return mergeHits(l, a.result.hits, p.map, a.adoptOrder);
  });
  const hits = createMemo<ShownHit[]>((prev) => stabilizeHits(prev, merged()), []);

  return {
    local,
    server,
    hits,
    refetch() {
      refetchLocal();
      setNonce((n) => n + 1);
    },
  };
}
