/**
 * Read-only reader for a Logseq DB-version graph's `db.sqlite` (B-715).
 *
 * Logseq's DB version keeps its graph in Datascript and persists Datascript's own storage format
 * into SQLite, one row per storage node: `kvs(addr INTEGER PRIMARY KEY, content TEXT, addresses
 * JSON)`. The markdown mirror it writes is a lossy one-way copy, so whatever the mirror drops
 * (which picture a timestamp line stands for, favourites, …) can only be recovered from here.
 *
 * Storage format, from the sources (checked 2026-10-04):
 *  - Datascript `src/datascript/storage.clj` (github.com/tonsky/datascript): address 0 is the root
 *    `{:schema … :eavt <addr> :aevt <addr> :avet <addr> :max-eid … :max-tx …}`; address 1 is the
 *    "tail", a vector of not-yet-flushed transactions, each a vector of datoms; every other address
 *    is a B-tree node `{:level n :keys [datom…] :addresses [addr…]}` (`:addresses` only on branch
 *    nodes). A datom is serialised as `[e a v tx]` (`serializable-datom`); in the tail a negative
 *    `tx` is a retraction (`datom-added` is `(pos? tx)` in `src/datascript/db.cljc`).
 *  - Logseq `deps/db/src/logseq/db/common/sqlite_cli.cljs` (`store-addr-content!`,
 *    `restore-data-from-addr`): `content` is the node written with transit-JSON, minus
 *    `:addresses`, which is moved to the `addresses` column as a JSON array.
 *
 * Transit is a real encoding, not JSON with quirks: `"^1"` is a cache reference to a keyword seen
 * earlier in the same document, `"~:block/title"` is a keyword, `"~u…"` a uuid. Hence the one
 * dependency, `transit-js` (Cognitect's reference implementation, no dependencies of its own),
 * pinned exactly and used only here, server-side.
 *
 * Safety: Logseq may be running and holding the database. This module never opens the file it is
 * given: it copies `db.sqlite` (and `db.sqlite-wal` when present, so recent writes not yet
 * checkpointed are seen) into a fresh temporary directory, opens the copy, and deletes it.
 *
 * Only the EAVT index is walked; AEVT/AVET hold the same datoms in other orders.
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import transit from "transit-js";

/** A Clojure keyword value (`:logseq.class/Asset`), kept distinct from a string. `name` has no
 *  leading colon. */
export class LogseqKeyword {
  constructor(readonly name: string) {}
  toString(): string {
    return `:${this.name}`;
  }
}

export type LogseqValue = string | number | boolean | null | LogseqKeyword | LogseqValue[] | object;

export interface LogseqDatom {
  e: number;
  /** Attribute keyword name without the colon, e.g. `block/title`. */
  a: string;
  v: LogseqValue;
  tx: number;
}

/** Transit values → plain JS: keywords become `LogseqKeyword`, uuids strings, maps `Map`s. */
function plain(v: unknown): LogseqValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (transit.isKeyword(v)) return new LogseqKeyword(String(v).replace(/^:/, ""));
  if (transit.isUUID(v)) return String(v);
  if (transit.isInteger(v)) return Number(String(v));
  if (Array.isArray(v)) return v.map(plain);
  if (transit.isMap(v)) {
    const out = new Map<string, LogseqValue>();
    (v as { forEach(f: (val: unknown, key: unknown) => void): void }).forEach((val, key) => {
      out.set(keyName(key), plain(val));
    });
    return out;
  }
  if (transit.isSet(v)) {
    const out: LogseqValue[] = [];
    (v as { forEach(f: (val: unknown) => void): void }).forEach((val) => {
      out.push(plain(val));
    });
    return out;
  }
  if (v instanceof Date) return v.getTime();
  return v as object;
}

function keyName(k: unknown): string {
  return transit.isKeyword(k) ? String(k).replace(/^:/, "") : String(k);
}

function asDatom(raw: unknown): LogseqDatom | null {
  if (!Array.isArray(raw) || raw.length < 4) return null;
  const [e, a, v, tx] = raw;
  const ev = plain(e);
  const txv = plain(tx);
  if (typeof ev !== "number" || typeof txv !== "number") return null;
  return { e: ev, a: keyName(a), v: plain(v), tx: txv };
}

/** Raw storage access: a `kvs` table and a transit reader. Separate from the entity model so the
 *  tests can check the walk itself. */
export function readLogseqDbDatoms(sqliteFile: string): {
  datoms: LogseqDatom[];
  manyAttrs: Set<string>;
} {
  const scratch = mkdtempSync(join(tmpdir(), "nooklet-logseq-db-"));
  try {
    const copy = join(scratch, "db.sqlite");
    copyFileSync(sqliteFile, copy);
    if (existsSync(`${sqliteFile}-wal`)) copyFileSync(`${sqliteFile}-wal`, `${copy}-wal`);
    // Opened read-write on purpose: it is our own copy, and SQLite needs to write the `-shm`
    // index to replay a WAL. The original is never opened.
    const db = new DatabaseSync(copy);
    try {
      return walk(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function walk(db: DatabaseSync): { datoms: LogseqDatom[]; manyAttrs: Set<string> } {
  const reader = transit.reader("json");
  const stmt = db.prepare("SELECT content, addresses FROM kvs WHERE addr = ?");
  const load = (addr: number): { data: unknown; addresses: number[] | null } | null => {
    const row = stmt.get(addr) as { content: string; addresses: string | null } | undefined;
    if (!row) return null;
    return {
      data: reader.read(row.content),
      addresses: row.addresses ? (JSON.parse(row.addresses) as number[]) : null,
    };
  };
  const field = (m: unknown, k: string): unknown =>
    transit.isMap(m) ? (m as { get(k: unknown): unknown }).get(transit.keyword(k)) : undefined;

  const root = load(0);
  if (!root) throw new Error("not a Logseq DB graph: kvs has no root node (address 0)");
  const eavt = Number(plain(field(root.data, "eavt")));
  if (!Number.isFinite(eavt)) throw new Error("not a Logseq DB graph: root node has no :eavt");

  const manyAttrs = new Set<string>();
  const schema = plain(field(root.data, "schema"));
  if (schema instanceof Map) {
    for (const [attr, spec] of schema) {
      if (!(spec instanceof Map)) continue;
      const card = spec.get("db/cardinality");
      if (card instanceof LogseqKeyword && card.name === "db.cardinality/many") manyAttrs.add(attr);
    }
  }

  // Index nodes first, then the tail on top. Iterative: a deep tree must not blow the stack.
  const live = new Map<string, LogseqDatom>();
  const keyOf = (d: LogseqDatom): string => `${d.e}\u0000${d.a}\u0000${valueKey(d.v)}`;
  const stack = [eavt];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const addr = stack.pop() as number;
    if (seen.has(addr)) continue;
    seen.add(addr);
    const node = load(addr);
    if (!node) throw new Error(`Logseq DB storage node ${addr} is missing`);
    // Branch keys are separators copied from the leaves; only leaves own datoms.
    const addresses = node.addresses ?? (plain(field(node.data, "addresses")) as number[] | null);
    if (Array.isArray(addresses) && addresses.length > 0) {
      for (let i = addresses.length - 1; i >= 0; i--) stack.push(Number(addresses[i]));
      continue;
    }
    const keys = field(node.data, "keys");
    if (!Array.isArray(keys)) continue;
    for (const raw of keys) {
      const d = asDatom(raw);
      if (d) live.set(keyOf(d), d);
    }
  }

  const tail = load(1);
  if (tail && Array.isArray(tail.data)) {
    for (const txDatoms of tail.data) {
      if (!Array.isArray(txDatoms)) continue;
      for (const raw of txDatoms) {
        const d = asDatom(raw);
        if (!d) continue;
        if (d.tx < 0) {
          live.delete(keyOf(d));
          continue;
        }
        // A cardinality-one assertion replaces the old value (Datascript's transact writes the
        // retraction too, but nothing is lost by enforcing it here as well).
        if (!manyAttrs.has(d.a)) {
          for (const [k, old] of live) {
            // Only reached for tail datoms, which are few; the scan is bounded by the tail.
            if (old.e === d.e && old.a === d.a) live.delete(k);
          }
        }
        live.set(keyOf(d), d);
      }
    }
  }
  return { datoms: [...live.values()], manyAttrs };
}

function valueKey(v: LogseqValue): string {
  if (v instanceof LogseqKeyword) return `:${v.name}`;
  if (typeof v === "object" && v !== null) return JSON.stringify(v);
  return `${typeof v}:${String(v)}`;
}

// -------------------------------------------------------------------------------------------
// Entity model
// -------------------------------------------------------------------------------------------

/** Attribute names used below, from Logseq `deps/db/src/logseq/db/frontend/schema.cljs` and
 *  `.../property.cljs` (checked 2026-10-04). */
const A = {
  ident: "db/ident",
  uuid: "block/uuid",
  title: "block/title",
  name: "block/name",
  page: "block/page",
  parent: "block/parent",
  order: "block/order",
  tags: "block/tags",
  link: "block/link",
  journalDay: "block/journal-day",
  assetType: "logseq.property.asset/type",
  assetExternalUrl: "logseq.property.asset/external-url",
  status: "logseq.property/status",
  priority: "logseq.property/priority",
  scheduled: "logseq.property/scheduled",
  deadline: "logseq.property/deadline",
  createdFromProperty: "logseq.property/created-from-property",
  closedValueProperty: "block/closed-value-property",
} as const;

/** `common-config/favorites-page-name` in Logseq `deps/common/src/logseq/common/config.cljs`. */
export const LOGSEQ_FAVORITES_PAGE = "$$$favorites";

export class LogseqDbGraph {
  readonly entities = new Map<number, Map<string, LogseqValue>>();
  private readonly byUuidIndex = new Map<string, number>();
  private readonly byIdentIndex = new Map<string, number>();
  private readonly childrenIndex = new Map<number, number[]>();

  constructor(datoms: readonly LogseqDatom[], manyAttrs: ReadonlySet<string>) {
    for (const d of datoms) {
      let ent = this.entities.get(d.e);
      if (!ent) {
        ent = new Map();
        this.entities.set(d.e, ent);
      }
      if (manyAttrs.has(d.a)) {
        const arr = (ent.get(d.a) as LogseqValue[] | undefined) ?? [];
        arr.push(d.v);
        ent.set(d.a, arr);
      } else {
        ent.set(d.a, d.v);
      }
    }
    for (const [eid, ent] of this.entities) {
      const uuid = ent.get(A.uuid);
      if (typeof uuid === "string") this.byUuidIndex.set(uuid, eid);
      const ident = ent.get(A.ident);
      if (ident instanceof LogseqKeyword) this.byIdentIndex.set(ident.name, eid);
      const parent = ent.get(A.parent);
      if (typeof parent === "number") {
        const kids = this.childrenIndex.get(parent) ?? [];
        kids.push(eid);
        this.childrenIndex.set(parent, kids);
      }
    }
  }

  static fromFile(sqliteFile: string): LogseqDbGraph {
    const { datoms, manyAttrs } = readLogseqDbDatoms(sqliteFile);
    return new LogseqDbGraph(datoms, manyAttrs);
  }

  get(eid: number, attr: string): LogseqValue | undefined {
    return this.entities.get(eid)?.get(attr);
  }
  str(eid: number, attr: string): string | undefined {
    const v = this.get(eid, attr);
    return typeof v === "string" ? v : undefined;
  }
  num(eid: number, attr: string): number | undefined {
    const v = this.get(eid, attr);
    return typeof v === "number" ? v : undefined;
  }
  refs(eid: number, attr: string): number[] {
    const v = this.get(eid, attr);
    if (typeof v === "number") return [v];
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [];
  }
  ident(eid: number): string | undefined {
    const v = this.get(eid, A.ident);
    return v instanceof LogseqKeyword ? v.name : undefined;
  }
  byUuid(uuid: string): number | undefined {
    return this.byUuidIndex.get(uuid);
  }
  byIdent(ident: string): number | undefined {
    return this.byIdentIndex.get(ident);
  }
  uuid(eid: number): string | undefined {
    return this.str(eid, A.uuid);
  }
  title(eid: number): string | undefined {
    return this.str(eid, A.title);
  }
  /** Class idents (`logseq.class/Asset`) and titles of user tags on an entity. */
  tagIdents(eid: number): string[] {
    return this.refs(eid, A.tags).map((t) => this.ident(t) ?? this.title(t) ?? String(t));
  }
  hasClass(eid: number, classIdent: string): boolean {
    const cls = this.byIdent(classIdent);
    return cls !== undefined && this.refs(eid, A.tags).includes(cls);
  }

  /** The text of a file the DB version keeps inside the database (`:file/path` →
   *  `:file/content`), e.g. `logseq/config.edn`. */
  fileContent(path: string): string | undefined {
    for (const ent of this.entities.values()) {
      if (ent.get("file/path") === path) {
        const c = ent.get("file/content");
        return typeof c === "string" ? c : undefined;
      }
    }
    return undefined;
  }

  /** A block's children in the order Logseq's mirror writes them: by `:block/order`, without
   *  property-derived blocks (`outline-children` in Logseq
   *  `src/main/frontend/worker/markdown_mirror.cljs`). */
  outlineChildren(eid: number): number[] {
    const kids = (this.childrenIndex.get(eid) ?? []).filter(
      (k) =>
        this.get(k, A.createdFromProperty) === undefined &&
        this.get(k, A.closedValueProperty) === undefined,
    );
    return kids.sort((a, b) => {
      const oa = this.str(a, A.order) ?? "";
      const ob = this.str(b, A.order) ?? "";
      // Fractional-index keys compare by code unit, not locale.
      return oa < ob ? -1 : oa > ob ? 1 : a - b;
    });
  }

  /** Every block of a page in mirror (pre-)order. */
  pageBlocksInOrder(pageEid: number): number[] {
    const out: number[] = [];
    const visit = (eid: number): void => {
      for (const kid of this.outlineChildren(eid)) {
        out.push(kid);
        visit(kid);
      }
    };
    visit(pageEid);
    return out;
  }

  /** Page entities: anything with a `:block/name` and no `:block/page` (blocks carry a page). */
  pages(): LogseqDbPage[] {
    const out: LogseqDbPage[] = [];
    for (const [eid, ent] of this.entities) {
      if (typeof ent.get(A.name) !== "string" || ent.get(A.page) !== undefined) continue;
      const uuid = ent.get(A.uuid);
      if (typeof uuid !== "string") continue;
      const jd = ent.get(A.journalDay);
      out.push({
        eid,
        uuid,
        title: this.title(eid) ?? (ent.get(A.name) as string),
        journalDay: typeof jd === "number" ? jd : null,
        builtIn: ent.get("logseq.property/built-in?") === true,
        hidden: ent.get("logseq.property/hide?") === true,
        tags: this.tagIdents(eid),
      });
    }
    return out;
  }

  /** Asset entities: blocks tagged `:logseq.class/Asset` that carry `:logseq.property.asset/type`.
   *  Their file is `assets/<uuid>.<type>` in the graph directory. */
  assets(): LogseqDbAsset[] {
    const out: LogseqDbAsset[] = [];
    for (const [eid, ent] of this.entities) {
      const type = ent.get(A.assetType);
      const uuid = ent.get(A.uuid);
      if (typeof type !== "string" || typeof uuid !== "string") continue;
      const page = ent.get(A.page);
      const parent = ent.get(A.parent);
      const ext = ent.get(A.assetExternalUrl);
      out.push({
        eid,
        uuid,
        title: this.title(eid) ?? "",
        type,
        fileName: `${uuid}.${type}`,
        pageEid: typeof page === "number" ? page : null,
        parentEid: typeof parent === "number" ? parent : null,
        externalUrl: typeof ext === "string" ? ext : null,
      });
    }
    return out;
  }

  /** The pages favourited in Logseq, in sidebar order: blocks on the hidden `$$$favorites` page
   *  whose `:block/link` points at the page (Logseq `deps/db/src/logseq/db/frontend/db.cljs`
   *  `build-favorite-tx`). */
  favoritePages(): LogseqDbPage[] {
    const pages = this.pages();
    const favPage = pages.find(
      (p) => p.title === LOGSEQ_FAVORITES_PAGE || this.str(p.eid, A.name) === LOGSEQ_FAVORITES_PAGE,
    );
    if (!favPage) return [];
    const byEid = new Map(pages.map((p) => [p.eid, p]));
    const out: LogseqDbPage[] = [];
    for (const blk of this.outlineChildren(favPage.eid)) {
      const target = this.refs(blk, A.link)[0];
      const page = target === undefined ? undefined : byEid.get(target);
      if (page) out.push(page);
    }
    return out;
  }
}

export interface LogseqDbPage {
  eid: number;
  uuid: string;
  title: string;
  /** `yyyymmdd`, like nooklet's own journal day. */
  journalDay: number | null;
  builtIn: boolean;
  hidden: boolean;
  tags: string[];
}

export interface LogseqDbAsset {
  eid: number;
  uuid: string;
  title: string;
  /** File extension without the dot (`png`). */
  type: string;
  /** `<uuid>.<type>` — the file's name under the graph's `assets/`. */
  fileName: string;
  pageEid: number | null;
  parentEid: number | null;
  externalUrl: string | null;
}

/** Attribute names, exported for the importer and tests. */
export const LOGSEQ_DB_ATTRS = A;
