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

  it("computes every block's replaced length before building it, exactly, for every $-template form", async () => {
    // The worker refuses an oversized block from this computation alone, and throws if a built
    // string disagrees with it — so each case below would reject if the arithmetic were wrong.
    const text = "Schůzka s Alešem: Černá kniha, 2026-09-13 a $5";
    const cases: Array<[source: string, flags: string, template: string]> = [
      ["\\p{Lu}(\\p{Ll}+)", "gu", "[$&|$1|$$|$`|$']"],
      ["(\\d{4})-(\\d{2})-(\\d{2})", "gu", "$3.$2.$1 ($0 $00 $4 $10 $01 $9)"],
      ["(?<year>\\d{4})-(?<month>\\d{2})", "gu", "$<month>/$<year> $<missing> $<unclosed"],
      ["(\\d{4})", "gu", "$<year> stays literal without named groups; trailing $"],
      ["(a)|(b)", "giu", "<$1$2>"],
      ["(?=k)", "gu", "^"],
      ["\\$5", "gu", "$$$$ $x $"],
      ["č", "giu", "$'$'$`"],
    ];
    for (const [source, flags, template] of cases) {
      const result = await runScan({
        contents: [text],
        source,
        flags,
        replacement: template,
        literalReplacement: false,
        limits: roomy,
      });
      const expected = text.replace(new RegExp(source, flags), template);
      expect(result, `${source} → ${template}`).toEqual({
        kind: "ok",
        occurrences: expect.any(Number),
        hits: expected === text ? [] : [{ index: 0, after: expected, count: expect.any(Number) }],
      });
    }
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
