/**
 * Client-side v1.1 upgrade named in ADR 003's Consequences and specified in
 * research/03-sync.md §6.4: "before a client applies a remote `block.text` to a block that has a
 * *pending* local `block.text`, run diff3/diff-match-patch(base = text as of last
 * server-confirmed version, mine, theirs); if it merges cleanly, emit a new `block.text` with the
 * merged text (new HLC, so it wins everywhere) — else keep LWW and add a `props.conflict_copy`
 * with the loser."
 *
 * Deliberately NOT wired into `applyOps`: that function is server semantics too (ADR 003 — the
 * server applies pushed ops in arrival order) and must stay a mechanical per-field LWW function
 * with no notion of "my pending edit". This module is pure and side-effect-free.
 * `resolvePendingTextConflict` below is the documented hook a client-side sync layer (`apps/web`'s
 * `SyncClient.pull()`) calls when it is about to fold a pulled `block.text` op into its `applyOps`
 * batch and that op's entity has an unacknowledged local `block.text` op sitting in `pending_op`.
 *
 * Implementation choice: a hand-rolled word/whitespace-token diff3 (`merge3`), NOT the
 * `diff-match-patch` npm package ADR 003 originally named as the plan. Checked 2026-09-10 via
 * `npm view`: `diff-match-patch` is at 1.0.5, last published 2022-06-15 — no ESM build (this repo
 * is `"type": "module"` throughout), no maintained types (`@types/diff-match-patch` 1.0.36 is a
 * third-party guess, also stale), and a correct 3-way merge still has to be hand-written on top of
 * it (the package only gives 2-way diff/patch; the idiom is `patch_make(base, mine)` then
 * `patch_apply(patches, theirs)`). That `patch_apply` step does *fuzzy* location matching
 * (`Match_Threshold`, `Match_Distance`, bit-vector approximate search) — tuned for "make my patch
 * apply somewhere close" (its job in a normal 2-way patch tool), which for a 3-way *merge* means it
 * can silently place a hunk in the wrong spot instead of failing closed. That is a bad trade for a
 * personal notes app: a silently-wrong merge is worse than falling back to LWW. `node-diff3`
 * (3.2.1, actively maintained 2026-06) was the other real candidate. Hand-rolling was chosen
 * instead because the actual algorithm needed here is narrow (merge *one block's* text against a
 * known common base — not arbitrary-file diffing) and worth having under this package's own tests,
 * with an exact, inspectable "clean or conflict" decision and zero new runtime dependency —
 * consistent with ADR 003's own "Why" (small, boring, hand-rolled beats an opaque dependency).
 */

import { compareHlc } from "../hlc.js";
import { makeOp, type Op } from "../ops.js";

export type Merge3Result = { ok: true; merged: string } | { ok: false };

/**
 * Above this many tokens on any side, skip the O(n·m) LCS and report `{ ok: false }` (the caller
 * falls back to plain LWW) rather than risk pathological time/memory on a huge pasted block.
 * Generous for the paragraph-sized text a single outline block normally holds.
 */
const MAX_MERGE_TOKENS = 2000;

/**
 * Split into whitespace-run / non-whitespace-run tokens. `tokens.join("")` reconstructs the
 * original string exactly (this is what lets `merge3` reassemble a merged text byte-for-byte from
 * untouched spans instead of re-inserting its own whitespace).
 */
function tokenize(s: string): string[] {
  return s.match(/\s+|[^\s]+/g) ?? [];
}

/**
 * Longest-common-subsequence alignment between two token arrays, returned as index pairs
 * `[ai, bi]` strictly increasing in both — standard O(n·m) DP, exact (no heuristics/junk
 * filtering, unlike a display-oriented diff — this is used to decide correctness, not to render
 * a pretty diff).
 */
function lcsPairs(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: Int32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i] as Int32Array;
    const next = dp[i + 1] as Int32Array;
    for (let j = m - 1; j >= 0; j--) {
      row[j] =
        a[i] === b[j]
          ? (next[j + 1] as number) + 1
          : Math.max(next[j] as number, row[j + 1] as number);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else {
      const down = (dp[i + 1] as Int32Array)[j] as number;
      const right = (dp[i] as Int32Array)[j + 1] as number;
      if (down >= right) i++;
      else j++;
    }
  }
  return pairs;
}

interface SyncPoint {
  base: number;
  mine: number;
  theirs: number;
}

/**
 * Pure 3-way text merge (diff3): given `base` (the text before either side edited it), `mine`
 * (this device's edit) and `theirs` (the other device's edit), returns the merged text when the
 * two edits touch disjoint spans (or made the identical edit), or `{ ok: false }` when they
 * genuinely overlap — the caller falls back to LWW + `conflict_copy` in that case (see
 * `resolvePendingTextConflict`).
 *
 * Algorithm: LCS-align base↔mine and base↔theirs, walk the base positions that are a *common*
 * anchor in both alignments (a token identical across all three texts, in the same relative order
 * — always including the implicit start/end anchors), and resolve the text between each pair of
 * anchors (a "hunk") by whichever side actually changed it relative to base:
 *   - neither side changed it → keep base's text for that span
 *   - exactly one side changed it → take that side's text
 *   - both sides changed it identically → take it (both made the same edit)
 *   - both sides changed it *differently* → conflict; the whole merge fails (matching the
 *     research's binary "merges cleanly, or it doesn't" — no partial merges).
 */
export function merge3(base: string, mine: string, theirs: string): Merge3Result {
  if (mine === theirs) return { ok: true, merged: mine };
  if (mine === base) return { ok: true, merged: theirs };
  if (theirs === base) return { ok: true, merged: mine };

  const baseTok = tokenize(base);
  const mineTok = tokenize(mine);
  const theirsTok = tokenize(theirs);
  if (
    baseTok.length > MAX_MERGE_TOKENS ||
    mineTok.length > MAX_MERGE_TOKENS ||
    theirsTok.length > MAX_MERGE_TOKENS
  ) {
    return { ok: false };
  }

  // Anchors common to both alignments: a base index reached by an LCS match against BOTH mine and
  // theirs. Monotonic in all three coordinates because each source alignment is itself monotonic
  // and we only keep a (monotonic) subsequence of it.
  const theirsMatchByBase = new Map(lcsPairs(baseTok, theirsTok));
  const syncs: SyncPoint[] = [{ base: 0, mine: 0, theirs: 0 }];
  for (const [b, m] of lcsPairs(baseTok, mineTok)) {
    const t = theirsMatchByBase.get(b);
    if (t !== undefined) syncs.push({ base: b, mine: m, theirs: t });
  }
  syncs.push({ base: baseTok.length, mine: mineTok.length, theirs: theirsTok.length });

  const out: string[] = [];
  for (let s = 0; s + 1 < syncs.length; s++) {
    const cur = syncs[s] as SyncPoint;
    const next = syncs[s + 1] as SyncPoint;
    const baseSeg = baseTok.slice(cur.base, next.base).join("");
    const mineSeg = mineTok.slice(cur.mine, next.mine).join("");
    const theirsSeg = theirsTok.slice(cur.theirs, next.theirs).join("");
    const mineChanged = mineSeg !== baseSeg;
    const theirsChanged = theirsSeg !== baseSeg;
    if (!mineChanged && !theirsChanged) out.push(baseSeg);
    else if (mineChanged && !theirsChanged) out.push(mineSeg);
    else if (!mineChanged && theirsChanged) out.push(theirsSeg);
    else if (mineSeg === theirsSeg) out.push(mineSeg);
    else return { ok: false };
  }
  return { ok: true, merged: out.join("") };
}

export interface PendingTextConflictInput {
  /** Block id (the op's `entity`). */
  entity: string;
  /** This device's id — becomes the `device` field of any op this function builds. */
  device: string;
  /**
   * Text as of the last server-confirmed version of this block, i.e. the content immediately
   * before the pending local edit (`mine`) was made. `packages/core`'s state tables only ever
   * hold the *current* content, not history, so the caller must keep this around — research/03
   * §6.4's parenthetical says exactly this: "keep it in `pending_op`" (an extra column alongside
   * the pending `block.text` row, written once when the edit is first queued).
   */
  base: string;
  /** This device's pending (not yet server-acknowledged) edit. */
  mine: string;
  /** HLC of the pending local `block.text` op that produced `mine`. */
  mineHlc: string;
  /** The remote edit just pulled, about to be applied. */
  theirs: string;
  /** HLC of the incoming remote `block.text` op that produced `theirs`. */
  theirsHlc: string;
  /**
   * Supplies a fresh local HLC for the op this function may emit (the caller's `Hlc.next()`).
   * Called at most once.
   */
  nextHlc: () => string;
}

export type PendingTextConflictOutcome =
  | { kind: "identical"; extraOps: readonly [] }
  | { kind: "merged"; extraOps: readonly [Op] }
  | { kind: "conflict"; loser: "mine" | "theirs"; extraOps: readonly [Op] };

/**
 * THE HOOK. Call this from the client sync layer right before folding a pulled `block.text` op
 * into the same `applyOps` batch, whenever that op's `entity` has a `block.text` row still sitting
 * in `pending_op`. Always fold `extraOps` into that SAME batch alongside the raw incoming op —
 * this function never asks the caller to withhold, skip, or rewrite the incoming op; ordinary
 * per-field LWW must still run over it unmodified (`applyOps` stays the mechanical per-op-kind
 * function ADR 003 requires). What `extraOps` adds on top:
 *
 *   - "merged": one new `block.text` op carrying the 3-way-merged text, stamped with a HLC from
 *     `nextHlc()` — strictly newer than both `mineHlc` and `theirsHlc` (a device's own clock is
 *     always advanced past every HLC it has just observed, per `Hlc.receive`), so once the batch
 *     is HLC-sorted and replayed this op wins over both raw ops and every replica converges on the
 *     merged text.
 *   - "conflict": `merge3` could not merge cleanly. LWW is left to decide the winner exactly as it
 *     already would (by comparing `mineHlc`/`theirsHlc` against whichever is already in the state
 *     table's `content_hlc` column) — this function does not fight that decision. It only adds one
 *     `block.prop` op (`key: "conflict_copy"`) recording the *loser's* full text, so nothing either
 *     device wrote is ever silently discarded (research/03 §6.4). That property is a report, not
 *     the end state: the server turns it into a sibling block after the winner (tagged
 *     `sync-conflict:: true`) and clears it (ADR 027, `packages/server/src/conflict-copy.ts`). The
 *     block is minted there, not here, because both devices can reach this branch for the same
 *     conflict, and only the server can make one block of two reports.
 *   - "identical": `mine === theirs` — nothing to do.
 */
export function resolvePendingTextConflict(
  input: PendingTextConflictInput,
): PendingTextConflictOutcome {
  if (input.mine === input.theirs) return { kind: "identical", extraOps: [] };

  const result = merge3(input.base, input.mine, input.theirs);
  if (result.ok) {
    const op = makeOp(input.nextHlc(), input.device, input.entity, {
      kind: "block.text",
      content: result.merged,
    });
    return { kind: "merged", extraOps: [op] };
  }

  const loser: "mine" | "theirs" =
    compareHlc(input.mineHlc, input.theirsHlc) < 0 ? "mine" : "theirs";
  const op = makeOp(input.nextHlc(), input.device, input.entity, {
    kind: "block.prop",
    key: "conflict_copy",
    value: loser === "mine" ? input.mine : input.theirs,
  });
  return { kind: "conflict", loser, extraOps: [op] };
}
