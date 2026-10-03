/**
 * Pure path/naming helpers for multi-graph storage (ADR 025): one SQLite file, one mirror, one
 * `assets/` directory per graph, all nested under `<dataDir>/graphs/<graphId>/` instead of living
 * directly in `<dataDir>`. Kept pure and separate from `open-graph.ts`/`registry.ts` so the naming
 * rules (what makes a graph id valid, where a graph's files live) are testable with no filesystem
 * or SQLite involved — the same discipline this session already used for `shouldRestoreCheckpoint`.
 */

import { join } from "node:path";

/** A graph's creation metadata (`graph.json`, written alongside its `graph.sqlite`) — what
 * `registry.list()` and `migrateLegacyLayoutIfNeeded` both read/write, kept here rather than in
 * `registry.ts` since the migration module needs the shape too and shouldn't depend on the
 * (much larger) registry module just for a type. */
export interface GraphMeta {
  id: string;
  label: string;
  createdAt: number;
}

/** A graph id is a URL path segment (it appears literally in `/g/<id>/...`) and a directory name.
 * Lowercase to avoid two people creating "Work" and "work" as different graphs that collide the
 * instant a case-insensitive filesystem (macOS default, Windows) is involved. */
const GRAPH_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** "default" and "graphs" are excluded not for a technical reason but so `<dataDir>/graphs/graphs`
 * or a graph literally called "graphs" can never happen — reserved, not just discouraged. */
const RESERVED_GRAPH_IDS = new Set(["graphs"]);

export function isValidGraphId(id: string): boolean {
  return GRAPH_ID_PATTERN.test(id) && !RESERVED_GRAPH_IDS.has(id);
}

export function graphsRootDir(dataDir: string): string {
  return join(dataDir, "graphs");
}

export function graphDir(dataDir: string, graphId: string): string {
  return join(graphsRootDir(dataDir), graphId);
}

export function graphDbPath(dataDir: string, graphId: string): string {
  return join(graphDir(dataDir, graphId), "graph.sqlite");
}

/** Where a graph's own creation metadata (label, created_at) lives — separate from the SQLite file
 * so `registry.list()` can answer without opening every graph's database. */
export function graphMetaPath(dataDir: string, graphId: string): string {
  return join(graphDir(dataDir, graphId), "graph.json");
}

export function rootTokenPath(dataDir: string): string {
  return join(dataDir, "root.token");
}

/** The pre-ADR-025 layout: `<dataDir>/graph.sqlite` directly, not nested under `graphs/<id>/`. */
export function legacyDbPath(dataDir: string): string {
  return join(dataDir, "graph.sqlite");
}
