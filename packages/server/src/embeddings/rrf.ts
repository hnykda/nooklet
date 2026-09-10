/**
 * Reciprocal rank fusion of two ranked id lists (research/06 §5.2, ADR 010: k=60). Pure and
 * deterministic — no DB, no network — so it's directly unit-testable.
 */

export interface FusedHit {
  id: string;
  score: number;
  ftsRank?: number;
  vecRank?: number;
}

export interface RrfOptions {
  k?: number;
  /** Weight for the keyword (FTS) list. Logseq 2.0 ships 1.25 for keyword, 1.0 for vector. */
  wFts?: number;
  wVec?: number;
}

/** `ftsIds`/`vecIds` are each best-match-first. Returns fused hits sorted best-first; an id
 * appearing in only one list still gets a score from that list alone. */
export function rrfFuse(
  ftsIds: readonly string[],
  vecIds: readonly string[],
  opts: RrfOptions = {},
): FusedHit[] {
  const k = opts.k ?? 60;
  const wFts = opts.wFts ?? 1.25;
  const wVec = opts.wVec ?? 1.0;
  const byId = new Map<string, FusedHit>();

  ftsIds.forEach((id, i) => {
    const rank = i + 1;
    const entry = byId.get(id) ?? { id, score: 0 };
    entry.score += wFts / (k + rank);
    entry.ftsRank = rank;
    byId.set(id, entry);
  });
  vecIds.forEach((id, i) => {
    const rank = i + 1;
    const entry = byId.get(id) ?? { id, score: 0 };
    entry.score += wVec / (k + rank);
    entry.vecRank = rank;
    byId.set(id, entry);
  });

  return [...byId.values()].sort((a, b) => b.score - a.score);
}
