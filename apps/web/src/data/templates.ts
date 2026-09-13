/**
 * Templates on the client (ADR 019): find them, load one as a `TemplateNode`, and write copies
 * through the normal op path. The pure half (token expansion, subtree → `block.create` ops) is
 * `@nooklet/core`'s `templates.ts`, shared with the server's journal path so both sides produce
 * the same blocks; this file is the part that knows the local replica's tables and clock.
 *
 * A template is any live block with `template:: <name>`; the journal template is the one that
 * also carries `journal-template::` (`JOURNAL_TEMPLATE_PROP`). Both are ordinary properties, so
 * they arrive with an imported Logseq graph, sync like everything else, and an agent can set
 * them with `block_update` — no settings API, no second store. If several blocks claim to be the
 * journal template the oldest wins (ids are time-ordered), on both sides, by the same query.
 */

import {
  countTemplateNodes,
  expandTemplateTokens,
  formatDayTime,
  formatDoneIso,
  isTruthyProp,
  JOURNAL_TEMPLATE_PROP,
  makeOp,
  type Op,
  type OpMinter,
  type OpPayload,
  type Priority,
  type Properties,
  type TaskMarker,
  TEMPLATE_ONLY_PROPS,
  TEMPLATE_PROP,
  type TemplateExpansion,
  type TemplateNode,
  templateNodesOps,
  templateRoots,
  todayJournalDay,
} from "@nooklet/core";
import { queryAs } from "../db/client.js";
import type { Clock } from "../editor/types.js";
import { journalTitleFormat } from "./page-title.js";
import { applyOps, getOpClock } from "./store.js";

export interface TemplateSummary {
  /** The template block's id. */
  id: string;
  /** Its `template::` value, as written. */
  name: string;
  /** Whether this is the journal template. */
  journal: boolean;
}

/** Every live template, name-sorted (case-insensitively), oldest first among namesakes. */
export async function listTemplates(): Promise<TemplateSummary[]> {
  const rows = await queryAs<{ id: string; name: string; journal: string | null }>(
    `SELECT b.id AS id, t.value AS name,
            (SELECT j.value FROM block_prop j WHERE j.block_id = b.id AND j.key = ?) AS journal
     FROM block_prop t
     JOIN block b ON b.id = t.block_id AND b.deleted_at IS NULL
     JOIN page p ON p.id = b.page_id AND p.deleted_at IS NULL
     WHERE t.key = ? AND t.value IS NOT NULL AND t.value != ''
     ORDER BY t.value COLLATE NOCASE, b.id`,
    [JOURNAL_TEMPLATE_PROP, TEMPLATE_PROP],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, journal: isTruthyProp(r.journal) }));
}

/** Case-insensitive lookup by name; the oldest block wins a tie, as in `listTemplates`. */
export async function findTemplateByName(name: string): Promise<TemplateSummary | undefined> {
  const wanted = name.trim().toLowerCase();
  return (await listTemplates()).find((t) => t.name.toLowerCase() === wanted);
}

/** The journal template's block id, or `null` when none is chosen. */
export async function journalTemplateId(): Promise<string | null> {
  const rows = await queryAs<{ id: string; value: string | null }>(
    `SELECT j.block_id AS id, j.value AS value
     FROM block_prop j
     JOIN block b ON b.id = j.block_id AND b.deleted_at IS NULL
     JOIN page p ON p.id = b.page_id AND p.deleted_at IS NULL
     WHERE j.key = ? AND j.value IS NOT NULL
     ORDER BY j.block_id`,
    [JOURNAL_TEMPLATE_PROP],
  );
  return rows.find((r) => isTruthyProp(r.value))?.id ?? null;
}

interface SubtreeRow {
  id: string;
  parent_id: string | null;
  order_key: string;
  content: string;
  marker: string | null;
  priority: string | null;
  collapsed: number;
  scheduled_day: number | null;
  scheduled_time: string | null;
  deadline_day: number | null;
  deadline_time: string | null;
  repeat: string | null;
  done_at: number | null;
}

/**
 * The template block and everything under it as a `TemplateNode`, or `null` if it is gone.
 * Properties come back wire-shaped, the way the server's `blockPropertiesOf` builds them: generic
 * rows plus the scheduling columns reconstituted as strings, so the copy's `block.create` bag says
 * exactly what the original's `block_prop`/columns said.
 */
export async function loadTemplate(rootId: string): Promise<TemplateNode | null> {
  const rows = await queryAs<SubtreeRow>(
    `WITH RECURSIVE sub(id) AS (
       SELECT ?
       UNION ALL
       SELECT b.id FROM block b JOIN sub ON b.parent_id = sub.id WHERE b.deleted_at IS NULL
     )
     SELECT b.id, b.parent_id, b.order_key, b.content, b.marker, b.priority, b.collapsed,
            b.scheduled_day, b.scheduled_time, b.deadline_day, b.deadline_time, b.repeat, b.done_at
     FROM block b JOIN sub ON sub.id = b.id
     WHERE b.deleted_at IS NULL`,
    [rootId],
  );
  const root = rows.find((r) => r.id === rootId);
  if (!root) return null;

  const placeholders = rows.map(() => "?").join(",");
  const propRows = await queryAs<{ block_id: string; key: string; value: string }>(
    `SELECT block_id, key, value FROM block_prop
     WHERE value IS NOT NULL AND block_id IN (${placeholders})`,
    rows.map((r) => r.id),
  );
  const propsById = new Map<string, Properties>();
  for (const p of propRows) {
    const bag = propsById.get(p.block_id) ?? {};
    bag[p.key] = p.value;
    propsById.set(p.block_id, bag);
  }

  const childrenOf = new Map<string, SubtreeRow[]>();
  for (const r of rows) {
    if (r.parent_id === null || r.id === rootId) continue;
    const list = childrenOf.get(r.parent_id) ?? [];
    list.push(r);
    childrenOf.set(r.parent_id, list);
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) =>
      a.order_key < b.order_key ? -1 : a.order_key > b.order_key ? 1 : a.id < b.id ? -1 : 1,
    );
  }

  const build = (r: SubtreeRow): TemplateNode => {
    const properties: Properties = { ...(propsById.get(r.id) ?? {}) };
    if (r.scheduled_day !== null)
      properties.scheduled = formatDayTime(r.scheduled_day, r.scheduled_time);
    if (r.deadline_day !== null)
      properties.deadline = formatDayTime(r.deadline_day, r.deadline_time);
    if (r.repeat !== null) properties.repeat = r.repeat;
    if (r.done_at !== null) properties.done = formatDoneIso(r.done_at);
    return {
      content: r.content,
      marker: r.marker as TaskMarker | null,
      priority: r.priority as Priority | null,
      collapsed: r.collapsed !== 0,
      properties,
      children: (childrenOf.get(r.id) ?? []).map(build),
    };
  };
  return build(root);
}

/** The expansion context for something inserted right now, in the reader's date format. */
function expansionNow(day = todayJournalDay()): TemplateExpansion {
  return { day, dateFormat: journalTitleFormat(), now: new Date() };
}

function minterFor(clock: Clock): OpMinter {
  return (entity: string, payload: OpPayload) =>
    makeOp(clock.next(), clock.device, entity, payload);
}

interface PlaceRow {
  page_id: string;
  parent_id: string | null;
  order_key: string;
}

async function placeOf(blockId: string): Promise<PlaceRow | undefined> {
  const rows = await queryAs<PlaceRow>(
    "SELECT page_id, parent_id, order_key FROM block WHERE id = ? AND deleted_at IS NULL LIMIT 1",
    [blockId],
  );
  return rows[0];
}

/** The order key of the sibling right after `order` under `parentId`, or `null` at the end. */
async function nextSiblingOrder(place: PlaceRow): Promise<string | null> {
  const rows = await queryAs<{ order_key: string }>(
    `SELECT order_key FROM block
     WHERE page_id = ? AND parent_id IS ? AND deleted_at IS NULL AND order_key > ?
     ORDER BY order_key LIMIT 1`,
    [place.page_id, place.parent_id, place.order_key],
  );
  return rows[0]?.order_key ?? null;
}

/** The order key of `parentId`'s first child on `pageId`, or `null` if it has none. */
async function firstChildOrder(pageId: string, parentId: string): Promise<string | null> {
  const rows = await queryAs<{ order_key: string }>(
    `SELECT order_key FROM block
     WHERE page_id = ? AND parent_id = ? AND deleted_at IS NULL
     ORDER BY order_key LIMIT 1`,
    [pageId, parentId],
  );
  return rows[0]?.order_key ?? null;
}

/**
 * The ops that insert a copy of template `templateId` as the next sibling(s) of `blockId`, and the
 * first created top-level block's id (to put the caret in); `undefined` if either block is gone.
 * Minted but NOT applied: the caller commits them through the editor, so the insertion is one
 * step of its undo history (B-108), or applies them itself when no editor shows `blockId`.
 */
export async function templateAfterOps(
  templateId: string,
  blockId: string,
): Promise<{ ops: Op[]; firstId: string } | undefined> {
  const [node, place] = await Promise.all([loadTemplate(templateId), placeOf(blockId)]);
  if (!node || !place) return undefined;
  const roots = templateRoots(node);
  if (roots.length === 0) return undefined;
  const upper = await nextSiblingOrder(place);
  const clock = await getOpClock(countTemplateNodes(roots));
  const { ops, roots: created } = templateNodesOps(
    roots,
    { pageId: place.page_id, parentId: place.parent_id, lower: place.order_key, upper },
    expansionNow(),
    minterFor(clock),
  );
  const firstId = created[0]?.id;
  return firstId ? { ops, firstId } : undefined;
}

/**
 * The ops that put template `templateId` INTO `blockId`, an empty bullet the person is editing:
 * the first inserted node's expanded text, marker, priority, collapsed state and properties are
 * written onto that block, its children are created beneath it, and any further top-level nodes
 * follow as siblings. `undefined` if either block is gone. Minted but NOT applied, as above.
 *
 * The text is a `block.text` op in the same batch. It used to be written apart, through
 * `EditorHost.replaceRange`, because an op written beside the editor's open buffer is flushed
 * over; the batch is now committed BY that editor (`EditorHost.commitOps`), which syncs its buffer
 * to what it commits — and one batch is what makes one undo step.
 */
export async function templateIntoBlockOps(
  templateId: string,
  blockId: string,
): Promise<{ ops: Op[] } | undefined> {
  const [node, place] = await Promise.all([loadTemplate(templateId), placeOf(blockId)]);
  if (!node || !place) return undefined;
  const [first, ...rest] = templateRoots(node);
  if (!first) return undefined;
  const [childUpper, restUpper] = await Promise.all([
    firstChildOrder(place.page_id, blockId),
    nextSiblingOrder(place),
  ]);
  const expansion = expansionNow();
  const content = expandTemplateTokens(first.content, expansion);
  const props = Object.entries(first.properties).filter(([k]) => !TEMPLATE_ONLY_PROPS.has(k));
  const fieldOps =
    (first.marker ? 1 : 0) + (first.priority ? 1 : 0) + (first.collapsed ? 1 : 0) + props.length;
  // +1: the `block.text` op.
  const clock = await getOpClock(
    1 + fieldOps + countTemplateNodes(first.children) + countTemplateNodes(rest),
  );
  const mint = minterFor(clock);

  const ops: Op[] = [];
  if (first.marker)
    ops.push(mint(blockId, { kind: "block.prop", key: "marker", value: first.marker }));
  if (first.priority)
    ops.push(mint(blockId, { kind: "block.prop", key: "priority", value: first.priority }));
  if (first.collapsed)
    ops.push(mint(blockId, { kind: "block.prop", key: "collapsed", value: "true" }));
  for (const [key, value] of props) ops.push(mint(blockId, { kind: "block.prop", key, value }));
  ops.push(
    ...templateNodesOps(
      first.children,
      { pageId: place.page_id, parentId: blockId, lower: null, upper: childUpper },
      expansion,
      mint,
    ).ops,
  );
  ops.push(
    ...templateNodesOps(
      rest,
      {
        pageId: place.page_id,
        parentId: place.parent_id,
        lower: place.order_key,
        upper: restUpper,
      },
      expansion,
      mint,
    ).ops,
  );
  ops.push(mint(blockId, { kind: "block.text", content }));
  return { ops };
}

/**
 * The chosen journal template, loaded once, with the number of `block.create` ops inserting it
 * will mint — so a caller can size its HLC pool (`getOpClock`) from the very node it is about to
 * copy. `null` when no journal template is chosen.
 */
export async function loadJournalTemplate(): Promise<{
  node: TemplateNode;
  count: number;
} | null> {
  const id = await journalTemplateId();
  const node = id ? await loadTemplate(id) : null;
  return node ? { node, count: countTemplateNodes(templateRoots(node)) } : null;
}

/**
 * The ops that start a NEW journal page `pageId` for `day` with journal template `node`, and the
 * order key of the last top-level block they create — so the caller (`VirtualJournalDay`) can
 * place what the person typed after it. `mint` is the caller's, so page and template land in one
 * `applyOps` batch. `<% today %>` here is the journal's own day.
 */
export function journalTemplateOpsFor(
  node: TemplateNode,
  pageId: string,
  day: number,
  mint: OpMinter,
): { ops: Op[]; lastOrder: string | null } {
  const { ops, roots } = templateNodesOps(
    templateRoots(node),
    { pageId, parentId: null, lower: null, upper: null },
    expansionNow(day),
    mint,
  );
  return { ops, lastOrder: roots[roots.length - 1]?.order ?? null };
}

/**
 * Choose the journal template (`null` clears it). Writes `journal-template` on the chosen block
 * and clears it wherever else it was set, in one batch — the property is the setting, so this is
 * the settings panel's whole "save".
 */
export async function setJournalTemplate(templateId: string | null): Promise<void> {
  const holders = await queryAs<{ id: string; value: string | null }>(
    "SELECT block_id AS id, value FROM block_prop WHERE key = ? AND value IS NOT NULL",
    [JOURNAL_TEMPLATE_PROP],
  );
  const toClear = holders.filter((h) => h.id !== templateId && isTruthyProp(h.value));
  const alreadySet = holders.some((h) => h.id === templateId && isTruthyProp(h.value));
  const ops: Array<{ id: string; value: string | null }> = toClear.map((h) => ({
    id: h.id,
    value: null,
  }));
  if (templateId && !alreadySet) ops.push({ id: templateId, value: "true" });
  if (ops.length === 0) return;
  const clock = await getOpClock(ops.length);
  const mint = minterFor(clock);
  await applyOps(
    ops.map((o) => mint(o.id, { kind: "block.prop", key: JOURNAL_TEMPLATE_PROP, value: o.value })),
  );
}
