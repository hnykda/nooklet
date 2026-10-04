/**
 * Logseq importer (ADR 012 for the file graph, ADR 030 for the DB version).
 *
 * This module does not reparse markdown itself: every file's outline is produced by
 * `packages/core`'s `parseOutline` (`docs/spec/markdown-grammar.md`), which already tolerates
 * Logseq's spellings (tabs/spaces, `id::`, property key remaps, SCHEDULED/DEADLINE/LOGBOOK,
 * `heading::`, literal `1.`/`*`/`+` bullets). This file's job is everything upstream and
 * downstream of that parse:
 *
 *   1. `logseq/config.edn` (a tiny EDN subset, `parseLogseqConfigEdn`) for the handful of keys
 *      that change how a file name/title maps to a page name.
 *   2. Directory scanning + page name resolution (`fileNameToPageName`/`journalDayFromFileName`
 *      from `page-name.ts`/`journal.ts`, `title::` override, duplicate-name detection).
 *   3. Two-pass Logseq-uuid -> nooklet-id conversion (`assignIds`/`rewriteBlockRefs`) so `((uuid))`
 *      block refs keep resolving after import.
 *   4. Turning each page's tree into `page.create`/`block.create` ops (fractional-index sibling
 *      order via `ordersBetween`) and applying them through `serverApplyOps` — the server's own
 *      ref/path_ref indexing, cycle correction, and `changes` audit trail all run for free.
 *
 * Two source formats, detected by `detectLogseqGraph` (ADR 012's file-graph-only scope was widened
 * by the owner on 2026-10-04, B-715):
 *
 *   - the classic file graph: `pages/`, `journals/`, `assets/`, `logseq/config.edn`;
 *   - the DB version: `db.sqlite` + `assets/` + the Markdown Mirror at `mirror/markdown/`. Pages
 *     come from the mirror, exactly like a file graph's; what the mirror loses (images, refs written
 *     as uuids, SCHEDULED, favourites) is put back from `db.sqlite` by `logseq-db-import.ts`.
 *
 * Detection lives here, not in the CLI, so the in-app import calls the same thing.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  type AppliedOpResult,
  DEFAULT_JOURNAL_TITLE_FORMAT,
  fileNameToPageName,
  isoJournalName,
  journalDayFromFileName,
  makeOp,
  newId,
  normalizePageName,
  type Op,
  type OutlineNode,
  ordersBetween,
  type ParsedPage,
  parseOutline,
  parseTaskWorkflow,
  type TaskWorkflow,
} from "@nooklet/core";
import { type ServerContext, serverApplyOps } from "../apply-ops.js";
import { assetMarkdownPath, mimeFromFilename, storeAssetBytes } from "../assets/store.js";
import { setSuggestedJournalTitleFormat } from "../journal-format.js";
import { REFERENCE_DEVICE_ID, referenceKey, unclaimedReferencePageForKey } from "../ref-pages.js";
import { mintDanglingReferencedPages } from "../ref-pages-migration.js";
import { setRecordedTaskWorkflow } from "../task-workflow.js";
import { LogseqDbGraph } from "./logseq-db.js";
import { enrichFromLogseqDb, type LogseqDbStats } from "./logseq-db-import.js";

// -------------------------------------------------------------------------------------------
// config.edn (tiny EDN subset)
// -------------------------------------------------------------------------------------------

export interface LogseqConfig {
  /** `:journal/file-name-format`. Informational only: `journalDayFromFileName` (core) already
   *  accepts both `yyyy_MM_dd` and `yyyy-MM-dd` regardless of this value, so nothing here
   *  currently branches on it — kept so config.edn parsing has somewhere to put the value and a
   *  future exporter/stricter importer has it available. */
  journalFileNameFormat: string;
  /** `:journal/page-title-format` (date-fns pattern). Used to render a journal page's display
   *  name from its day, e.g. "Sep 10th, 2026". */
  journalPageTitleFormat: string;
  /** `:file/name-format` — `:triple-lowbar` when present, else Logseq's legacy (pre-0.8.9)
   *  `%2F`-style url-encoded names. NOTE: `fileNameToPageName` (core) already decodes both
   *  unconditionally (`___` -> `/`, then percent-decode), so this field currently has no effect
   *  on parsing either — see the module-level comment on `resolvePageFileName` for why we do
   *  NOT additionally special-case the pre-2022-05 "legacy-dot" (`/` -> `.`) encoding some very
   *  old graphs use even when this value is absent. */
  fileNameFormat: "triple-lowbar" | "legacy";
  /** `:preferred-workflow` (B-608), read the way Logseq reads it (`/now|NOW/` → `now`, any other
   *  value → `todo`); `null` when the key is absent, so the graph's markers decide instead
   *  (`../task-workflow.ts`). */
  preferredWorkflow: TaskWorkflow | null;
  /** `:favorites` — page names favourited in the file graph's sidebar, in order. The DB version
   *  keeps favourites in the database instead (`LogseqDbGraph.favoritePages`). */
  favorites: string[];
}

export const DEFAULT_LOGSEQ_CONFIG: LogseqConfig = {
  journalFileNameFormat: "yyyy_MM_dd",
  journalPageTitleFormat: DEFAULT_JOURNAL_TITLE_FORMAT,
  fileNameFormat: "legacy",
  preferredWorkflow: null,
  favorites: [],
};

/** Strip EDN line comments (`;` to end of line), respecting string literals, so a commented-out
 *  example like `;; :journal/page-title-format "..."` in the stock template is never mistaken
 *  for a real value. Not a general EDN reader — just enough to make the regexes below safe. */
function stripEdnComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (inString) {
      out += c;
      if (c === "\\") {
        i++;
        out += text[i] ?? "";
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === ";") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += c;
  }
  return out;
}

function ednStringValue(text: string, key: string): string | undefined {
  const m = new RegExp(`:${key}\\s+"([^"]*)"`).exec(text);
  return m?.[1];
}

/** `:key ["a" "b"]` — a vector of strings. Logseq writes favourites lowercased, sometimes as
 *  `"[[Page]]"`; both are unwrapped. */
function ednStringVector(text: string, key: string): string[] | undefined {
  const m = new RegExp(`:${key}\\s+\\[`).exec(text);
  if (!m) return undefined;
  // Scan to the closing `]`, skipping strings: a name may itself contain `]` (`"[[Page]]"`).
  const out: string[] = [];
  let i = m.index + m[0].length;
  for (; i < text.length && text[i] !== "]"; i++) {
    if (text[i] !== '"') continue;
    let s = "";
    for (i++; i < text.length && text[i] !== '"'; i++) {
      if (text[i] === "\\") i++;
      s += text[i] ?? "";
    }
    out.push(s);
  }
  return out
    .map((x) => x.trim())
    .map((x) => (x.startsWith("[[") && x.endsWith("]]") ? x.slice(2, -2).trim() : x))
    .filter((x) => x !== "");
}

function ednKeywordValue(text: string, key: string): string | undefined {
  const m = new RegExp(`:${key}\\s+:([a-zA-Z0-9_-]+)`).exec(text);
  return m?.[1];
}

/**
 * Parse the handful of `config.edn` keys that affect page-name resolution. This is deliberately
 * not a general EDN reader (no vectors/maps/sets/numbers beyond what's needed) — see ADR 012 and
 * `docs/research/01-logseq.md` section 2.2 for the full key list; only three matter here. A key
 * that is absent, commented out, or written in a shape this parser doesn't recognize silently
 * falls back to Logseq's own documented default (never throws).
 */
export function parseLogseqConfigEdn(text: string): LogseqConfig {
  const stripped = stripEdnComments(text);
  return {
    journalFileNameFormat:
      ednStringValue(stripped, "journal/file-name-format") ??
      DEFAULT_LOGSEQ_CONFIG.journalFileNameFormat,
    journalPageTitleFormat:
      ednStringValue(stripped, "journal/page-title-format") ??
      DEFAULT_LOGSEQ_CONFIG.journalPageTitleFormat,
    fileNameFormat:
      ednKeywordValue(stripped, "file/name-format") === "triple-lowbar"
        ? "triple-lowbar"
        : "legacy",
    // Logseq accepts a keyword (`:now`) or, in older configs, a string (`"now"`).
    preferredWorkflow: parseTaskWorkflow(
      ednKeywordValue(stripped, "preferred-workflow") ??
        ednStringValue(stripped, "preferred-workflow"),
    ),
    favorites: ednStringVector(stripped, "favorites") ?? [],
  };
}

/** Where a Logseq graph's parts are, and which of the two formats it is. */
export type LogseqGraphLayout =
  | { kind: "file"; root: string; markdownDir: string }
  | { kind: "db"; root: string; markdownDir: string; sqliteFile: string };

/**
 * Which kind of Logseq graph `dir` is. A DB-version graph is recognised by `db.sqlite` next to
 * `mirror/markdown/`; pointing at the mirror folder itself (or its `markdown/` child) finds the
 * graph root two/one levels up. Everything else is a file graph, read the way it always was. A DB
 * graph without a mirror cannot be imported (pages come from the mirror) and says how to fix it.
 */
export function detectLogseqGraph(dir: string): LogseqGraphLayout {
  for (const root of [dir, dirname(dir), dirname(dirname(dir))]) {
    const sqliteFile = join(root, "db.sqlite");
    const markdownDir = join(root, "mirror", "markdown");
    if (!existsSync(sqliteFile)) continue;
    if (root !== dir && markdownDir !== dir && join(root, "mirror") !== dir) continue;
    if (!existsSync(markdownDir)) {
      throw new Error(
        `${dir} is a Logseq DB-version graph without a Markdown Mirror: turn on Settings → Markdown Mirror in Logseq (desktop), run "Regenerate full mirror", then import again`,
      );
    }
    return { kind: "db", root, markdownDir, sqliteFile };
  }
  return { kind: "file", root: dir, markdownDir: dir };
}

/** A DB-version graph keeps its `config.edn` inside the database. Its `:favorites` key is unused
 *  there ("is not stored in config for DB graphs", Logseq `deps/common/src/logseq/common/
 *  config.cljs`), so favourites come from the database instead. */
function dbConfig(g: LogseqDbGraph, warnings: string[]): LogseqConfig {
  const text = g.fileContent("logseq/config.edn");
  if (text === undefined) return DEFAULT_LOGSEQ_CONFIG;
  try {
    return { ...parseLogseqConfigEdn(text), favorites: [] };
  } catch (err) {
    warnings.push(`db.sqlite: could not parse its config.edn (${errMsg(err)}); using defaults`);
    return DEFAULT_LOGSEQ_CONFIG;
  }
}

function withoutNames(s: LogseqDbStats): Omit<LogseqDbStats, "favoritePageNames"> {
  const { favoritePageNames: _names, ...rest } = s;
  return rest;
}

function readConfig(graphDir: string, warnings: string[]): LogseqConfig {
  const path = join(graphDir, "logseq", "config.edn");
  if (!existsSync(path)) return DEFAULT_LOGSEQ_CONFIG;
  try {
    return parseLogseqConfigEdn(readFileSync(path, "utf8"));
  } catch (err) {
    warnings.push(
      `${relative(graphDir, path)}: could not parse config.edn (${errMsg(err)}); using defaults`,
    );
    return DEFAULT_LOGSEQ_CONFIG;
  }
}

// -------------------------------------------------------------------------------------------
// Directory scanning + page name resolution
// -------------------------------------------------------------------------------------------

interface FileEntry {
  filePath: string;
  /** Path relative to `graphDir`, for warnings/errors. */
  relPath: string;
  isJournal: boolean;
  journalDay: number | null;
  parsed: ParsedPage;
  resolvedName: string;
}

function listMdFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".md") && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * `fileNameToPageName` (core) already handles both encodings an importer needs to accept
 * (triple-lowbar `___` and legacy `%2F` percent-encoding) unconditionally, regardless of
 * `config.edn`'s `:file/name-format`. We deliberately do NOT also decode the older (pre-2022-05)
 * "legacy-dot" scheme (`/` -> `.`, e.g. `A.B.C.md`): unlike the other two, it's ambiguous by
 * construction (a page legitimately named with a literal `.`, e.g. "v1.2" or a filename with an
 * extension-looking suffix, is indistinguishable from a namespace separator) and applying it
 * unconditionally would corrupt ordinary titles. This is a deliberate scope cut, not an
 * oversight — flagged in the module summary.
 */
function resolvePageFileName(base: string): string {
  return fileNameToPageName(base);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Scans `pages/` then `journals/` (in that order; each sorted by file name) and resolves each
 *  file's page name, deduplicating by normalized key. Two files that name the same page are
 *  MERGED, never dropped: the old "first file wins, later ones are skipped" rule silently lost
 *  notes on a real graph exported by Logseq's DB version, whose mirror wrote three journal days
 *  twice — a one-line stub under `pages/` (scanned first, so it won) and the real five-line day
 *  under `journals/` (skipped). Now a journal file's identity wins (it is a journal day), page
 *  properties keep the first value per key, and both files' blocks are kept, journal first. */
function resolveFileEntries(graphDir: string, warnings: string[]): FileEntry[] {
  const entries: FileEntry[] = [];
  const seenKeys = new Map<string, number>();

  const record = (candidate: Omit<FileEntry, "relPath" | "filePath">, filePath: string): void => {
    const relPath = relative(graphDir, filePath);
    const key = normalizePageName(candidate.resolvedName);
    const firstIndex = seenKeys.get(key);
    if (firstIndex !== undefined) {
      const first = entries[firstIndex] as FileEntry;
      const journalWins = candidate.isJournal && !first.isJournal;
      const primary = journalWins ? { ...candidate, filePath, relPath } : first;
      const secondary = journalWins ? first : { ...candidate, filePath, relPath };
      entries[firstIndex] = {
        ...primary,
        parsed: {
          properties: { ...secondary.parsed.properties, ...primary.parsed.properties },
          blocks: [...primary.parsed.blocks, ...secondary.parsed.blocks],
        },
      };
      warnings.push(
        `${relPath}: page name "${candidate.resolvedName}" also came from ${first.relPath}; the two files were merged (${primary.relPath}'s blocks first)`,
      );
      return;
    }
    seenKeys.set(key, entries.length);
    entries.push({ ...candidate, filePath, relPath });
  };

  const pagesDir = join(graphDir, "pages");
  for (const fileName of listMdFiles(pagesDir)) {
    const filePath = join(pagesDir, fileName);
    const base = fileName.slice(0, -3);
    let parsed: ParsedPage;
    try {
      parsed = parseOutline(readFileSync(filePath, "utf8"));
    } catch (err) {
      warnings.push(
        `${relative(graphDir, filePath)}: could not read/parse file (${errMsg(err)}), skipped`,
      );
      continue;
    }
    const titleOverride = parsed.properties.title?.trim();
    const resolvedName = titleOverride || resolvePageFileName(base) || base;
    record({ isJournal: false, journalDay: null, parsed, resolvedName }, filePath);
  }

  const journalsDir = join(graphDir, "journals");
  for (const fileName of listMdFiles(journalsDir)) {
    const filePath = join(journalsDir, fileName);
    const base = fileName.slice(0, -3);
    let parsed: ParsedPage;
    try {
      parsed = parseOutline(readFileSync(filePath, "utf8"));
    } catch (err) {
      warnings.push(
        `${relative(graphDir, filePath)}: could not read/parse file (${errMsg(err)}), skipped`,
      );
      continue;
    }
    const titleOverride = parsed.properties.title?.trim();
    const day = journalDayFromFileName(base);
    if (day === null) {
      // Not a recognizable journal file name: import it as an ordinary page rather than drop it.
      const resolvedName = titleOverride || base;
      warnings.push(
        `${relative(graphDir, filePath)}: unrecognized journal file name, imported as a regular page named "${resolvedName}"`,
      );
      record({ isJournal: false, journalDay: null, parsed, resolvedName }, filePath);
      continue;
    }
    // A journal page is stored under its ISO name (ADR 018) — `config.journalPageTitleFormat` is
    // the format the SOURCE graph wrote its titles in, which is what `parseJournalTitle` needs to
    // resolve `[[Mon, 07.09.2026]]` references, not a name to carry into storage. A `title::`
    // override is ignored for the same reason: the day already names the page.
    record(
      { isJournal: true, journalDay: day, parsed, resolvedName: isoJournalName(day) },
      filePath,
    );
  }

  return entries;
}

// -------------------------------------------------------------------------------------------
// Pass 1: Logseq id (uuid, or occasionally something else) -> nooklet id
// -------------------------------------------------------------------------------------------

/** Depth-first walk of one file's outline tree (local copy of `outline.ts`'s `walkOutline` shape
 *  — we only need the node, not parent/depth/index, and want a plain array of nodes here). */
function* eachNode(nodes: readonly OutlineNode[]): Generator<OutlineNode> {
  for (const node of nodes) {
    yield node;
    yield* eachNode(node.children);
  }
}

interface IdAssignment {
  /** Logseq id (uuid or otherwise) -> fresh nooklet id, for every block that carried one. Used
   *  only to rewrite `((id))` references (pass 2); never consulted for a block's own identity. */
  idMap: Map<string, string>;
  /** Every outline node (whether or not it carried a Logseq id) -> the fresh nooklet id it will be
   *  created with. Keyed by node identity since the same in-memory tree is walked in both
   *  passes. */
  nodeIds: Map<OutlineNode, string>;
}

/**
 * Pass 1 (task step 4): walk every kept file's tree up front and mint one fresh `newId()` per
 * block, unconditionally (`nodeIds`), plus register it under the block's Logseq id when it has
 * one (`idMap`) so pass 2 can rewrite `((uuid))` references anywhere in the graph, including
 * across pages. Must run to completion over *all* files before pass 2 starts: a block ref can
 * point at a block on a different page than the one being rewritten.
 *
 * If two blocks (a malformed/duplicate `id::`, which Logseq itself repairs lazily rather than
 * preventing) carry the same Logseq id, the first one wins the `idMap` entry — refs resolve to
 * it, and one warning is recorded — while the second block still gets its own fresh id for
 * structural purposes via `nodeIds`.
 */
function assignIds(entries: readonly FileEntry[], warnings: string[]): IdAssignment {
  const idMap = new Map<string, string>();
  const nodeIds = new Map<OutlineNode, string>();
  for (const entry of entries) {
    for (const node of eachNode(entry.parsed.blocks)) {
      nodeIds.set(node, newId());
      if (node.id === undefined) continue;
      if (idMap.has(node.id)) {
        warnings.push(
          `${entry.relPath}: duplicate block id "${node.id}"; block refs to it resolve to its first occurrence`,
        );
        continue;
      }
      // biome-ignore lint/style/noNonNullAssertion: just set above in nodeIds
      idMap.set(node.id, nodeIds.get(node)!);
    }
  }
  return { idMap, nodeIds };
}

/** A block ref is `((` + a 36-char Logseq uuid + `))` (task step 4's exact candidate shape — we
 *  don't re-tokenize; a plain substring replace of matches that resolve is sufficient). A
 *  candidate whose inner text isn't in `idMap` is left untouched: either it's already a 14-char
 *  nooklet id (re-importing previously exported content — never matches this pattern) or it's
 *  genuinely dangling (the target block doesn't exist in this graph; Logseq itself accumulates
 *  these over time per `docs/research/01-logseq.md`). */
const BLOCK_REF_CANDIDATE_RE = /\(\(([0-9a-f-]{36})\)\)/g;

// -------------------------------------------------------------------------------------------
// Assets: copy `assets/*` into the data directory and re-point the links
// -------------------------------------------------------------------------------------------

/** `](../assets/name.png)` or `](assets/name.png)` — Logseq writes the former from pages/ and
 *  journals/; the latter turns up in graphs edited by hand. The name may be percent-encoded. */
const ASSET_LINK_RE = /\]\((?:\.\.\/)?assets\/([^)\s]+)\)/g;

/**
 * Bring every file in `<graphDir>/assets/` across through the same writer `asset.upload` uses,
 * so an imported picture is indistinguishable from an uploaded one. Returns the map from the
 * original file name to the markdown path blocks should now carry. Content-addressed, so a
 * re-run after a partial failure copies nothing twice.
 */
function importAssets(
  ctx: ServerContext,
  graphDir: string,
  dataDir: string,
  warnings: string[],
): { paths: Map<string, string>; imported: number } {
  const dir = join(graphDir, "assets");
  const paths = new Map<string, string>();
  let imported = 0;
  if (!existsSync(dir)) return { paths, imported };
  // Symlinks are never followed, here or per entry below (B-127). An imported asset is served
  // WITHOUT authentication at /assets/:id and syncs to every device, so a link in a graph someone
  // else made — `assets/pic.png -> ~/.ssh/id_ed25519` — would publish whatever it points at. The
  // old `statSync(path).isFile()` followed links, and threw ENOENT out of the whole import on a
  // dangling one. Dirent types come from lstat, so they describe the link, not its target.
  if (lstatSync(dir).isSymbolicLink()) {
    warnings.push("assets/ is a symbolic link, not followed: no assets were imported");
    return { paths, imported };
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name;
    if (name.startsWith(".")) continue;
    if (entry.isSymbolicLink()) {
      warnings.push(`assets/${name}: a symbolic link, not followed`);
      continue;
    }
    if (!entry.isFile()) continue;
    const filePath = join(dir, name);
    try {
      const stored = storeAssetBytes(ctx.driver, dataDir, {
        bytes: readFileSync(filePath),
        fileName: name,
        mimeType: mimeFromFilename(name),
        origin: "import",
        actor: IMPORTER_ACTOR,
        maxBytes: Number.POSITIVE_INFINITY,
      });
      // macOS's filesystem hands back names in NFD (`ý` as `y` + combining acute) while the
      // markdown Logseq wrote is NFC — the same name, two byte sequences. Key on NFC, look up in
      // NFC, or every asset with a diacritic in its name is "missing".
      paths.set(name.normalize("NFC"), assetMarkdownPath(stored));
      if (!stored.deduped) imported++;
    } catch (err) {
      warnings.push(`assets/${name}: not imported (${errMsg(err)})`);
    }
  }
  return { paths, imported };
}

function rewriteAssetLinks(
  content: string,
  paths: ReadonlyMap<string, string>,
): { text: string; dangling: number } {
  let dangling = 0;
  const text = content.replace(ASSET_LINK_RE, (whole, rawName: string) => {
    let name = rawName;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      // Not percent-encoded after all; use it as written.
    }
    const mapped = paths.get(name.normalize("NFC")) ?? paths.get(rawName.normalize("NFC"));
    if (mapped !== undefined) return `](${mapped})`;
    dangling++;
    return whole;
  });
  return { text, dangling };
}

function rewriteBlockRefs(
  content: string,
  idMap: ReadonlyMap<string, string>,
): { text: string; dangling: number } {
  let dangling = 0;
  const text = content.replace(BLOCK_REF_CANDIDATE_RE, (whole, uuid: string) => {
    const mapped = idMap.get(uuid);
    if (mapped !== undefined) return `((${mapped}))`;
    dangling++;
    return whole;
  });
  return { text, dangling };
}

// -------------------------------------------------------------------------------------------
// Pass 2: tree -> ops
// -------------------------------------------------------------------------------------------

/** Reserved device id for ops the importer authors, distinct from `apply-ops.ts`'s
 *  `SERVER_DEVICE_ID` ("00000000", reserved for corrective ops). Must match `/^[0-9a-z]{8}$/`. */
export const IMPORTER_DEVICE_ID = "1mp0rter";

const IMPORTER_ACTOR = "logseq-import";

/** Ops per `serverApplyOps` call (task step 5: "batch reasonably ... rather than one call for
 *  the whole graph"). We already call once per page; this additionally caps any single huge page
 *  (a big journal, a page with thousands of blocks) so one page can't become one giant
 *  transaction either. */
const CHUNK_SIZE = 500;

function evictUnclaimedReferencePage(
  ctx: ServerContext,
  name: string,
  journalDay: number | null,
): void {
  if (journalDay !== null) return; // journal days are never minted from references
  const holder = unclaimedReferencePageForKey(ctx.driver, normalizePageName(name));
  if (!holder) return;
  serverApplyOps(
    ctx,
    [
      makeOp(ctx.hlc.next(), REFERENCE_DEVICE_ID, holder, {
        kind: "page.delete",
        deletedAt: Date.now(),
      }),
    ],
    { origin: "import", actor: IMPORTER_ACTOR, referencedPages: "skip" },
  );
}

function buildPageOps(
  entry: FileEntry,
  ids: IdAssignment,
  assetPaths: ReadonlyMap<string, string>,
  hlc: ServerContext["hlc"],
  createdAt: number,
): { pageId: string; ops: Op[]; dangling: number; danglingAssets: number } {
  const pageId = newId();
  const ops: Op[] = [];
  let dangling = 0;
  let danglingAssets = 0;

  const pageProperties =
    Object.keys(entry.parsed.properties).length > 0 ? entry.parsed.properties : undefined;
  ops.push(
    makeOp(hlc.next(), IMPORTER_DEVICE_ID, pageId, {
      kind: "page.create",
      name: entry.resolvedName,
      journalDay: entry.journalDay,
      properties: pageProperties,
      createdAt,
    }),
  );

  const addBlock = (node: OutlineNode, parentId: string | null, order: string): void => {
    // biome-ignore lint/style/noNonNullAssertion: every node was assigned an id in pass 1
    const entityId = ids.nodeIds.get(node)!;
    const withAssets = rewriteAssetLinks(node.content, assetPaths);
    danglingAssets += withAssets.dangling;
    const rewritten = rewriteBlockRefs(withAssets.text, ids.idMap);
    dangling += rewritten.dangling;
    const properties = Object.keys(node.properties).length > 0 ? node.properties : undefined;
    ops.push(
      makeOp(hlc.next(), IMPORTER_DEVICE_ID, entityId, {
        kind: "block.create",
        place: { pageId, parentId, order },
        content: rewritten.text,
        marker: node.marker,
        priority: node.priority,
        collapsed: node.collapsed,
        properties,
        createdAt,
      }),
    );
    if (node.children.length === 0) return;
    const childOrders = ordersBetween(null, null, node.children.length);
    node.children.forEach((child, i) => {
      addBlock(child, entityId, childOrders[i] as string);
    });
  };

  const rootOrders = ordersBetween(null, null, entry.parsed.blocks.length);
  entry.parsed.blocks.forEach((node, i) => {
    addBlock(node, null, rootOrders[i] as string);
  });

  return { pageId, ops, dangling, danglingAssets };
}

/** Marks each named page as a favourite the way the app does (`favorite:: true`, a synced page
 *  property; `setPageFavorite` in the web app's store). Names are matched like references are, so
 *  a journal favourite written in any title format finds its ISO-named page. */
function markFavorites(
  ctx: ServerContext,
  names: readonly string[],
  warnings: string[],
): { marked: number; missing: number } {
  let marked = 0;
  let missing = 0;
  const done = new Set<string>();
  for (const name of names) {
    const key = referenceKey(name);
    if (done.has(key)) continue;
    done.add(key);
    const row = ctx.driver.get<{ id: string }>(
      "SELECT id FROM page WHERE key = ? AND deleted_at IS NULL",
      [key],
    );
    if (!row) {
      missing++;
      warnings.push(`favourite "${name}" names a page that was not imported; skipped`);
      continue;
    }
    const res = serverApplyOps(
      ctx,
      [
        makeOp(ctx.hlc.next(), IMPORTER_DEVICE_ID, row.id, {
          kind: "page.prop",
          key: "favorite",
          value: "true",
        }),
      ],
      { origin: "import", actor: IMPORTER_ACTOR, referencedPages: "skip" },
    );
    if (res.results[0]?.status === "applied") marked++;
    else missing++;
  }
  return { marked, missing };
}

function applyChunked(ctx: ServerContext, ops: readonly Op[]): AppliedOpResult[] {
  const results: AppliedOpResult[] = [];
  for (let i = 0; i < ops.length; i += CHUNK_SIZE) {
    const chunk = ops.slice(i, i + CHUNK_SIZE);
    // Minting off: page A's `[[B]]` would create B before B's own file arrives, and B's
    // `page.create` would then collide. `importLogseqGraph` mints what is still missing at the end.
    const res = serverApplyOps(ctx, chunk, {
      origin: "import",
      actor: IMPORTER_ACTOR,
      referencedPages: "skip",
    });
    results.push(...res.results);
  }
  return results;
}

// -------------------------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------------------------

export interface ImportLogseqOptions {
  /** Override individual `config.edn` values (mainly for tests); anything not given still comes
   *  from the graph's own `logseq/config.edn` (or Logseq's documented defaults). */
  config?: Partial<LogseqConfig>;
  /** The nooklet data directory, where `assets/` lives. Without it the graph's `assets/*` are
   *  left behind and every `![](../assets/…)` stays a dead link — reported as a warning. */
  dataDir?: string;
}

export interface ImportStats {
  /** Which kind of Logseq graph was found (`detectLogseqGraph`). */
  format: "file" | "db";
  /** Non-journal pages successfully created (page.create applied). */
  pagesImported: number;
  /** Journal pages successfully created. */
  journalsImported: number;
  /** Pages no file defined, created because the graph references them (ADR 024). */
  referencedPagesCreated: number;
  /** Blocks successfully created, summed across every imported page. */
  blocksImported: number;
  /** Files skipped entirely: a duplicate resolved page name, or a page-level failure (below). */
  pagesSkipped: number;
  /** `((uuid))` occurrences left unrewritten because their target isn't in this graph. */
  danglingBlockRefs: number;
  /** Files copied out of the graph's `assets/` (deduplicated by content). */
  assetsImported: number;
  /** `assets/…` links whose file was not in the graph's `assets/` directory. */
  danglingAssetLinks: number;
  /** Non-fatal notices: duplicate names/ids, unparseable config.edn, unrecognized journal file
   *  names, individual block ops rejected on an otherwise-successful page. */
  warnings: string[];
  /** One entry per page-level failure (an exception while building/applying its ops, or its own
   *  `page.create` op being rejected, e.g. a pre-existing name collision). The rest of the graph
   *  is still imported — see task step 5. */
  errors: string[];
  /** Pages marked favourite (`favorite:: true`) from Logseq's favourites. */
  favoritesMarked: number;
  /** Favourites naming a page the import did not produce. */
  favoritesMissing: number;
  /** DB-version graphs only: what was recovered from `db.sqlite`, and what still is not. */
  logseqDb?: Omit<LogseqDbStats, "favoritePageNames">;
  durationMs: number;
}

/**
 * Import a Logseq graph at `graphDir` into `ctx`'s database: a file graph's folder, or a DB-version
 * graph's root folder (the one holding `db.sqlite`; see `detectLogseqGraph`).
 *
 * HLC/device choice (task step 8): every op is minted with `ctx.hlc.next()` — the same
 * `ServerContext` clock `serverApplyOps` already advances via `receive()` on every call, so
 * there's no separate clock to keep in sync (this mirrors the pattern `apply-ops.test.ts`'s own
 * fixtures use: mint the timestamp from `ctx.hlc`, but stamp the op with whatever device
 * "authored" it) — while `op.device` is stamped with `IMPORTER_DEVICE_ID`, not the server's own
 * `SERVER_DEVICE_ID`, so imported content is attributable to the importer distinctly from
 * server-authored corrective ops.
 */
export async function importLogseqGraph(
  ctx: ServerContext,
  graphDir: string,
  opts: ImportLogseqOptions = {},
): Promise<ImportStats> {
  // A missing graph looked like an empty one (B-110): `listMdFiles` answers `[]` for an absent
  // directory on purpose, since a graph may have no journals/ — but that leniency has to stop at
  // the graph itself, or a mistyped path imports nothing and reports success.
  if (!existsSync(graphDir) || !statSync(graphDir).isDirectory()) {
    throw new Error(`not a directory: ${graphDir}`);
  }
  const start = Date.now();
  const warnings: string[] = [];
  const errors: string[] = [];

  const layout = detectLogseqGraph(graphDir);
  // Read before anything is written, so a database that cannot be read fails the import cleanly.
  const dbGraph = layout.kind === "db" ? LogseqDbGraph.fromFile(layout.sqliteFile) : null;
  const sourceConfig = dbGraph ? dbConfig(dbGraph, warnings) : readConfig(graphDir, warnings);
  const config: LogseqConfig = { ...sourceConfig, ...opts.config };
  // Journal pages are stored under their ISO name now (ADR 018), so the source graph's title
  // format no longer decides anything about storage — but it is the format this person has been
  // reading their dates in for years, and settings can be set to match. Saying so beats leaving
  // them to wonder why every journal suddenly looks different.
  if (config.journalPageTitleFormat !== DEFAULT_JOURNAL_TITLE_FORMAT) {
    setSuggestedJournalTitleFormat(ctx.driver, config.journalPageTitleFormat);
    warnings.push(
      `this graph wrote journal titles as "${config.journalPageTitleFormat}"; pages are stored ` +
        "by ISO date and shown in that same format, changeable under Settings → Journal date format",
    );
  }
  // B-608: Mod+Enter, the slash menu and the checkbox start tasks the way this graph did.
  if (config.preferredWorkflow) setRecordedTaskWorkflow(ctx.driver, config.preferredWorkflow);
  const entries = resolveFileEntries(layout.markdownDir, warnings);
  const ids = assignIds(entries, warnings);

  let assetsImported = 0;
  let assetPaths: Map<string, string> = new Map();
  if (opts.dataDir) {
    const assets = importAssets(ctx, graphDir, opts.dataDir, warnings);
    assetPaths = assets.paths;
    assetsImported = assets.imported;
  } else if (existsSync(join(graphDir, "assets"))) {
    warnings.push(
      "assets/ was not imported: no dataDir was given, so there is nowhere to copy the files",
    );
  }

  let dbStats: LogseqDbStats | undefined;
  if (dbGraph) {
    dbStats = enrichFromLogseqDb(
      dbGraph,
      entries,
      {
        // Emitted as the graph-relative link a file graph would have, so `rewriteAssetLinks`
        // re-points it like any other — one path for every imported asset.
        assetPath: (fileName) =>
          assetPaths.has(fileName.normalize("NFC")) ? `../assets/${fileName}` : undefined,
        nodeId: (node) => ids.nodeIds.get(node),
        journalTitleFormat: config.journalPageTitleFormat,
      },
      warnings,
    );
  }

  let pagesImported = 0;
  let journalsImported = 0;
  let blocksImported = 0;
  let pagesSkipped = 0;
  let danglingBlockRefs = 0;
  let danglingAssetLinks = 0;

  for (const entry of entries) {
    try {
      const createdAt = Math.round(statSync(entry.filePath).mtimeMs);
      // Importing into a graph that already references this name: the empty page the reference
      // made gives way to the file's page (ADR 024). Minted before `buildPageOps` takes its HLCs,
      // so the deletion precedes the create in the log's own order too.
      evictUnclaimedReferencePage(ctx, entry.resolvedName, entry.journalDay);
      const { ops, dangling, danglingAssets } = buildPageOps(
        entry,
        ids,
        assetPaths,
        ctx.hlc,
        createdAt,
      );
      const results = applyChunked(ctx, ops);
      const pageResult = results[0];

      if (!pageResult || pageResult.status === "rejected") {
        errors.push(
          `${entry.relPath}: page "${entry.resolvedName}" not imported (${pageResult?.reason ?? "rejected"})`,
        );
        pagesSkipped++;
        continue;
      }

      const blockResults = results.slice(1);
      const appliedBlocks = blockResults.filter((r) => r.status === "applied").length;
      const rejectedBlocks = blockResults.filter((r) => r.status === "rejected");
      if (rejectedBlocks.length > 0) {
        warnings.push(
          `${entry.relPath}: ${rejectedBlocks.length} block(s) rejected while importing "${entry.resolvedName}" (e.g. ${rejectedBlocks[0]?.reason})`,
        );
      }

      blocksImported += appliedBlocks;
      danglingBlockRefs += dangling;
      danglingAssetLinks += danglingAssets;
      if (entry.isJournal) journalsImported++;
      else pagesImported++;
    } catch (err) {
      errors.push(`${entry.relPath}: ${errMsg(err)}`);
      pagesSkipped++;
    }
  }

  // ADR 024: every name the graph references and no file defined becomes a page, now that every
  // file had its chance to define it.
  const referenced = mintDanglingReferencedPages(ctx);

  const favorites = markFavorites(
    ctx,
    dbStats ? dbStats.favoritePageNames : config.favorites,
    warnings,
  );

  return {
    format: layout.kind,
    pagesImported,
    journalsImported,
    referencedPagesCreated: referenced.created,
    blocksImported,
    pagesSkipped,
    danglingBlockRefs,
    assetsImported,
    danglingAssetLinks,
    warnings,
    errors,
    favoritesMarked: favorites.marked,
    favoritesMissing: favorites.missing,
    ...(dbStats ? { logseqDb: withoutNames(dbStats) } : {}),
    durationMs: Date.now() - start,
  };
}
