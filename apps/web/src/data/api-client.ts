/**
 * Small typed client for the read ops the local replica cannot answer on its own:
 * `search`, `page.backlinks` (docs/spec/mcp-tools.md §4.3.5/§4.3.6) and `graph.links`. The client-only schema
 * (`@nooklet/core`'s `CORE_SCHEMA_STATEMENTS`, mirrored by `../db/schema-client.ts`) has no
 * `ref`/`path_ref`/`block_fts`/`page_fts`/`embedding*` tables — those are server-only derived
 * tables (docs/spec/sql-schema.md rule 1) — so linked/unlinked references, full-text/semantic
 * search and the link graph MUST go over HTTP to `/api/v1/*` rather than through the worker/SqlDriver seam. This
 * mirrors `../sync/http-transport.ts`'s style (same `baseUrl`/`getToken` shape) deliberately, so
 * it reads as "the same kind of thing" rather than a one-off fetch wrapper.
 *
 * Auth: device pairing (PLAN.md §6) isn't built yet, so there is no real per-device bearer token
 * to reach for. `VITE_NOOKLET_TOKEN` is a dev-only stand-in (see vite-env.d.ts) until that lands;
 * `getToken` is still a function (not a plain string) so swapping in a real token source later is
 * a one-line change here, not a call-site change.
 */

import { apiBaseUrl, authToken } from "./bootstrap.js";

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
  namespace?: string;
  journalsOnly?: boolean;
  updatedAfter?: string;
  updatedBefore?: string;
  limit?: number;
  cursor?: string;
}

export interface SearchResult {
  hits: SearchHit[];
  cursor?: string;
  modeUsed: "hybrid" | "keyword" | "semantic";
}

export interface BacklinkRef {
  id: string;
  page: string;
  text: string;
  updatedAt?: string;
}

export interface BacklinksResult {
  target: string;
  linked: BacklinkRef[];
  unlinked: BacklinkRef[];
  cursor?: string;
}

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

export interface ApiClientOptions {
  /** Origin the app is served from by default; override for a separately-hosted server. Same
   * default convention as `sync/http-transport.ts`. */
  baseUrl?: string;
  getToken?: () => string | undefined;
}

function authHeaders(getToken?: () => string | undefined): HeadersInit {
  const token = getToken?.();
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

async function post<TOut>(
  base: string,
  opName: string,
  body: unknown,
  getToken?: () => string | undefined,
): Promise<TOut> {
  const res = await fetch(`${base}/api/v1/${opName}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(getToken) },
    body: JSON.stringify(body),
  });
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
}

interface BacklinksWireOutput {
  target: string;
  linked: Array<{ id: string; page: string; text: string; updated_at: string }>;
  unlinked: Array<{ id: string; page: string; text: string }>;
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
  search(input: SearchInput): Promise<SearchResult>;
  pageBacklinks(target: string, includeUnlinked?: boolean): Promise<BacklinksResult>;
  graphLinks(input?: GraphLinksInput): Promise<GraphLinksResult>;
}

export function createApiClient(opts: ApiClientOptions = {}): ApiClient {
  const base = opts.baseUrl ?? "";

  return {
    async search(input: SearchInput): Promise<SearchResult> {
      const out = await post<SearchWireOutput>(
        base,
        "search",
        {
          query: input.query,
          mode: input.mode ?? "hybrid",
          scope: input.scope ?? "all",
          tags: input.tags && input.tags.length > 0 ? input.tags : undefined,
          namespace: input.namespace || undefined,
          journals_only: input.journalsOnly ?? false,
          updated_after: input.updatedAfter,
          updated_before: input.updatedBefore,
          limit: input.limit ?? 50,
          cursor: input.cursor,
        },
        opts.getToken,
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
      };
    },

    async pageBacklinks(target: string, includeUnlinked = true): Promise<BacklinksResult> {
      const out = await post<BacklinksWireOutput>(
        base,
        "page.backlinks",
        { target, include_unlinked: includeUnlinked, limit: 200 },
        opts.getToken,
      );
      return {
        target: out.target,
        linked: out.linked.map((r) => ({
          id: r.id,
          page: r.page,
          text: r.text,
          updatedAt: r.updated_at,
        })),
        unlinked: out.unlinked.map((r) => ({ id: r.id, page: r.page, text: r.text })),
        cursor: out.cursor,
      };
    },

    async graphLinks(input: GraphLinksInput = {}): Promise<GraphLinksResult> {
      const out = await post<GraphLinksWireOutput>(
        base,
        "graph.links",
        // The server's own default (1500) is deliberately not repeated here: the cap is a
        // property of what the backend can answer cheaply, not of this call site.
        {
          include_journals: input.includeJournals ?? false,
          ...(input.limit ? { limit: input.limit } : {}),
        },
        opts.getToken,
      );
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
}

/** The app-wide client, configured from Vite env (see vite-env.d.ts). A view can construct its
 * own `createApiClient(...)` in a test instead of importing this singleton. */
export const apiClient: ApiClient = createApiClient({
  baseUrl: apiBaseUrl(),
  getToken: authToken,
});
