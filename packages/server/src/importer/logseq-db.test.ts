import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LogseqDbGraph, LogseqKeyword, readLogseqDbDatoms } from "./logseq-db.js";
import { fixtureDatoms, fixtureTail, U, writeFixtureDb } from "./logseq-db-fixture.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nooklet-logseq-db-"));
  file = join(dir, "db.sqlite");
  writeFixtureDb(file, fixtureDatoms(), fixtureTail());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readLogseqDbDatoms", () => {
  it("walks the EAVT branch into both leaves, decodes cached keywords, and skips garbage nodes", () => {
    // The fixture really is in Logseq's shape: keywords repeated in a node are cache refs.
    const raw = new DatabaseSync(file, { readOnly: true });
    const leaf = raw.prepare("SELECT content FROM kvs WHERE addr = 1000001").get() as {
      content: string;
    };
    raw.close();
    expect(leaf.content).toMatch(/"\^[0-9A-Za-z]+"/);
    const { datoms, manyAttrs } = readLogseqDbDatoms(file);
    // Every fixture datom once (branch separator keys are not datoms of their own), plus the tail.
    const titles = datoms.filter((d) => d.a === "block/title").map((d) => d.v);
    expect(titles).toContain("Garden Plans");
    expect(titles).toContain("Late addition");
    expect(titles).not.toContain("garbage");
    expect(datoms.filter((d) => d.e === 31 && d.a === "block/uuid")).toHaveLength(1);
    // `"^…"` cache refs come back as the keyword they stand for.
    const ident = datoms.find((d) => d.e === 1 && d.a === "db/ident");
    expect(ident?.v).toBeInstanceOf(LogseqKeyword);
    expect(String(ident?.v)).toBe(":logseq.class/Asset");
    expect(datoms.find((d) => d.e === 31 && d.a === "block/uuid")?.v).toBe(U.planted);
    expect(manyAttrs.has("block/tags")).toBe(true);
  });

  it("applies the tail: an added block appears, a retracted value is gone", () => {
    const { datoms } = readLogseqDbDatoms(file);
    const of21 = datoms.filter((d) => d.e === 21 && d.a === "block/title").map((d) => d.v);
    expect(of21).toEqual(["Layout plan"]);
  });

  it("never opens or modifies the file it is given (Logseq may hold it)", () => {
    const hash = () => createHash("sha256").update(readFileSync(file)).digest("hex");
    const before = hash();
    readLogseqDbDatoms(file);
    expect(hash()).toBe(before);
    expect(existsSync(`${file}-shm`)).toBe(false);
    expect(existsSync(`${file}-wal`)).toBe(false);
  });

  it("refuses a SQLite file that is not a Datascript store, and a missing file", () => {
    const other = join(dir, "other.sqlite");
    const db = new DatabaseSync(other);
    db.exec("CREATE TABLE kvs (addr INTEGER primary key, content TEXT, addresses JSON)");
    db.close();
    expect(() => readLogseqDbDatoms(other)).toThrow(/not a Logseq DB graph/);
    expect(() => readLogseqDbDatoms(join(dir, "missing.sqlite"))).toThrow();
  });
});

describe("LogseqDbGraph", () => {
  it("lists asset entities with their file name and placement", () => {
    const g = LogseqDbGraph.fromFile(file);
    const assets = g.assets().sort((a, b) => a.eid - b.eid);
    expect(assets.map((a) => [a.uuid, a.title, a.fileName])).toEqual([
      [U.photoAsset, "2026-09-14-10-20-30", `${U.photoAsset}.png`],
      [U.catalogue, "seed-catalogue", `${U.catalogue}.pdf`],
      [U.unplacedPic, "image_1700000000000_0", `${U.unplacedPic}.jpg`],
    ]);
    expect(assets[0]?.pageEid).toBe(30);
    expect(assets[0]?.parentEid).toBe(30);
  });

  it("lists pages and journal days, and the outline in :block/order", () => {
    const g = LogseqDbGraph.fromFile(file);
    const pages = g.pages();
    expect(pages.find((p) => p.uuid === U.journal)?.journalDay).toBe(20260914);
    expect(pages.find((p) => p.uuid === U.assetClass)?.builtIn).toBe(true);
    expect(g.outlineChildren(30).map((e) => g.uuid(e))).toEqual([
      U.planted,
      U.photoAsset,
      U.photoNote,
      U.task,
      U.seeRef,
      U.late,
    ]);
    expect(g.pageBlocksInOrder(30)).toContain(34);
    expect(g.tagIdents(35)).toEqual(["logseq.class/Task"]);
  });

  it("finds favourites on the hidden $$$favorites page", () => {
    const g = LogseqDbGraph.fromFile(file);
    expect(g.favoritePages().map((p) => p.title)).toEqual(["Garden Plans"]);
  });

  it("reads config.edn kept inside the database", () => {
    const g = LogseqDbGraph.fromFile(file);
    expect(g.fileContent("logseq/config.edn")).toContain("MMM do, yyyy");
  });
});
