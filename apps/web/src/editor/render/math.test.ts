/**
 * `renderTexSync` with the real KaTeX: a formula from block text cannot size a box to cover the
 * page (docs/BUGS.md B-138). KaTeX's `maxSize` defaults to Infinity, so `\rule{99999em}{99999em}`
 * painted a 1.6-million-pixel box into the outline, references and query results.
 *
 * Not covered: `\kern`, which KaTeX does not cap. A huge kern pushes content sideways rather than
 * growing a box; the outline row (`content-visibility: auto`) and the Shelf/References scroll
 * containers bound it (docs/review/2026-09-13-m7-rv-web-security.md, F6).
 */
import katex from "katex";
import { afterEach, describe, expect, it } from "vitest";
import { _setMathForTests, renderTexSync } from "./math.js";

afterEach(() => _setMathForTests(undefined));

/** Every `<number>em` length in the markup's inline `style` attributes, as absolute values — not the
 * whole string, which also carries the TeX source in its MathML annotation. */
function emLengths(html: string): number[] {
  const styles = [...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1] ?? "").join(";");
  return [...styles.matchAll(/(-?[\d.]+)em/g)].map((m) => Math.abs(Number(m[1])));
}

describe("renderTexSync", () => {
  it.each([
    String.raw`\rule{99999em}{99999em}`,
    String.raw`\raisebox{99999em}{x}`,
    String.raw`\hspace{99999em}`,
    String.raw`\rule{1e6em}{1e6em}`,
  ])("caps the sizes in %s", (tex) => {
    _setMathForTests(katex);
    const html = renderTexSync(tex) ?? "";
    expect(html).not.toBe("");
    // 20em is the cap; KaTeX adds a strut and a few hundredths for the surrounding box.
    expect(Math.max(...emLengths(html))).toBeLessThan(25);
  });

  it("still renders ordinary formulas and sizes", () => {
    _setMathForTests(katex);
    const html = renderTexSync(String.raw`E=mc^2 \rule{2em}{1em}`) ?? "";
    expect(html).toContain("katex");
    expect(html).toMatch(/2em/);
  });
});
