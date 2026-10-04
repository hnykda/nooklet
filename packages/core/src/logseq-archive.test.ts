import { describe, expect, it } from "vitest";
import {
  findLogseqRoot,
  LogseqArchiveError,
  logseqArchiveTarget,
  safeArchiveFileName,
} from "./logseq-archive.js";
import { crc32, ZipStoreWriter } from "./zip-store.js";

describe("findLogseqRoot", () => {
  it("finds a graph zipped as its contents or as its folder", () => {
    expect(findLogseqRoot(["pages/A.md", "journals/2026_10_01.md"])).toBe("");
    expect(findLogseqRoot(["notes/pages/A.md", "notes/logseq/config.edn"])).toBe("notes/");
  });

  it("prefers the shallowest root, so logseq/bak/pages does not win", () => {
    expect(findLogseqRoot(["g/logseq/bak/pages/A.md", "g/pages/A.md"])).toBe("g/");
  });

  it("ignores macOS resource-fork litter", () => {
    expect(findLogseqRoot(["__MACOSX/g/pages/._A.md", "g/pages/A.md"])).toBe("g/");
  });

  it("refuses something that is not a graph, and two graphs side by side", () => {
    expect(() => findLogseqRoot(["photos/a.jpg"])).toThrow(LogseqArchiveError);
    expect(() => findLogseqRoot(["a/pages/x.md", "b/pages/y.md"])).toThrow(/more than one graph/);
  });

  it("does not mistake a folder whose name ends in 'pages' for pages/", () => {
    expect(() => findLogseqRoot(["mypages/x.md"])).toThrow(LogseqArchiveError);
  });
});

describe("logseqArchiveTarget", () => {
  it("keeps only what the importer reads", () => {
    expect(logseqArchiveTarget("g/pages/A.md", "g/")).toBe("pages/A.md");
    expect(logseqArchiveTarget("g/journals/2026_10_01.md", "g/")).toBe("journals/2026_10_01.md");
    expect(logseqArchiveTarget("g/assets/pic.png", "g/")).toBe("assets/pic.png");
    expect(logseqArchiveTarget("g/logseq/config.edn", "g/")).toBe("logseq/config.edn");
    expect(logseqArchiveTarget("g/logseq/bak/pages/A.md", "g/")).toBeNull();
    expect(logseqArchiveTarget("g/pages/notes.txt", "g/")).toBeNull();
    expect(logseqArchiveTarget("g/pages/sub/A.md", "g/")).toBeNull();
    expect(logseqArchiveTarget("g/pages/.hidden.md", "g/")).toBeNull();
    expect(logseqArchiveTarget("g/.recycle/A.md", "g/")).toBeNull();
    expect(logseqArchiveTarget("g/pages/", "g/")).toBeNull();
  });

  it("never yields a path that climbs out", () => {
    expect(logseqArchiveTarget("g/pages/../../etc/x.md", "g/")).toBeNull();
    expect(logseqArchiveTarget("g/assets/..", "g/")).toBeNull();
    expect(logseqArchiveTarget("g/assets/a\\..\\b.png", "g/")).toBeNull();
    expect(safeArchiveFileName("..")).toBe(false);
    expect(safeArchiveFileName("a\0b.md")).toBe(false);
    expect(safeArchiveFileName("Plánování.md")).toBe(true);
  });
});

describe("ZipStoreWriter", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("writes a well-formed archive: header offsets, sizes, end record", () => {
    const w = new ZipStoreWriter();
    const parts = [
      ...w.add("pages/A.md", new TextEncoder().encode("- hello")),
      ...w.add("assets/x.bin", new Uint8Array([1, 2, 3])),
      w.finish(),
    ];
    const total = parts.reduce((n, p) => n + p.length, 0);
    expect(w.offset).toBe(total);
    const all = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      all.set(p, o);
      o += p.length;
    }
    const v = new DataView(all.buffer);
    expect(v.getUint32(0, true)).toBe(0x04034b50);
    const eocd = total - 22;
    expect(v.getUint32(eocd, true)).toBe(0x06054b50);
    expect(v.getUint16(eocd + 10, true)).toBe(2);
    const cdOffset = v.getUint32(eocd + 16, true);
    expect(v.getUint32(cdOffset, true)).toBe(0x02014b50);
  });

  it("refuses a duplicate name and anything after finish", () => {
    const w = new ZipStoreWriter();
    w.add("a", new Uint8Array(1));
    expect(() => w.add("a", new Uint8Array(1))).toThrow(/duplicate/);
    w.finish();
    expect(() => w.add("b", new Uint8Array(1))).toThrow(/finished/);
  });
});
