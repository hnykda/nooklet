/**
 * Templates (ADR 019). A block carrying `template:: <name>` is a template; inserting it copies
 * the block's subtree with fresh ids, drops the properties that only describe the template, and
 * expands `<% today %>`-style tokens on the way in. Nothing here is persisted or looked up — this
 * is the pure half, shared so a template lands identically whichever side minted the ops:
 *
 * - the client inserts at the caret (`apps/web/src/data/templates.ts`) and into a journal day it
 *   creates on the first keystroke (`views/VirtualJournalDay.tsx`);
 * - the server inserts into a journal day it creates for an API caller (`data-api.ts#journal`).
 *
 * Both hosts find the template through the same two properties. `template` names it;
 * `journal-template` (any value but `""`/`"false"`) marks the one template every new journal day
 * starts with — a fact about the graph, stored in the graph like `favorite::` is, so it syncs and
 * an agent can set it with `block_update`. `template-including-parent:: false` is Logseq's own
 * switch for "insert the children, not the block itself", honoured so an imported graph's
 * templates keep behaving.
 */

import { newId } from "./ids.js";
import { dateToJournalDay, formatJournalTitle, journalDayToDate } from "./journal.js";
import type { Priority, Properties, TaskMarker } from "./model.js";
import type { Op, OpPayload } from "./ops.js";
import { ordersBetween } from "./order.js";

export const TEMPLATE_PROP = "template";
export const JOURNAL_TEMPLATE_PROP = "journal-template";
export const TEMPLATE_INCLUDING_PARENT_PROP = "template-including-parent";

/** Properties that describe the template and never belong to a copy. Stripped from every copied
 * node, not just the root, so a template nested in a template does not register a duplicate
 * template name on every insertion. */
export const TEMPLATE_ONLY_PROPS: ReadonlySet<string> = new Set([
  TEMPLATE_PROP,
  JOURNAL_TEMPLATE_PROP,
  TEMPLATE_INCLUDING_PARENT_PROP,
]);

/** The wire convention for a boolean-ish property (`useFavoritePages`, `collapsed`): present and
 * not `false` means on. */
export function isTruthyProp(value: string | null | undefined): boolean {
  return value !== undefined && value !== null && value !== "" && value.toLowerCase() !== "false";
}

/** One node of a template, host-agnostic: what `blocks.tree()` gives the server and what the
 * client rebuilds from `block` + `block_prop` rows. `properties` is wire-shaped — generic
 * `key:: value` pairs plus `scheduled`/`deadline`/`repeat`/`done` as the strings the reducer
 * accepts in a `block.create` bag. */
export interface TemplateNode {
  content: string;
  marker: TaskMarker | null;
  priority: Priority | null;
  collapsed: boolean;
  properties: Properties;
  children: TemplateNode[];
}

export interface TemplateExpansion {
  /** The day `<% today %>` names: a journal template gets the journal's own day (an API call can
   * create tomorrow's page today, and "today" in that page means that page's day), `/template`
   * gets the calendar day. */
  day: number;
  /** date-fns pattern the date tokens are written in. The client passes the reader's display
   * format (ADR 018) so the inserted text matches what `/today` would type; the server has no
   * reader and passes the graph's suggested format, or the default. Any of them resolves, because
   * reference keys canonicalise (ADR 018). */
  dateFormat: string;
  /** Wall clock for `<% time %>`. */
  now: Date;
  /** `<% current page %>`, when the host knows it. */
  pageName?: string;
}

const TOKEN_RE = /<%\s*([^%>]*?)\s*%>/g;

function shiftDay(day: number, delta: number): number {
  const d = journalDayToDate(day);
  d.setDate(d.getDate() + delta);
  return dateToJournalDay(d);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Expand Logseq's dynamic tokens. Dates become `[[links]]` in `dateFormat`; `time` is the wall
 * clock as `HH:mm`. A token this does not know stays in the text as written — visible, so the
 * person sees what was not understood — rather than vanishing. Logseq additionally accepts
 * natural-language dates (`<% next friday %>`); those are deliberately not implemented.
 */
export function expandTemplateTokens(text: string, ctx: TemplateExpansion): string {
  return text.replace(TOKEN_RE, (whole: string, raw: string) => {
    const name = raw.toLowerCase().replace(/\s+/g, " ");
    switch (name) {
      case "today":
        return `[[${formatJournalTitle(ctx.day, ctx.dateFormat)}]]`;
      case "yesterday":
        return `[[${formatJournalTitle(shiftDay(ctx.day, -1), ctx.dateFormat)}]]`;
      case "tomorrow":
        return `[[${formatJournalTitle(shiftDay(ctx.day, 1), ctx.dateFormat)}]]`;
      case "time":
        return `${pad2(ctx.now.getHours())}:${pad2(ctx.now.getMinutes())}`;
      case "current page":
        return ctx.pageName ? `[[${ctx.pageName}]]` : "";
      default:
        return whole;
    }
  });
}

/** The nodes an insertion actually places: the template block itself, or only its children when
 * it says `template-including-parent:: false` — always unfolded.
 *
 * A template is folded in the library to keep the library tidy, not so that every copy arrives
 * folded: the owner's imported "Meeting" template (`collapsed:: true`) inserted as one empty bullet
 * with Objectives / Agenda / Notes hidden beneath it (B-265). Only the top-level nodes are
 * unfolded — a fold further down is part of the template's shape. Every insertion path goes
 * through here (`templateInsertOps`, the client's caret and journal-day inserts), which is why
 * the rule lives here rather than in `templateNodesOps`. Not verified: what Logseq itself does. */
export function templateRoots(root: TemplateNode): TemplateNode[] {
  const roots =
    isTruthyProp(root.properties[TEMPLATE_INCLUDING_PARENT_PROP]) ||
    root.properties[TEMPLATE_INCLUDING_PARENT_PROP] === undefined
      ? [root]
      : root.children;
  return roots.map((node) => (node.collapsed ? { ...node, collapsed: false } : node));
}

/** A copy of `properties` without the template-only keys. */
export function copiedProperties(properties: Properties): Properties {
  const out: Properties = {};
  for (const [k, v] of Object.entries(properties)) if (!TEMPLATE_ONLY_PROPS.has(k)) out[k] = v;
  return out;
}

/** Where a run of new sibling blocks goes: between `lower` and `upper` (exclusive, either open)
 * under `parentId` on `pageId`. Same shape as the server's `OrderBounds`. */
export interface TemplateTarget {
  pageId: string;
  parentId: string | null;
  lower: string | null;
  upper: string | null;
}

/** Builds one op from an entity id and a payload. The caller owns the clock — the server's
 * `mint`, the client's `getOpClock` — so this module never touches an HLC. */
export type OpMinter = (entity: string, payload: OpPayload) => Op;

export interface TemplateInsertResult {
  ops: Op[];
  /** The top-level blocks created, in order, so a caller can focus the first or append after the
   * last. */
  roots: Array<{ id: string; order: string }>;
}

/** Count every node in `nodes` and below — how many `block.create` ops `templateNodesOps` will
 * mint, for a caller that pre-fetches HLCs. */
export function countTemplateNodes(nodes: readonly TemplateNode[]): number {
  let n = 0;
  for (const node of nodes) n += 1 + countTemplateNodes(node.children);
  return n;
}

/**
 * Fresh `block.create` ops for `nodes` placed at `target`, their subtrees nested beneath them.
 * Every copied block gets a new id (a template's ids stay the template's — R32's rule for
 * duplicate applies here for the same reason), tokens are expanded in every node's content, and
 * template-only properties are dropped from every node.
 */
export function templateNodesOps(
  nodes: readonly TemplateNode[],
  target: TemplateTarget,
  expansion: TemplateExpansion,
  mint: OpMinter,
  now: number = Date.now(),
): TemplateInsertResult {
  const ops: Op[] = [];
  const roots: Array<{ id: string; order: string }> = [];

  const visit = (
    siblings: readonly TemplateNode[],
    parentId: string | null,
    lower: string | null,
    upper: string | null,
    top: boolean,
  ): void => {
    const orders = ordersBetween(lower, upper, siblings.length);
    siblings.forEach((node, i) => {
      const id = newId(now);
      const order = orders[i] as string;
      const properties = copiedProperties(node.properties);
      ops.push(
        mint(id, {
          kind: "block.create",
          place: { pageId: target.pageId, parentId, order },
          content: expandTemplateTokens(node.content, expansion),
          marker: node.marker,
          priority: node.priority,
          collapsed: node.collapsed,
          ...(Object.keys(properties).length > 0 ? { properties } : {}),
          createdAt: now,
        }),
      );
      if (top) roots.push({ id, order });
      visit(node.children, id, null, null, false);
    });
  };
  visit(nodes, target.parentId, target.lower, target.upper, true);
  return { ops, roots };
}

/** `templateNodesOps` over what the template says to insert (`templateRoots`). */
export function templateInsertOps(
  root: TemplateNode,
  target: TemplateTarget,
  expansion: TemplateExpansion,
  mint: OpMinter,
  now: number = Date.now(),
): TemplateInsertResult {
  return templateNodesOps(templateRoots(root), target, expansion, mint, now);
}
