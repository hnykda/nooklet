import { describe, expect, it } from "vitest";
import { runScan, type ScanRequest } from "./replace-scan.js";

const base: Omit<ScanRequest, "contents" | "limits"> = {
  source: "colou?r",
  flags: "gi",
  replacement: "color",
  literalReplacement: true,
};
const roomy = { maxBlocks: 100, maxBlockChars: 100_000, maxOutputChars: 1_000_000 };

describe("runScan (B-125)", () => {
  it("reports each changed block's index, text after, and occurrence count", async () => {
    const result = await runScan({
      ...base,
      contents: ["the colour", "nothing", "COLOUR and colour", "color already"],
      limits: roomy,
    });
    expect(result).toEqual({
      kind: "ok",
      occurrences: 3,
      hits: [
        { index: 0, after: "the color", count: 1 },
        { index: 2, after: "color and color", count: 2 },
      ],
    });
  });

  it("past maxBlocks it stops holding replaced text but still counts everything", async () => {
    const result = await runScan({
      ...base,
      contents: ["colour", "colour colour", "colour", "no"],
      limits: { ...roomy, maxBlocks: 1 },
    });
    expect(result).toEqual({ kind: "too_many_blocks", blocksMatched: 3, occurrences: 4 });
  });

  it("stops as soon as the replaced text it holds passes maxOutputChars", async () => {
    const result = await runScan({
      ...base,
      replacement: "x".repeat(50),
      contents: ["colour", "colour", "colour", "colour"],
      limits: { ...roomy, maxOutputChars: 120 },
    });
    expect(result).toEqual({ kind: "output_too_large", maxOutputChars: 120 });
  });

  it("refuses a block the replacement grows past maxBlockChars, not one it leaves as long", async () => {
    const grown = await runScan({
      ...base,
      replacement: "x".repeat(10),
      contents: ["ok", "colour colour"],
      limits: { ...roomy, maxBlockChars: 15 },
    });
    expect(grown).toEqual({ kind: "block_too_long", index: 1, length: 21, maxBlockChars: 15 });

    const kept = await runScan({
      ...base,
      contents: ["colour colour colour"],
      limits: { ...roomy, maxBlockChars: 5 },
    });
    expect(kept.kind).toBe("ok");
  });
});
