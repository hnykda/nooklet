import { describe, expect, it } from "vitest";
import { folderSource, graphIdFromName, rechunk } from "./logseq-import.js";

function picked(path: string, body = "x"): File {
  const f = new File([body], path.split("/").pop() as string);
  Object.defineProperty(f, "webkitRelativePath", { value: path });
  return f;
}

describe("folderSource", () => {
  it("keeps only what the importer reads, and counts it", () => {
    const src = folderSource([
      picked("notes/pages/A.md"),
      picked("notes/pages/B.md"),
      picked("notes/journals/2026_10_01.md"),
      picked("notes/assets/pic.png", "png!"),
      picked("notes/logseq/config.edn"),
      picked("notes/logseq/bak/pages/A.md"),
      picked("notes/.recycle/old.md"),
      picked("notes/pages/.DS_Store"),
    ]);
    if ("error" in src) throw new Error(src.error);
    expect(src.name).toBe("notes");
    expect(src.files.map((f) => f.target).sort()).toEqual([
      "assets/pic.png",
      "journals/2026_10_01.md",
      "logseq/config.edn",
      "pages/A.md",
      "pages/B.md",
    ]);
    expect([src.pages, src.journals, src.assets]).toEqual([2, 1, 1]);
    expect(src.bytes).toBe(1 + 1 + 1 + 4 + 1);
  });

  it("says plainly when the folder is not a Logseq graph", () => {
    const src = folderSource([picked("photos/a.jpg")]);
    expect(src).toMatchObject({ error: expect.stringMatching(/not a Logseq graph/) });
  });
});

describe("rechunk", () => {
  it("regroups pieces into exact chunks without losing a byte", async () => {
    async function* pieces() {
      yield new Uint8Array([1, 2, 3]);
      yield new Uint8Array([4]);
      yield new Uint8Array([5, 6, 7, 8, 9]);
    }
    const out: number[][] = [];
    for await (const c of rechunk(pieces(), 4)) out.push([...c]);
    expect(out).toEqual([[1, 2, 3, 4], [5, 6, 7, 8], [9]]);
  });
});

describe("graphIdFromName", () => {
  it("makes an id the server accepts", () => {
    expect(graphIdFromName("My Logseq notes")).toBe("my-logseq-notes");
    expect(graphIdFromName("Plánování 2026!")).toBe("planovani-2026");
    expect(graphIdFromName("  --  ")).toBe("");
    expect(graphIdFromName("a".repeat(80))).toHaveLength(64);
  });
});
