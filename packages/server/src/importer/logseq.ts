/**
 * Logseq file-graph importer (M1, ADR 012).
 *
 * Scope is exactly ADR 012's: the classic Logseq file graph (`pages/*.md`, `journals/*.md`,
 * `logseq/config.edn`) — not the Logseq DB version's one-way markdown mirror export (different
 * directory shape, page-level `id::` line, no `config.edn`; see the ADR).
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
 *   3. Two-pass Logseq-uuid -> vrite-id conversion (`assignIds`/`rewriteBlockRefs`) so `((uuid))`
 *      block refs keep resolving after import.
 *   4. Turning each page's tree into `page.create`/`block.create` ops (fractional-index sibling
 *      order via `ordersBetween`) and applying them through `serverApplyOps` — the server's own
 *      ref/path_ref indexing, cycle correction, and `changes` audit trail all run for free.
 *
 * Assets: out of scope for this pass (see the TODO below) — correctness of pages/blocks/
 * properties/refs is what M1 needs; copying `assets/*` into the data directory and creating
 * `asset` rows is a follow-up.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  type AppliedOpResult,
  DEFAULT_JOURNAL_TITLE_FORMAT,
  fileNameToPageName,
  formatJournalTitle,
  journalDayFromFileName,
  makeOp,
  newId,
  normalizePageName,
  type Op,
  type OutlineNode,
  ordersBetween,
  type ParsedPage,
  parseOutline,
} from "@vrite/core";
import { type ServerContext, serverApplyOps } from "../apply-ops.js";

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
}

export const DEFAULT_LOGSEQ_CONFIG: LogseqConfig = {
  journalFileNameFormat: "yyyy_MM_dd",
  journalPageTitleFormat: DEFAULT_JOURNAL_TITLE_FORMAT,
  fileNameFormat: "legacy",
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
  };
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
 *  file's page name, deduplicating by normalized key (first file wins, later ones are skipped
 *  with a warning — ADR 012 §3: "rare, malformed graphs"). */
function resolveFileEntries(
  graphDir: string,
  config: LogseqConfig,
  warnings: string[],
): FileEntry[] {
  const entries: FileEntry[] = [];
  const seenKeys = new Map<string, string>();

  const record = (candidate: Omit<FileEntry, "relPath" | "filePath">, filePath: string): void => {
    const relPath = relative(graphDir, filePath);
    const key = normalizePageName(candidate.resolvedName);
    const firstSeenAt = seenKeys.get(key);
    if (firstSeenAt !== undefined) {
      warnings.push(
        `${relPath}: page name "${candidate.resolvedName}" already imported from ${firstSeenAt}; this file was skipped`,
      );
      return;
    }
    seenKeys.set(key, relPath);
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
    const resolvedName = titleOverride || formatJournalTitle(day, config.journalPageTitleFormat);
    record({ isJournal: true, journalDay: day, parsed, resolvedName }, filePath);
  }

  return entries;
}

// -------------------------------------------------------------------------------------------
// Pass 1: Logseq id (uuid, or occasionally something else) -> vrite id
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
  /** Logseq id (uuid or otherwise) -> fresh vrite id, for every block that carried one. Used
   *  only to rewrite `((id))` references (pass 2); never consulted for a block's own identity. */
  idMap: Map<string, string>;
  /** Every outline node (whether or not it carried a Logseq id) -> the fresh vrite id it will be
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
 *  vrite id (re-importing previously exported content — never matches this pattern) or it's
 *  genuinely dangling (the target block doesn't exist in this graph; Logseq itself accumulates
 *  these over time per `docs/research/01-logseq.md`). */
const BLOCK_REF_CANDIDATE_RE = /\(\(([0-9a-f-]{36})\)\)/g;

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

function buildPageOps(
  entry: FileEntry,
  ids: IdAssignment,
  hlc: ServerContext["hlc"],
  createdAt: number,
): { pageId: string; ops: Op[]; dangling: number } {
  const pageId = newId();
  const ops: Op[] = [];
  let dangling = 0;

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
    const rewritten = rewriteBlockRefs(node.content, ids.idMap);
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

  return { pageId, ops, dangling };
}

function applyChunked(ctx: ServerContext, ops: readonly Op[]): AppliedOpResult[] {
  const results: AppliedOpResult[] = [];
  for (let i = 0; i < ops.length; i += CHUNK_SIZE) {
    const chunk = ops.slice(i, i + CHUNK_SIZE);
    const res = serverApplyOps(ctx, chunk, { origin: "import", actor: IMPORTER_ACTOR });
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
}

export interface ImportStats {
  /** Non-journal pages successfully created (page.create applied). */
  pagesImported: number;
  /** Journal pages successfully created. */
  journalsImported: number;
  /** Blocks successfully created, summed across every imported page. */
  blocksImported: number;
  /** Files skipped entirely: a duplicate resolved page name, or a page-level failure (below). */
  pagesSkipped: number;
  /** `((uuid))` occurrences left unrewritten because their target isn't in this graph. */
  danglingBlockRefs: number;
  /** Non-fatal notices: duplicate names/ids, unparseable config.edn, unrecognized journal file
   *  names, individual block ops rejected on an otherwise-successful page. */
  warnings: string[];
  /** One entry per page-level failure (an exception while building/applying its ops, or its own
   *  `page.create` op being rejected, e.g. a pre-existing name collision). The rest of the graph
   *  is still imported — see task step 5. */
  errors: string[];
  durationMs: number;
}

/**
 * Import a Logseq file graph at `graphDir` into `ctx`'s database.
 *
 * HLC/device choice (task step 8): every op is minted with `ctx.hlc.next()` — the same
 * `ServerContext` clock `serverApplyOps` already advances via `receive()` on every call, so
 * there's no separate clock to keep in sync (this mirrors the pattern `apply-ops.test.ts`'s own
 * fixtures use: mint the timestamp from `ctx.hlc`, but stamp the op with whatever device
 * "authored" it) — while `op.device` is stamped with `IMPORTER_DEVICE_ID`, not the server's own
 * `SERVER_DEVICE_ID`, so imported content is attributable to the importer distinctly from
 * server-authored corrective ops.
 *
 * TODO: asset import (M1 follow-up) — `assets/*` files and `asset` table rows are not created by
 * this pass; only page/block/property/ref correctness is in scope here (task step 7).
 */
export async function importLogseqGraph(
  ctx: ServerContext,
  graphDir: string,
  opts: ImportLogseqOptions = {},
): Promise<ImportStats> {
  const start = Date.now();
  const warnings: string[] = [];
  const errors: string[] = [];

  const config: LogseqConfig = { ...readConfig(graphDir, warnings), ...opts.config };
  const entries = resolveFileEntries(graphDir, config, warnings);
  const ids = assignIds(entries, warnings);

  let pagesImported = 0;
  let journalsImported = 0;
  let blocksImported = 0;
  let pagesSkipped = 0;
  let danglingBlockRefs = 0;

  for (const entry of entries) {
    try {
      const createdAt = Math.round(statSync(entry.filePath).mtimeMs);
      const { ops, dangling } = buildPageOps(entry, ids, ctx.hlc, createdAt);
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
      if (entry.isJournal) journalsImported++;
      else pagesImported++;
    } catch (err) {
      errors.push(`${entry.relPath}: ${errMsg(err)}`);
      pagesSkipped++;
    }
  }

  return {
    pagesImported,
    journalsImported,
    blocksImported,
    pagesSkipped,
    danglingBlockRefs,
    warnings,
    errors,
    durationMs: Date.now() - start,
  };
}
