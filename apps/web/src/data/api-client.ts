/**
 * The client's one way to call a server op: `callOp` (`POST /api/v1/<op>` with this device's
 * token, every failure an `ApiError`) and `describeError` to render one. Every panel that needs
 * the server — Settings, References, Diagnostics, Trash/History (`./history.ts`), the refactor ops
 * and `batch.undo` (`./refactor-api.ts`) — calls through it (B-330).
 *
 * Also here: `apiClient`, the typed wrappers for the read ops the local replica cannot answer on
 * its own — `search`, `page.backlinks` (docs/spec/mcp-tools.md §4.3.5/§4.3.6) and `graph.links`.
 * The client-only schema (`@nooklet/core`'s `CORE_SCHEMA_STATEMENTS`, mirrored by
 * `../db/schema-client.ts`) has no `ref`/`path_ref`/`embedding*` tables —
 * those are server-only derived tables (docs/spec/sql-schema.md rule 1) — so references and the
 * link graph must go over HTTP rather than through the worker. Search no longer must: the replica
 * has its own keyword index, and `search` here only adds the server's semantic matches
 * (`./search-session.ts`).
 *
 * Auth: `./bootstrap.ts`'s token — handed out by `/api/session` on loopback, pasted into the
 * connect screen and kept in `localStorage` on any other device — read on every call, so a token
 * that arrives after this module loads is still seen.
 */

import { apiBaseUrl, authToken, hasSyncTarget } from "./bootstrap.js";

export interface SearchHit {
  kind: "block" | "page";
  id: string;
  page: string;
  journalDate?: string;
  snippet: string;
  breadcrumb: string[];
  score: number;
  updatedAt: string;
}

export interface SearchInput {
  query: string;
  mode?: "hybrid" | "keyword" | "semantic";
  scope?: "blocks" | "pages" | "all";
  tags?: string[];
  /** Exact key=value filters; `marker`/`priority` match the block's task columns (B-238). */
  properties?: Record<string, string>;
  namespace?: string;
  journalsOnly?: boolean;
  updatedAfter?: string;
  updatedBefore?: string;
  limit?: number;
  cursor?: string;
}

/** Why the server fell back to keyword search (B-520). Mirrors `search`'s `fallback` output; the
 * server's `SemanticFallbackReason` in `packages/server/src/embeddings/semantic-search.ts` is the
 * list. Kept as `string` beyond the known values so a newer server's reason still renders its own
 * `message` instead of failing a type the client compiled against. */
export interface SearchFallback {
  reason:
    | "sqlite_vec_unavailable"
    | "not_configured"
    | "indexing"
    | "index_incomplete"
    | "provider_unreachable"
    | "model_missing"
    | "query_embedding_failed"
    | (string & {});
  message: string;
  provider?: string;
  model?: string;
  host?: string;
  indexed?: number;
  total?: number;
  errors?: number;
  error?: string;
}

export interface SearchResult {
  hits: SearchHit[];
  cursor?: string;
  modeUsed: "hybrid" | "keyword" | "semantic";
  /** Present exactly when `modeUsed` is not the mode that was asked for. */
  fallback?: SearchFallback;
}

export interface BacklinkRef {
  id: string;
  page: string;
  text: string;
  updatedAt?: string;
  /** The block links the target itself (its own refs), rather than only sitting under a block
   * that does. Linked references only; what the heading counts (refs-count, Logseq's rule). An
   * older server sends nothing, read as `true` — counting every block, as before. */
  direct?: boolean;
}

/** A page carrying the backlinks target as a page-level tag (ADR 017, B-111). */
export interface TaggedPage {
  id: string;
  /** Wire name — a journal's ISO date. */
  page: string;
  /** `intrinsic` is derived (every journal day is a `Journal`) and cannot be removed. */
  source: "property" | "intrinsic";
}

export interface BacklinksResult {
  target: string;
  /** Every linked reference, up to `MAX_LINKED_REFERENCES` (see `linkedTotal`). */
  linked: BacklinkRef[];
  /** How many linked references there are, whether or not all of them are in `linked`. */
  linkedTotal: number;
  /** How many of `linkedTotal` link the target directly: the heading's unfiltered count. */
  linkedDirectTotal: number;
  unlinked: BacklinkRef[];
  /** More unlinked mentions exist than `unlinked` holds. */
  unlinkedTruncated: boolean;
  taggedPages: TaggedPage[];
  /** How many pages carry the target as a page-level tag, whether or not all are in `taggedPages`. */
  taggedTotal: number;
}

/** Linked references fetched per page (the server's `Limit` ceiling). */
const BACKLINKS_PAGE = 500;
/** Linked references a panel holds at most. The real graph's busiest page ("task") has 1,074; a
 * page past this still shows its true count, and says the list is partial. */
export const MAX_LINKED_REFERENCES = 5000;
/** Unlinked mentions asked for: the most one `mentions.link` call rewrites, so what the panel
 * counts is what Link all changes. */
export const MAX_UNLINKED_MENTIONS = 500;

export interface GraphNode {
  id: string;
  /** Display name; a journal's ISO date (the API's wire name, sql-schema.md rule 18). */
  name: string;
  isJournal: boolean;
  /** References touching this page, incoming plus outgoing — what the view sizes nodes by. */
  refCount: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  count: number;
}

export interface GraphLinksResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  totalNodes: number;
  totalEdges: number;
  truncated: boolean;
  /** What was left out, when something was. Render it — a silently truncated graph is a lie. */
  note?: string;
}

export interface GraphLinksInput {
  includeJournals?: boolean;
  limit?: number;
}

function authHeaders(): HeadersInit {
  const token = authToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** What a `/api/v1/<op>` reply means: the body, or an `ApiError` built from `{error}` / status. */
async function unwrap<TOut>(res: Response): Promise<TOut> {
  const json = (await res.json().catch(() => undefined)) as
    | TOut
    | { error: { code: string; message: string; hint?: string } }
    | undefined;
  if (!res.ok || (json && typeof json === "object" && "error" in json)) {
    const err = (json as { error?: { code: string; message: string; hint?: string } } | undefined)
      ?.error;
    throw new ApiError(err?.code ?? "internal", err?.message ?? res.statusText, err?.hint);
  }
  return json as TOut;
}

/**
 * POST one op with this device's token and turn every failure into an `ApiError`.
 *
 * The call every panel that needs the server had copied by the end of M7 — Settings, References,
 * Diagnostics, history, the refactor ops — each with its own error class and its own wording.
 * A rejected fetch carries only "Failed to fetch", true but unactionable, so it gets the address
 * it failed to reach attached; a non-2xx carries the server's `{error: {code, message, hint}}`,
 * which is where `embeddings.configure` puts "Ollama isn't running" and "pull that model first".
 * Render one with `describeError` so the hint is not lost.
 */
/** B-564: matches `sync/http-transport.ts`'s `SYNC_TIMEOUT_MS` — same failure class (a request
 * that never resolves, rather than fails fast, leaves whatever resource awaits it on "Loading…"
 * forever), same fix. A server that answers, even with an error, is not what this bounds. */
const API_TIMEOUT_MS = 10_000;

/** B-577: every caller of `callOp` needs a server — search, references, the graph, diagnostics,
 * the rest — so a device with no sync target at all (Capacitor's "Just this device", B-563) would
 * otherwise hit a real, alarming network failure on every one of these, one panel at a time, each
 * inventing its own "is this actually broken, or just not configured" detection. Fail fast with one
 * recognizable code instead, so every caller can share one calm render branch. */
export const NO_SYNC_TARGET_CODE = "no_sync_target";

export interface CallOpOptions {
  /** Cancels the request, e.g. because the search it answers is no longer the one on screen.
   * An abort by this signal rejects with an `ApiError` whose code is `"aborted"`. */
  signal?: AbortSignal;
  /** Overrides `API_TIMEOUT_MS` for a caller that would rather give up sooner. */
  timeoutMs?: number;
}

export async function callOp<TOut>(
  name: string,
  body: unknown,
  opts: CallOpOptions = {},
): Promise<TOut> {
  if (!hasSyncTarget()) {
    throw new ApiError(NO_SYNC_TARGET_CODE, "This device isn't configured to sync with a server.");
  }
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? API_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl()}/api/v1/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw new ApiError("aborted", "the request was cancelled");
    if (timeout.aborted) {
      throw new ApiError(
        "timeout",
        `${apiBaseUrl() || location.origin} did not answer within ${(opts.timeoutMs ?? API_TIMEOUT_MS) / 1000} s`,
      );
    }
    throw new ApiError(
      "network",
      `could not reach ${apiBaseUrl() || location.origin} (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  return unwrap<TOut>(res);
}

/** One sentence for a failure: the server's message with its hint, or whatever was thrown. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError && err.hint) return `${err.message} ${err.hint}`;
  return err instanceof Error ? err.message : String(err);
}

interface SearchWireHit {
  kind: "block" | "page";
  id: string;
  page: string;
  journal_date?: string;
  snippet: string;
  breadcrumb: string[];
  score: number;
  updated_at: string;
}

interface SearchWireOutput {
  hits: SearchWireHit[];
  cursor?: string;
  mode_used: "hybrid" | "keyword" | "semantic";
  /** Every key already camel-free (`indexed`, `total`, `host`…), so it maps through unchanged. */
  fallback?: SearchFallback;
}

interface BacklinksWireOutput {
  target: string;
  linked: Array<{ id: string; page: string; text: string; updated_at: string; direct?: boolean }>;
  linked_total?: number;
  linked_direct_total?: number;
  unlinked: Array<{ id: string; page: string; text: string }>;
  unlinked_truncated?: boolean;
  tagged_pages?: TaggedPage[];
  tagged_total?: number;
  cursor?: string;
}

interface GraphLinksWireOutput {
  nodes: Array<{ id: string; name: string; is_journal: boolean; ref_count: number }>;
  edges: Array<{ from: string; to: string; count: number }>;
  total_nodes: number;
  total_edges: number;
  truncated: boolean;
  note?: string;
}

export interface ApiClient {
  search(input: SearchInput, opts?: CallOpOptions): Promise<SearchResult>;
  pageBacklinks(target: string, includeUnlinked?: boolean): Promise<BacklinksResult>;
  graphLinks(input?: GraphLinksInput): Promise<GraphLinksResult>;
}

/** The typed read ops, through `callOp` like every other server call — so a search or a graph
 * that cannot reach the server says where it tried, and a rejection keeps its hint (B-330). */
export const apiClient: ApiClient = {
  async search(input: SearchInput, opts?: CallOpOptions): Promise<SearchResult> {
    const out = await callOp<SearchWireOutput>(
      "search",
      {
        query: input.query,
        mode: input.mode ?? "hybrid",
        scope: input.scope ?? "all",
        tags: input.tags && input.tags.length > 0 ? input.tags : undefined,
        properties:
          input.properties && Object.keys(input.properties).length > 0
            ? input.properties
            : undefined,
        namespace: input.namespace || undefined,
        journals_only: input.journalsOnly ?? false,
        updated_after: input.updatedAfter,
        updated_before: input.updatedBefore,
        limit: input.limit ?? 50,
        cursor: input.cursor,
      },
      opts,
    );
    return {
      hits: out.hits.map((h) => ({
        kind: h.kind,
        id: h.id,
        page: h.page,
        journalDate: h.journal_date,
        snippet: h.snippet,
        breadcrumb: h.breadcrumb,
        score: h.score,
        updatedAt: h.updated_at,
      })),
      cursor: out.cursor,
      modeUsed: out.mode_used,
      fallback: out.fallback,
    };
  },

  async pageBacklinks(target: string, includeUnlinked = true): Promise<BacklinksResult> {
    // Follow the cursor to the end (B-253): the panel's count, its filter and Link all all work
    // on the whole set, and a first page of 200 presented as the whole said "200" on a page
    // with 836 references and let a filter report "No references match" when matches existed.
    // Unlinked mentions are not paginated server-side, so they come with the first page only.
    const first = await callOp<BacklinksWireOutput>("page.backlinks", {
      target,
      include_unlinked: includeUnlinked,
      unlinked_limit: MAX_UNLINKED_MENTIONS,
      limit: BACKLINKS_PAGE,
    });
    const linkedWire = [...first.linked];
    // `cursor` advances `tagged_pages` together with `linked` (B-111), so both are collected.
    const taggedWire = [...(first.tagged_pages ?? [])];
    let cursor = first.cursor;
    while (cursor && linkedWire.length < MAX_LINKED_REFERENCES) {
      const next = await callOp<BacklinksWireOutput>("page.backlinks", {
        target,
        limit: BACKLINKS_PAGE,
        cursor,
      });
      linkedWire.push(...next.linked);
      taggedWire.push(...(next.tagged_pages ?? []));
      cursor = next.cursor;
    }
    // The cursor is an offset into a list an edit can shift between two requests; a row seen
    // twice would be counted twice.
    const seen = new Set<string>();
    const unique = linkedWire.filter((r) => !seen.has(r.id) && seen.add(r.id));
    const seenTagged = new Set<string>();
    const uniqueTagged = taggedWire.filter((r) => !seenTagged.has(r.id) && seenTagged.add(r.id));
    return {
      target: first.target,
      linked: unique.slice(0, MAX_LINKED_REFERENCES).map((r) => ({
        id: r.id,
        page: r.page,
        text: r.text,
        updatedAt: r.updated_at,
        direct: r.direct ?? true,
      })),
      linkedTotal: first.linked_total ?? linkedWire.length,
      linkedDirectTotal:
        first.linked_direct_total ??
        first.linked_total ??
        linkedWire.filter((r) => r.direct ?? true).length,
      unlinked: first.unlinked.map((r) => ({ id: r.id, page: r.page, text: r.text })),
      unlinkedTruncated: first.unlinked_truncated ?? false,
      taggedPages: uniqueTagged,
      taggedTotal: first.tagged_total ?? uniqueTagged.length,
    };
  },

  async graphLinks(input: GraphLinksInput = {}): Promise<GraphLinksResult> {
    // The server's own default (1500) is deliberately not repeated here: the cap is a
    // property of what the backend can answer cheaply, not of this call site.
    const out = await callOp<GraphLinksWireOutput>("graph.links", {
      include_journals: input.includeJournals ?? false,
      ...(input.limit ? { limit: input.limit } : {}),
    });
    return {
      nodes: out.nodes.map((n) => ({
        id: n.id,
        name: n.name,
        isJournal: n.is_journal,
        refCount: n.ref_count,
      })),
      edges: out.edges.map((e) => ({ from: e.from, to: e.to, count: e.count })),
      totalNodes: out.total_nodes,
      totalEdges: out.total_edges,
      truncated: out.truncated,
      note: out.note,
    };
  },
};
