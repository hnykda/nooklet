/**
 * What the Logseq DB version's markdown mirror loses, put back from its `db.sqlite` (B-715).
 *
 * The importer reads a DB graph's pages from `mirror/markdown/` like any file graph. This module
 * then walks the same parsed trees next to the database (`LogseqDbGraph`) and repairs them in
 * place, before any op is built:
 *
 *  - `[[<uuid>]]` in text. The mirror resolves a page ref to the page's title but leaves a ref to
 *    anything that is not a page as its raw uuid (`recur-replace-uuid-in-block-title` with
 *    `replace-block-refs? false`, Logseq `deps/db/src/logseq/db/frontend/content.cljs`). A pasted
 *    image is such a ref to an asset entity, so it arrives as `[[0193…]]` and would otherwise mint a
 *    page named after a uuid. Asset → an image (or file) link to the imported copy; page → its
 *    name; block → `((id))` when the block was identified (below).
 *  - Asset blocks placed in the outline. Their mirror line is only the asset's title (often a
 *    timestamp), no link and no `id::`. Identified by position (below), never by text alone.
 *  - `SCHEDULED`, which the mirror drops entirely; put back as `scheduled::` on identified blocks.
 *  - Favourites, which live on the hidden `$$$favorites` page; returned for the caller to apply.
 *
 * Identity, not text: each mirror page is matched to its database page (journal day, else exact
 * normalised title), and then the two trees are aligned level by level. The mirror writes a page's
 * blocks in `:block/order` without property-derived blocks (`outline-children`, Logseq
 * `src/main/frontend/worker/markdown_mirror.cljs`), which `LogseqDbGraph.outlineChildren`
 * reproduces; a sibling list is paired only when its lengths agree and every pair passes a loose
 * text check, otherwise that subtree is left unidentified. An asset line on an unidentified subtree
 * falls back to its title, and only when that title occurs exactly once on the page on both sides;
 * every other case is counted as ambiguous and left as text.
 */

import {
  isoJournalName,
  JOURNAL_TITLE_FORMATS,
  normalizePageName,
  type OutlineNode,
  type ParsedPage,
  parseJournalTitle,
  setImageMeta,
} from "@nooklet/core";
import { LOGSEQ_DB_ATTRS as A, type LogseqDbAsset, type LogseqDbGraph } from "./logseq-db.js";

export interface DbImportEntry {
  relPath: string;
  isJournal: boolean;
  journalDay: number | null;
  resolvedName: string;
  parsed: ParsedPage;
}

export interface LogseqDbStats {
  /** Asset entities in the database. */
  assetEntities: number;
  /** Asset entities whose `assets/<uuid>.<ext>` file was not in the graph (or not imported). */
  assetFilesMissing: number;
  /** `[[asset uuid]]` refs in mirror text turned into image/file links. */
  assetRefsResolved: number;
  /** Asset blocks' title lines turned into image/file links (identified by position or a unique
   *  title). */
  assetLinesResolved: number;
  /** Asset blocks whose title line could not be pinned to one mirror line; left as text. */
  assetLinesAmbiguous: number;
  /** Asset blocks placed in a page's outline whose line was not found in the mirror at all. */
  assetLinesUnresolved: number;
  /** `[[page uuid]]` refs turned into `[[page name]]`. */
  pageUuidRefsResolved: number;
  /** `[[block uuid]]` refs turned into `((id))`. */
  blockUuidRefsResolved: number;
  /** `[[uuid]]` refs left as written: target not identified in the mirror, or not in the DB. */
  uuidRefsUnresolved: number;
  /** Mirror pages matched to a database page / not matched. */
  pagesMatched: number;
  pagesUnmatched: number;
  /** Database blocks identified with a mirror line / left unidentified (on matched pages). */
  blocksAligned: number;
  blocksUnaligned: number;
  /** `* Title:: value` property list items folded back into their block's or page's properties. */
  propertyItemsFolded: number;
  /** Property list items whose value is a block tree, kept as written (see step 0). */
  propertyValueBlocksKept: number;
  /** Values of user-defined properties (`:user.property/*`) in the database, for comparison with
   *  the two counts above (the mirror writes one list item per property, not per value). */
  userPropertyValuesInDb: number;
  /** `scheduled::`/`deadline::` put back from the database (the mirror drops both). */
  datesRestored: number;
  /** Things the mirror loses that are not restored yet, counted so they are visible. */
  notRestored: {
    /** `:logseq.property/deadline` values (the mirror drops DEADLINE too). */
    deadlinesOnUnidentifiedBlocks: number;
    scheduledOnUnidentifiedBlocks: number;
    /** Whiteboard pages (`:logseq.class/Whiteboard`); the mirror does not write them. */
    whiteboards: number;
  };
  /** Favourite page names, in Logseq's sidebar order, for the caller to mark. */
  favoritePageNames: string[];
}

const IMAGE_TYPES = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico"]);

/** `[[uuid]]` (also `![[uuid]]`, which the mirror does not write but a hand edit might). */
const UUID_REF_RE = /!?\[\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]\]/g;

function assetLink(asset: LogseqDbAsset, path: string): string {
  // `]` in a title would end the label early; the title is a label, nothing depends on it.
  const label = asset.title.replace(/[[\]]/g, "");
  if (!IMAGE_TYPES.has(asset.type.toLowerCase())) return `[${label}](${path})`;
  const link = `![${label}](${path})`;
  // ADR 034: the DB keeps the size and alignment on the asset; nooklet keeps them where a Logseq
  // file graph keeps the size, in the `{:width …}` map after the image.
  return setImageMeta(link, link.length, {
    ...(asset.width !== null ? { width: asset.width } : {}),
    ...(asset.align !== null ? { align: asset.align } : {}),
  });
}

/** Letters and digits only, case-folded: what survives every rewrite the mirror makes. */
function letters(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** The text a mirror line must contain for a pairing to count: the DB title's first line up to
 *  its first ref or tag. The mirror rewrites `[[uuid]]` to a page title and adds tags, so nothing
 *  after the first of those can be compared. */
function fingerprint(s: string): string {
  const first = s.split("\n", 1)[0] ?? "";
  const cut = first.search(/\[\[|\(\(|#/);
  return letters(cut === -1 ? first : first.slice(0, cut)).slice(0, 24);
}

function nodeText(node: OutlineNode): string {
  return letters(node.content);
}

function* eachNode(nodes: readonly OutlineNode[]): Generator<OutlineNode> {
  for (const node of nodes) {
    yield node;
    yield* eachNode(node.children);
  }
}

/** DB `:logseq.property/scheduled` is epoch milliseconds (`:datetime`); nooklet's value is ADR
 *  011's `YYYY-MM-DD[ HH:MM]`, in local time like the rest of the importer's dates. */
function datetimeValue(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return d.getHours() === 0 && d.getMinutes() === 0
    ? date
    : `${date} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** `Sep 20th, 2026 10:00` (the graph's journal title format, then a time) → `2026-09-20 10:00`;
 *  anything unrecognised is returned unchanged. Step 4 overwrites identified blocks' dates from
 *  the database anyway; this is for the ones alignment could not reach. */
function isoDateWith(formats: readonly string[]) {
  return (value: string): string => {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value;
    const m = /^(.*?)(?:\s+(\d{1,2}):(\d{2}))?$/.exec(value.trim());
    const day = m ? parseJournalTitle(m[1] as string, formats) : null;
    if (day === null || !m) return value;
    return m[2] ? `${isoJournalName(day)} ${m[2].padStart(2, "0")}:${m[3]}` : isoJournalName(day);
  };
}

export function enrichFromLogseqDb(
  g: LogseqDbGraph,
  entries: readonly DbImportEntry[],
  opts: {
    /** Markdown path of an imported asset file (`assets/<id>.<ext>`), by its original file name. */
    assetPath: (fileName: string) => string | undefined;
    /** The nooklet id a mirror node will be created with. */
    nodeId: (node: OutlineNode) => string | undefined;
    /** The graph's `:journal/page-title-format`, which the mirror writes dates in. */
    journalTitleFormat?: string;
  },
  warnings: string[],
): LogseqDbStats {
  const stats: LogseqDbStats = {
    assetEntities: 0,
    assetFilesMissing: 0,
    assetRefsResolved: 0,
    assetLinesResolved: 0,
    assetLinesAmbiguous: 0,
    assetLinesUnresolved: 0,
    pageUuidRefsResolved: 0,
    blockUuidRefsResolved: 0,
    uuidRefsUnresolved: 0,
    pagesMatched: 0,
    pagesUnmatched: 0,
    blocksAligned: 0,
    blocksUnaligned: 0,
    propertyItemsFolded: 0,
    propertyValueBlocksKept: 0,
    userPropertyValuesInDb: 0,
    datesRestored: 0,
    notRestored: {
      deadlinesOnUnidentifiedBlocks: 0,
      scheduledOnUnidentifiedBlocks: 0,
      whiteboards: 0,
    },
    favoritePageNames: [],
  };

  const isoDate = isoDateWith(
    opts.journalTitleFormat
      ? [opts.journalTitleFormat, ...JOURNAL_TITLE_FORMATS]
      : JOURNAL_TITLE_FORMATS,
  );
  const pages = g.pages();
  const pageName = (eid: number): string | undefined => {
    const p = pageByEid.get(eid);
    if (!p) return undefined;
    return p.journalDay !== null ? isoJournalName(p.journalDay) : p.title;
  };
  const pageByEid = new Map(pages.map((p) => [p.eid, p]));
  const byDay = new Map<number, number[]>();
  const byName = new Map<string, number[]>();
  for (const p of pages) {
    if (p.builtIn || p.hidden) continue;
    if (p.journalDay !== null) {
      byDay.set(p.journalDay, [...(byDay.get(p.journalDay) ?? []), p.eid]);
    } else {
      const k = normalizePageName(p.title);
      byName.set(k, [...(byName.get(k) ?? []), p.eid]);
    }
  }

  const assets = g.assets();
  stats.assetEntities = assets.length;
  const assetByUuid = new Map(assets.map((a) => [a.uuid, a]));
  const assetByEid = new Map(assets.map((a) => [a.eid, a]));
  const assetPathOf = new Map<string, string>();
  for (const a of assets) {
    const path = opts.assetPath(a.fileName);
    if (path) assetPathOf.set(a.uuid, path);
    else stats.assetFilesMissing++;
  }

  // ---- 0. Properties written as list items -------------------------------------------------
  // The mirror writes a block's (and a page's) properties as `* Title:: value` list items under it
  // (`property-line-content` with `:export-properties-as-list-items? true`, Logseq
  // `src/main/logseq/common/export/file.cljs`), which parse as empty bullets that carry one
  // property. Folded back into the owner's properties, they are properties again rather than
  // stray empty blocks. A `:default`-typed value is written as nested blocks under an empty
  // `* Title::` line; that one has no single-string value, so it stays as written and is only
  // stepped over when aligning.
  const propertyItems = new Set<OutlineNode>();
  const isPropertyItem = (n: OutlineNode): boolean =>
    n.content.trim() === "" &&
    n.marker === null &&
    n.id === undefined &&
    Object.keys(n.properties).length > 0;
  const foldProperties = (
    owner: { properties: OutlineNode["properties"] },
    kids: OutlineNode[],
  ) => {
    const kept: OutlineNode[] = [];
    for (const kid of kids) {
      if (isPropertyItem(kid) && kid.children.length === 0) {
        const fresh = Object.entries(kid.properties)
          .filter(([k]) => !(k in owner.properties))
          .map(([k, v]) => [k, k === "scheduled" || k === "deadline" ? isoDate(v) : v] as const);
        if (fresh.length === Object.keys(kid.properties).length) {
          owner.properties = { ...owner.properties, ...Object.fromEntries(fresh) };
          stats.propertyItemsFolded++;
          continue;
        }
      }
      if (isPropertyItem(kid)) {
        propertyItems.add(kid);
        stats.propertyValueBlocksKept++;
      }
      kept.push(kid);
      kid.children = foldProperties(kid, kid.children);
    }
    return kept;
  };
  for (const entry of entries) {
    entry.parsed.blocks = foldProperties(entry.parsed, entry.parsed.blocks);
  }

  // ---- 1. Align each mirror page with its database page ------------------------------------
  const nodeOfEid = new Map<number, OutlineNode>();
  /** Asset blocks on matched pages that alignment did not reach, with the page they belong to. */
  const unalignedAssets: Array<{ asset: LogseqDbAsset; entry: DbImportEntry; dbPages: number[] }> =
    [];

  const subtreeEids = (eid: number): number[] => [eid, ...g.pageBlocksInOrder(eid)];

  /** Pair `dbKids` with `nodes` level by level; collects into `pairs`/`unaligned`, mutates
   *  nothing else, so a failed attempt can simply be thrown away. */
  const align = (
    dbKids: readonly number[],
    allNodes: readonly OutlineNode[],
    pairs: Map<number, OutlineNode>,
    unaligned: number[],
  ): void => {
    const nodes = allNodes.filter((n) => !propertyItems.has(n));
    const pairable =
      dbKids.length === nodes.length &&
      dbKids.every((eid, i) => {
        const node = nodes[i] as OutlineNode;
        const asset = assetByEid.get(eid);
        if (asset) return node.content.trim() === asset.title.trim();
        const want = fingerprint(g.title(eid) ?? "");
        // A block whose title is all refs/punctuation has nothing to compare; accept it — its
        // siblings still have to agree.
        return want === "" || nodeText(node).includes(want);
      });
    if (!pairable) {
      for (const eid of dbKids) unaligned.push(...subtreeEids(eid));
      return;
    }
    dbKids.forEach((eid, i) => {
      const node = nodes[i] as OutlineNode;
      pairs.set(eid, node);
      align(g.outlineChildren(eid), node.children, pairs, unaligned);
    });
  };

  const candidatesFor = (entry: DbImportEntry): number[] =>
    entry.isJournal && entry.journalDay !== null
      ? (byDay.get(entry.journalDay) ?? [])
      : (byName.get(normalizePageName(entry.resolvedName)) ?? []);

  for (const entry of entries) {
    const candidates = candidatesFor(entry);
    if (candidates.length === 0) {
      stats.pagesUnmatched++;
      continue;
    }
    stats.pagesMatched++;
    // The same day can exist twice in the database; B-711 merged the files, so try the pages'
    // outlines concatenated in either order and keep the attempt that lines up best.
    const orders = candidates.length === 2 ? [candidates, [...candidates].reverse()] : [candidates];
    let best: { pairs: Map<number, OutlineNode>; unaligned: number[] } | null = null;
    for (const order of orders) {
      const attempt = { pairs: new Map<number, OutlineNode>(), unaligned: [] as number[] };
      align(
        order.flatMap((p) => g.outlineChildren(p)),
        entry.parsed.blocks,
        attempt.pairs,
        attempt.unaligned,
      );
      if (!best || attempt.unaligned.length < best.unaligned.length) best = attempt;
      if (attempt.unaligned.length === 0) break;
    }
    if (!best) continue;
    for (const [eid, node] of best.pairs) nodeOfEid.set(eid, node);
    stats.blocksAligned += best.pairs.size;
    stats.blocksUnaligned += best.unaligned.length;
    for (const eid of best.unaligned) {
      const asset = assetByEid.get(eid);
      if (asset) unalignedAssets.push({ asset, entry, dbPages: candidates });
    }
  }

  // ---- 2. Asset blocks placed in an outline ------------------------------------------------
  const placeAsset = (asset: LogseqDbAsset, node: OutlineNode): boolean => {
    const path = assetPathOf.get(asset.uuid);
    if (!path) return false;
    node.content = assetLink(asset, path);
    stats.assetLinesResolved++;
    return true;
  };
  for (const [eid, node] of nodeOfEid) {
    const asset = assetByEid.get(eid);
    if (asset) placeAsset(asset, node);
  }
  for (const { asset, entry, dbPages } of unalignedAssets) {
    const title = asset.title.trim();
    const lines = [...eachNode(entry.parsed.blocks)].filter((n) => n.content.trim() === title);
    const dbSame = dbPages
      .flatMap((p) => g.pageBlocksInOrder(p))
      .filter((e) => (g.title(e) ?? "").trim() === title);
    if (lines.length === 1 && dbSame.length === 1 && placeAsset(asset, lines[0] as OutlineNode)) {
      continue;
    }
    if (lines.length === 0) {
      stats.assetLinesUnresolved++;
      warnings.push(`${entry.relPath}: an image/file block was not found in the mirror; left out`);
    } else {
      stats.assetLinesAmbiguous++;
      warnings.push(
        `${entry.relPath}: an image/file block's title matches ${lines.length} line(s) in the mirror and ${dbSame.length} block(s) in the database; left as text`,
      );
    }
  }
  // Asset blocks on a page with no mirror page at all.
  const matchedPages = new Set(entries.flatMap(candidatesFor));
  for (const a of assets) {
    if (a.pageEid === null) continue;
    const page = pageByEid.get(a.pageEid);
    if (!page || page.builtIn || page.hidden) continue; // the Asset class page: refs, not lines
    if (!matchedPages.has(a.pageEid)) stats.assetLinesUnresolved++;
  }

  // ---- 3. `[[uuid]]` refs ------------------------------------------------------------------
  const entryOfPage = new Map<number, DbImportEntry>();
  for (const entry of entries) for (const p of candidatesFor(entry)) entryOfPage.set(p, entry);
  /** A block alignment did not reach, found by its text instead — only when exactly one line on
   *  its page contains its fingerprint and exactly one block there has that fingerprint. */
  const uniqueLineFor = (eid: number): OutlineNode | undefined => {
    const pageEid = g.refs(eid, A.page)[0];
    const entry = pageEid === undefined ? undefined : entryOfPage.get(pageEid);
    const want = fingerprint(g.title(eid) ?? "");
    if (!entry || pageEid === undefined || want.length < 8) return undefined;
    const lines = [...eachNode(entry.parsed.blocks)].filter((n) => nodeText(n).includes(want));
    const blocks = g
      .pageBlocksInOrder(pageEid)
      .filter((e) => fingerprint(g.title(e) ?? "") === want);
    return lines.length === 1 && blocks.length === 1 ? lines[0] : undefined;
  };
  for (const entry of entries) {
    for (const node of eachNode(entry.parsed.blocks)) {
      if (!node.content.includes("[[")) continue;
      node.content = node.content.replace(UUID_REF_RE, (whole, uuid: string) => {
        const asset = assetByUuid.get(uuid);
        if (asset) {
          const path = assetPathOf.get(uuid);
          if (path) {
            stats.assetRefsResolved++;
            return assetLink(asset, path);
          }
          // The file is gone from assets/: keep the name, not a uuid that would become a page.
          stats.uuidRefsUnresolved++;
          return asset.title || whole;
        }
        const eid = g.byUuid(uuid);
        if (eid === undefined) {
          stats.uuidRefsUnresolved++;
          return whole;
        }
        const name = pageName(eid);
        if (name !== undefined) {
          stats.pageUuidRefsResolved++;
          return `[[${name}]]`;
        }
        const target = nodeOfEid.get(eid) ?? uniqueLineFor(eid);
        const id = target && opts.nodeId(target);
        if (id) {
          stats.blockUuidRefsResolved++;
          return `((${id}))`;
        }
        // Left as `[[uuid]]` it would mint a page named after a uuid; as a block ref it is an
        // honest dangling ref, counted by the importer like any other.
        stats.uuidRefsUnresolved++;
        return `((${uuid}))`;
      });
    }
  }

  // ---- 4. SCHEDULED/DEADLINE, and counts of what is still lost -----------------------------
  // The mirror writes them as `* Scheduled:: <the graph's date format> HH:MM` property items
  // (folded in step 0), which is not ADR 011's `YYYY-MM-DD[ HH:MM]`; the database's epoch value is
  // the truth, so on an identified block it replaces whatever the mirror wrote.
  for (const [eid, ent] of g.entities) {
    const node = nodeOfEid.get(eid);
    for (const [attr, key] of [
      [A.scheduled, "scheduled"],
      [A.deadline, "deadline"],
    ] as const) {
      const v = ent.get(attr);
      if (typeof v !== "number") continue;
      if (node) {
        node.properties = { ...node.properties, [key]: datetimeValue(v) };
        stats.datesRestored++;
      } else if (key === "scheduled") stats.notRestored.scheduledOnUnidentifiedBlocks++;
      else stats.notRestored.deadlinesOnUnidentifiedBlocks++;
    }
    for (const [k, v] of ent) {
      if (k.startsWith("user.property/")) {
        stats.userPropertyValuesInDb += Array.isArray(v) ? v.length : 1;
      }
    }
  }
  stats.notRestored.whiteboards = pages.filter((p) =>
    p.tags.includes("logseq.class/Whiteboard"),
  ).length;

  // ---- 5. Favourites -----------------------------------------------------------------------
  stats.favoritePageNames = g
    .favoritePages()
    .map((p) => (p.journalDay !== null ? isoJournalName(p.journalDay) : p.title));

  return stats;
}
