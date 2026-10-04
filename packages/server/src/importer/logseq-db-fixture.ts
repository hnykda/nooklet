/**
 * Test helper: writes a small, invented Logseq DB-version graph in the same storage shape the real
 * one has (see `logseq-db.ts`): a `kvs` table whose rows are transit-JSON Datascript nodes — a
 * root at address 0, a tail at address 1, an EAVT branch node whose children are listed in the
 * `addresses` column, and leaves holding `[e a v tx]` datoms. Written with transit-js's own writer,
 * so repeated keywords really are `"^…"` cache references, as they are in Logseq's files.
 *
 * Every title and name here is made up.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import transit from "transit-js";

export type FixtureValue =
  | string
  | number
  | boolean
  | { kw: string }
  | { uuid: string }
  | { ref: number }
  /** A map with keyword keys (`:logseq.property.asset/resize-metadata`). */
  | { map: Record<string, string | number> };

/** `[e, attr, value]`; tx is filled in. */
export type FixtureDatom = [number, string, FixtureValue];

const kw = (name: string) => transit.keyword(name);

function encode(v: FixtureValue): unknown {
  if (typeof v !== "object") return v;
  if ("kw" in v) return kw(v.kw);
  if ("uuid" in v) return transit.uuid(v.uuid);
  if ("map" in v) return transit.map(Object.entries(v.map).flatMap(([k, val]) => [kw(k), val]));
  return v.ref;
}

const MANY = ["block/tags", "block/refs"];

/**
 * Write `db.sqlite` with `datoms` split across two EAVT leaves (so the reader has to follow a
 * branch) and `tail` as not-yet-flushed transactions (`[e attr value added?]`).
 */
export function writeFixtureDb(
  file: string,
  datoms: readonly FixtureDatom[],
  tail: ReadonlyArray<ReadonlyArray<[number, string, FixtureValue, boolean]>> = [],
): void {
  const w = transit.writer("json");
  const TX = 536870913;
  const sorted = [...datoms].sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
  const asVec = (d: FixtureDatom, tx = TX) => [d[0], kw(d[1]), encode(d[2]), tx];
  const half = Math.ceil(sorted.length / 2);
  const leafA = sorted.slice(0, half).map((d) => asVec(d));
  const leafB = sorted.slice(half).map((d) => asVec(d));

  const schema = transit.map(
    MANY.flatMap((a) => [
      kw(a),
      transit.map([
        kw("db/cardinality"),
        kw("db.cardinality/many"),
        kw("db/valueType"),
        kw("db.type/ref"),
      ]),
    ]),
  );
  const root = transit.map([
    kw("schema"),
    schema,
    kw("eavt"),
    1000003,
    kw("aevt"),
    1000003,
    kw("avet"),
    1000003,
    kw("max-eid"),
    Math.max(...datoms.map((d) => d[0])),
    kw("max-tx"),
    TX,
  ]);
  const tailData = tail.map((txn, i) =>
    txn.map(([e, a, v, added]) => [e, kw(a), encode(v), (added ? 1 : -1) * (TX + 1 + i)]),
  );

  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE kvs (addr INTEGER primary key, content TEXT, addresses JSON)");
  const ins = db.prepare("INSERT INTO kvs (addr, content, addresses) VALUES (?, ?, ?)");
  ins.run(0, w.write(root), null);
  ins.run(1, w.write(tailData), null);
  ins.run(1000001, w.write(transit.map([kw("keys"), leafA])), null);
  ins.run(1000002, w.write(transit.map([kw("keys"), leafB])), null);
  // Branch keys are separator copies of leaf datoms; the reader must not count them.
  ins.run(
    1000003,
    w.write(transit.map([kw("level"), 1, kw("keys"), [leafA[0], leafB[0]]])),
    JSON.stringify([1000001, 1000002]),
  );
  // An unreachable node, as garbage collection leaves behind: never read.
  ins.run(
    1000004,
    w.write(transit.map([kw("keys"), [[999, kw("block/title"), "garbage", TX]]])),
    null,
  );
  db.close();
}

// -------------------------------------------------------------------------------------------
// A complete invented DB-version graph: database, mirror, assets
// -------------------------------------------------------------------------------------------

export const U = {
  assetClass: "00000000-0000-4000-8000-000000000001",
  favorites: "00000000-0000-4000-8000-000000000010",
  favBlock: "00000000-0000-4000-8000-000000000011",
  garden: "00000000-0000-4000-8000-000000000020",
  gardenBlock: "00000000-0000-4000-8000-000000000021",
  journal: "00000000-0000-4000-8000-000000000030",
  planted: "00000000-0000-4000-8000-000000000031",
  photoAsset: "00000000-0000-4000-8000-000000000032",
  photoNote: "00000000-0000-4000-8000-000000000033",
  catalogueRef: "00000000-0000-4000-8000-000000000034",
  task: "00000000-0000-4000-8000-000000000035",
  seeRef: "00000000-0000-4000-8000-000000000036",
  late: "00000000-0000-4000-8000-000000000037",
  catalogue: "00000000-0000-4000-8000-000000000040",
  unplacedPic: "00000000-0000-4000-8000-000000000041",
} as const;

/** 2026-09-20 10:00 local time, as Logseq stores a `:datetime` (epoch ms). */
export const SCHEDULED_MS = new Date(2026, 8, 20, 10, 0).getTime();

export function fixtureDatoms(): FixtureDatom[] {
  const page = (e: number, uuid: string, title: string, extra: FixtureDatom[] = []) => [
    [e, "block/uuid", { uuid }],
    [e, "block/title", title],
    [e, "block/name", title.toLowerCase()],
    ...extra,
  ];
  const block = (
    e: number,
    uuid: string,
    title: string,
    pageE: number,
    parentE: number,
    order: string,
    extra: FixtureDatom[] = [],
  ) => [
    [e, "block/uuid", { uuid }],
    [e, "block/title", title],
    [e, "block/page", { ref: pageE }],
    [e, "block/parent", { ref: parentE }],
    [e, "block/order", order],
    ...extra,
  ];
  return [
    // Classes and closed values (idents).
    [1, "db/ident", { kw: "logseq.class/Asset" }],
    ...page(1, U.assetClass, "Asset", [[1, "logseq.property/built-in?", true]]),
    [2, "db/ident", { kw: "logseq.class/Journal" }],
    [3, "db/ident", { kw: "logseq.class/Page" }],
    [4, "db/ident", { kw: "logseq.class/Task" }],
    [5, "db/ident", { kw: "logseq.property/status.todo" }],
    [5, "block/title", "Todo"],
    // config.edn, kept inside the database.
    [6, "file/path", "logseq/config.edn"],
    [6, "file/content", '{:journal/page-title-format "MMM do, yyyy"}'],
    // Favourites.
    ...page(10, U.favorites, "$$$favorites", [[10, "logseq.property/hide?", true]]),
    ...block(11, U.favBlock, "", 10, 10, "a0", [[11, "block/link", { ref: 20 }]]),
    // A page.
    ...page(20, U.garden, "Garden Plans", [[20, "block/tags", { ref: 3 }]]),
    ...block(21, U.gardenBlock, "Layout ideas", 20, 20, "a0"),
    // A journal day.
    ...page(30, U.journal, "Sep 14th, 2026", [
      [30, "block/journal-day", 20260914],
      [30, "block/tags", { ref: 2 }],
    ]),
    ...block(31, U.planted, `Planted [[${U.garden}]] today`, 30, 30, "a0", [
      [31, "block/refs", { ref: 20 }],
    ]),
    // A pasted image placed in the outline: title is a timestamp, no link in the mirror.
    ...block(32, U.photoAsset, "2026-09-14-10-20-30", 30, 30, "a1", [
      [32, "block/tags", { ref: 1 }],
      [32, "logseq.property.asset/type", "png"],
      // B-789: resized to 320 px and centred in Logseq (ADR 034).
      [32, "logseq.property.asset/resize-metadata", { map: { width: 320 } }],
      [32, "logseq.property.asset/align", { kw: "center" }],
    ]),
    ...block(33, U.photoNote, "Photo of seedlings", 30, 30, "a2"),
    // A ref to an asset that lives on the Asset class page.
    ...block(34, U.catalogueRef, `[[${U.catalogue}]]`, 30, 33, "a0", [
      [34, "block/refs", { ref: 40 }],
    ]),
    ...block(35, U.task, "Water the plants", 30, 30, "a3", [
      [35, "block/tags", { ref: 4 }],
      [35, "logseq.property/status", { ref: 5 }],
      [35, "logseq.property/scheduled", SCHEDULED_MS],
    ]),
    ...block(36, U.seeRef, `see [[${U.planted}]]`, 30, 30, "a4", [[36, "block/refs", { ref: 31 }]]),
    // An asset (a file, not an image) on the Asset class page, referenced by uuid from block 34.
    ...block(40, U.catalogue, "seed-catalogue", 1, 1, "a0", [
      [40, "block/tags", { ref: 1 }],
      [40, "logseq.property.asset/type", "pdf"],
    ]),
    // An asset no block mentions.
    ...block(41, U.unplacedPic, "image_1700000000000_0", 1, 1, "a1", [
      [41, "block/tags", { ref: 1 }],
      [41, "logseq.property.asset/type", "jpg"],
    ]),
  ] as FixtureDatom[];
}

/** Not yet flushed into the index: a new block, and a retitled one. */
export function fixtureTail(): Array<Array<[number, string, FixtureValue, boolean]>> {
  return [
    [
      [37, "block/uuid", { uuid: U.late }, true],
      [37, "block/title", "Late addition", true],
      [37, "block/page", { ref: 30 }, true],
      [37, "block/parent", { ref: 30 }, true],
      [37, "block/order", "a5", true],
    ],
    [
      [21, "block/title", "Layout ideas", false],
      [21, "block/title", "Layout plan", true],
    ],
  ];
}

/** The mirror Logseq would write for the database above (`markdown_mirror.cljs`): page refs
 *  resolved to titles, refs to non-pages left as `[[uuid]]`, the asset block as its bare title,
 *  the task's status as a marker and its date as a `* Scheduled::` list item. */
export const FIXTURE_JOURNAL_MD = `- Planted [[Garden Plans]] today
- 2026-09-14-10-20-30
- Photo of seedlings
  - [[${U.catalogue}]]
- TODO Water the plants
  * Scheduled:: Sep 20th, 2026 10:00
- see [[${U.planted}]]
- Late addition
`;

export const FIXTURE_PAGE_MD = `- Layout plan
`;

export const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

/** Write the whole invented graph under `root` (the DB graph's root folder). */
export function writeFixtureDbGraph(root: string): void {
  mkdirSync(join(root, "mirror", "markdown", "journals"), { recursive: true });
  mkdirSync(join(root, "mirror", "markdown", "pages"), { recursive: true });
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFixtureDb(join(root, "db.sqlite"), fixtureDatoms(), fixtureTail());
  writeFileSync(join(root, "mirror", "markdown", "journals", "2026_09_14.md"), FIXTURE_JOURNAL_MD);
  writeFileSync(join(root, "mirror", "markdown", "pages", "Garden Plans.md"), FIXTURE_PAGE_MD);
  writeFileSync(join(root, "assets", `${U.photoAsset}.png`), PNG_BYTES);
  writeFileSync(join(root, "assets", `${U.catalogue}.pdf`), "%PDF-1.4 invented\n");
  writeFileSync(join(root, "assets", `${U.unplacedPic}.jpg`), "not really a jpeg");
}
