import { describe, expect, it } from "vitest";
import { formatHlc } from "../hlc.js";
import { merge3, resolvePendingTextConflict } from "./text-merge.js";

const DEV_A = "aaaaaaaa";
const BASE_T = Date.UTC(2026, 8, 10, 12, 0, 0);

function hlcAt(wall: number, device: string, counter = 0): string {
  return formatHlc({ wall, counter, device });
}

describe("merge3", () => {
  it("merges edits to different parts of the same sentence", () => {
    const base = "The quick brown fox jumps over the lazy dog";
    const mine = "The very quick brown fox jumps over the lazy dog";
    const theirs = "The quick brown fox jumps over the lazy sleeping dog";
    const result = merge3(base, mine, theirs);
    expect(result).toEqual({
      ok: true,
      merged: "The very quick brown fox jumps over the lazy sleeping dog",
    });
  });

  it("merges edits to different paragraphs (multi-line block text)", () => {
    const base = "first paragraph\nsecond paragraph\nthird paragraph";
    const mine = "first paragraph EDITED\nsecond paragraph\nthird paragraph";
    const theirs = "first paragraph\nsecond paragraph\nthird paragraph EDITED";
    const result = merge3(base, mine, theirs);
    expect(result).toEqual({
      ok: true,
      merged: "first paragraph EDITED\nsecond paragraph\nthird paragraph EDITED",
    });
  });

  it("takes the only side that actually changed", () => {
    const base = "hello world";
    expect(merge3(base, "hello there world", base)).toEqual({
      ok: true,
      merged: "hello there world",
    });
    expect(merge3(base, base, "hello there world")).toEqual({
      ok: true,
      merged: "hello there world",
    });
  });

  it("is a no-op when both sides made the identical edit", () => {
    const base = "hello world";
    const same = "hello there world";
    expect(merge3(base, same, same)).toEqual({ ok: true, merged: same });
  });

  it("falls back to a conflict when both sides edit the same span differently", () => {
    const base = "The cat sat.";
    const mine = "The dog sat.";
    const theirs = "The bird sat.";
    expect(merge3(base, mine, theirs)).toEqual({ ok: false });
  });

  it("conflicts when both sides replace the entire (empty-base) text differently", () => {
    expect(merge3("", "mine wrote this", "theirs wrote that")).toEqual({ ok: false });
  });

  it("is idempotent: merging a value against itself on both sides returns it unchanged", () => {
    const text = "some stable content that nobody touched";
    expect(merge3(text, text, text)).toEqual({ ok: true, merged: text });
  });

  it("re-merging an already-merged clean result against its own inputs is stable", () => {
    const base = "alpha beta gamma";
    const mine = "alpha BETA gamma";
    const theirs = "alpha beta GAMMA";
    const first = merge3(base, mine, theirs);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    // Applying the same two edits again against the same base, now that one side already reflects
    // both, must reproduce the identical merged text (no drift from repeated merging).
    const second = merge3(base, first.merged, theirs);
    expect(second).toEqual({ ok: true, merged: first.merged });
  });

  it("falls back to LWW when a side exceeds the merge size cap", () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `word${i}`).join(" ");
    const mine = `${huge} mine`;
    const theirs = `${huge} theirs`;
    expect(merge3(huge, mine, theirs)).toEqual({ ok: false });
  });
});

describe("resolvePendingTextConflict", () => {
  const nextHlc = () => hlcAt(BASE_T + 1000, DEV_A);

  it("returns 'identical' and no ops when mine === theirs", () => {
    const outcome = resolvePendingTextConflict({
      entity: "blk1",
      device: DEV_A,
      base: "x",
      mine: "same",
      mineHlc: hlcAt(BASE_T, "bbbbbbbb"),
      theirs: "same",
      theirsHlc: hlcAt(BASE_T, "cccccccc"),
      nextHlc,
    });
    expect(outcome).toEqual({ kind: "identical", extraOps: [] });
  });

  it("emits a merged block.text op with a fresh HLC on a clean merge", () => {
    const mineHlc = hlcAt(BASE_T, "bbbbbbbb");
    const theirsHlc = hlcAt(BASE_T, "cccccccc");
    const outcome = resolvePendingTextConflict({
      entity: "blk1",
      device: DEV_A,
      base: "The quick brown fox",
      mine: "The very quick brown fox",
      mineHlc,
      theirs: "The quick brown fox jumps",
      theirsHlc,
      nextHlc,
    });
    expect(outcome.kind).toBe("merged");
    if (outcome.kind !== "merged") throw new Error("unreachable");
    const op = outcome.extraOps[0];
    expect(op.payload).toEqual({
      kind: "block.text",
      content: "The very quick brown fox jumps",
    });
    expect(op.entity).toBe("blk1");
    expect(op.device).toBe(DEV_A);
    // The merged op's HLC must beat both colliding ops so it wins everywhere.
    expect(op.hlc > mineHlc).toBe(true);
    expect(op.hlc > theirsHlc).toBe(true);
  });

  it("keeps LWW and records the loser as conflict_copy on a genuine conflict", () => {
    const mineHlc = hlcAt(BASE_T, "bbbbbbbb"); // smaller device id -> smaller HLC at same wall time
    const theirsHlc = hlcAt(BASE_T, "cccccccc");
    const outcome = resolvePendingTextConflict({
      entity: "blk1",
      device: DEV_A,
      base: "The cat sat.",
      mine: "The dog sat.",
      mineHlc,
      theirs: "The bird sat.",
      theirsHlc,
      nextHlc,
    });
    expect(outcome.kind).toBe("conflict");
    if (outcome.kind !== "conflict") throw new Error("unreachable");
    // theirsHlc > mineHlc lexicographically (same wall, "cccccccc" > "bbbbbbbb"), so mine loses.
    expect(outcome.loser).toBe("mine");
    expect(outcome.extraOps[0].payload).toEqual({
      kind: "block.prop",
      key: "conflict_copy",
      value: "The dog sat.",
    });
  });

  it("picks the other loser when theirs has the smaller HLC", () => {
    const mineHlc = hlcAt(BASE_T, "cccccccc");
    const theirsHlc = hlcAt(BASE_T, "bbbbbbbb");
    const outcome = resolvePendingTextConflict({
      entity: "blk1",
      device: DEV_A,
      base: "The cat sat.",
      mine: "The dog sat.",
      mineHlc,
      theirs: "The bird sat.",
      theirsHlc,
      nextHlc,
    });
    expect(outcome.kind).toBe("conflict");
    if (outcome.kind !== "conflict") throw new Error("unreachable");
    expect(outcome.loser).toBe("theirs");
    expect(outcome.extraOps[0].payload).toEqual({
      kind: "block.prop",
      key: "conflict_copy",
      value: "The bird sat.",
    });
  });
});
