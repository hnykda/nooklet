/**
 * ADR 034 / B-789: an image's size and alignment, in Logseq's `{:height 236, :width 500}` map.
 */
import { describe, expect, it } from "vitest";
import { readImageMeta, setImageMeta } from "./image-meta.js";
import { parseOutline, serializeOutline } from "./outline.js";
import { type InlineToken, tokenizeLine } from "./tokens.js";

function image(content: string): Extract<InlineToken, { kind: "image" }> {
  const tok = tokenizeLine(content).find((t) => t.kind === "image");
  if (tok?.kind !== "image") throw new Error(`no image in ${content}`);
  return tok;
}

describe("readImageMeta", () => {
  it("reads Logseq's own shape, as `pr-str` writes it", () => {
    expect(readImageMeta("{:height 236, :width 500}", 0)).toEqual({
      meta: { width: 500, height: 236 },
      end: 25,
    });
  });

  it("takes commas as whitespace, fractional widths, string or keyword alignment", () => {
    expect(readImageMeta("{:width 412.5 :align :right}", 0)?.meta).toEqual({
      width: 412.5,
      align: "right",
    });
    expect(readImageMeta('{:align "center",:width 10}', 0)?.meta).toEqual({
      width: 10,
      align: "center",
    });
  });

  it("an empty map, or one with only keys nooklet does not know, is still the image's", () => {
    expect(readImageMeta("{}", 0)).toEqual({ meta: {}, end: 2 });
    expect(readImageMeta("{:show true, :title nil}", 0)?.meta).toEqual({});
  });

  it("ignores values that are not sizes, and a repeated key keeps the last", () => {
    expect(readImageMeta('{:width "big", :height -3, :align "middle"}', 0)?.meta).toEqual({});
    expect(readImageMeta("{:width 10, :width 20}", 0)?.meta).toEqual({ width: 20 });
  });

  it("anything that is not an EDN map is not metadata", () => {
    for (const s of [
      "{not a map}",
      "{{embed [[x]]}}",
      "{:width}",
      "{:width 10",
      "{width 10}",
      '{:alt "a}b"}',
      "{:width\n10}",
      " {:width 10}",
    ]) {
      expect(readImageMeta(s, 0), s).toBeNull();
    }
  });
});

describe("the image token", () => {
  it("covers the map, and records where it starts", () => {
    const content = "see ![a](assets/x.png){:height 236, :width 500} after";
    const tok = image(content);
    expect(content.slice(tok.start, tok.end)).toBe("![a](assets/x.png){:height 236, :width 500}");
    expect(tok.metaAt).toBe(content.indexOf("{"));
    expect(tok.meta).toEqual({ width: 500, height: 236 });
  });

  it("a map after a space is text, as in Logseq", () => {
    const content = "![a](x.png) {:width 5}";
    const tok = image(content);
    expect(tok.end).toBe(11);
    expect(tok.meta).toBeUndefined();
  });
});

describe("setImageMeta", () => {
  const at = (c: string) => image(c).metaAt;

  it("writes `{:width N}` where there was no map", () => {
    const c = "a ![p](assets/x.png) b";
    expect(setImageMeta(c, at(c), { width: 320.4 })).toBe("a ![p](assets/x.png){:width 320} b");
  });

  it("replaces the width in place, rescaling a height Logseq wrote, keeping unknown keys", () => {
    const c = '![p](x.png){:height 236, :width 500, :title "t"} tail';
    expect(setImageMeta(c, at(c), { width: 250 })).toBe(
      '![p](x.png){:height 118, :width 250, :title "t"} tail',
    );
  });

  it("drops a height there is no width to scale it by", () => {
    const c = "![p](x.png){:height 200}";
    expect(setImageMeta(c, at(c), { width: 100 })).toBe("![p](x.png){:width 100}");
  });

  it("alignment: centre and right are written, left is the default and removes the key", () => {
    const c = "![p](x.png){:width 100}";
    const centred = setImageMeta(c, at(c), { align: "center" });
    expect(centred).toBe('![p](x.png){:width 100, :align "center"}');
    expect(image(centred).meta).toEqual({ width: 100, align: "center" });
    expect(setImageMeta(centred, at(centred), { align: "left" })).toBe(c);
  });

  it("a map left empty goes away entirely", () => {
    const c = "![p](x.png){:width 100} b";
    expect(setImageMeta(c, at(c), { width: null })).toBe("![p](x.png) b");
  });

  it("touches only the image it is given", () => {
    const c = "![a](a.png){:width 1} ![b](b.png){:width 2}";
    const second = tokenizeLine(c).filter((t) => t.kind === "image")[1];
    if (second?.kind !== "image") throw new Error("no second image");
    expect(setImageMeta(c, second.metaAt, { width: 30 })).toBe(
      "![a](a.png){:width 1} ![b](b.png){:width 30}",
    );
  });
});

describe("through a Markdown file (the mirror's and the importer's format)", () => {
  it("a sized, aligned image survives parse → serialize → parse unchanged", () => {
    const content = '![shed](../assets/shed.png){:height 236, :width 500, :align "right"}';
    const file = `- ${content}\n  id:: 6512bd43-d9ca-4e2b-9c4e-1a2b3c4d5e6f\n- after\n`;
    const parsed = parseOutline(file);
    expect(parsed.blocks[0]?.content).toBe(content);
    const again = parseOutline(serializeOutline(parsed));
    expect(again.blocks[0]?.content).toBe(content);
    expect(image(again.blocks[0]?.content ?? "").meta).toEqual({
      width: 500,
      height: 236,
      align: "right",
    });
  });
});
