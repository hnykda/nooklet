/**
 * Bridges the wire "outline Markdown with ^ids" format (`docs/spec/mcp-tools.md` §3.2) to/from
 * `@nooklet/core`'s block tree:
 *
 *  - write side: `page_append`/`block_insert`/`page_create` accept Markdown, PARSE it with
 *    `@nooklet/core`'s `parseOutline` (the "write markdown, get blocks" feature, PLAN.md), and this
 *    module turns the resulting `OutlineNode` tree into a flat `Op[]` for `ctx.applyOps` — walking
 *    the tree ourselves rather than looping `DataApi.blocks.insert()` one block at a time, since
 *    that method's spec shape (api-and-plugin-types.md §3) has no marker/priority/children
 *    parameters (Open issue #7 there explicitly permits handlers to go around `DataApi` for this).
 *  - read side: `page_read`/`block_read` convert a `ServerBlockNode` tree (`../data-api.ts`) into
 *    `OutlineNode`s and call `@nooklet/core`'s `serializeOutline` for the canonical ^id-suffixed
 *    text, rather than hand-rolling Markdown output.
 *
 * Simplification (documented, not a bug): depth-truncation's "(+N children)" inline annotation
 * from mcp-tools.md's own example output is NOT reproduced in the outline text, since
 * `serializeOutline`/`OutlineNode` have no slot for it and adding one would mean hand-rolling
 * Markdown output instead of reusing the serializer, which the task explicitly asks to avoid.
 * `truncated`/`continue_hint`/the JSON-mode `child_count` field still carry the same information.
 */

import type { Op, OpPayload, OutlineNode, ParsedPage, Properties, SqlDriver } from "@nooklet/core";
import { isId, newId, parseOutline, serializeOutline } from "@nooklet/core";
import { newOrderKeys, type OrderBounds, type ServerBlockNode } from "../data-api.js";
import { getBlockRowAny } from "../rows.js";
import { type OpContext, OpError } from "./registry.js";
import type { BlockNodeT } from "./schemas.js";

// ---------------------------------------------------------------------------------------------
// Checkbox sugar ("- [ ] x" / "- [x] x" -> "- TODO x" / "- DONE x"), a pre-processing pass over
// the raw Markdown since `@nooklet/core`'s `outline.ts` parser (fixed, must-not-modify) does not
// implement it (mcp-tools.md §3.2 rule 4). Fence-aware so it never rewrites inside a code block.
// ---------------------------------------------------------------------------------------------

const CHECKBOX_BULLET_RE = /^(\s*)-\s\[([ xX])\]\s(.*)$/;
const FENCE_START_RE = /^(`{3,}|~{3,})/;

export function applyCheckboxSugar(markdown: string): string {
  const lines = markdown.split(/\r\n?|\n/);
  let fence: string | null = null;
  const out: string[] = [];
  for (const line of lines) {
    if (fence !== null) {
      out.push(line);
      if (line.trimStart().startsWith(fence)) fence = null;
      continue;
    }
    const m = CHECKBOX_BULLET_RE.exec(line);
    if (m) {
      const marker = (m[2] as string).toLowerCase() === "x" ? "DONE" : "TODO";
      const rest = m[3] as string;
      out.push(`${m[1]}- ${marker} ${rest}`);
      const fm = FENCE_START_RE.exec(rest);
      if (fm) fence = fm[1] as string;
      continue;
    }
    out.push(line);
    const fm = FENCE_START_RE.exec(line.trimStart());
    if (fm) fence = fm[1] as string;
  }
  return out.join("\n");
}

/** Parse wire Markdown (checkbox sugar applied) into the block tree to insert/upsert, plus the
 * page properties of a leading pre-block (OUT-2) — which the caller must either apply or refuse,
 * never drop (B-235). */
export function parseMarkdownPage(markdown: string): ParsedPage {
  return parseOutline(applyCheckboxSugar(markdown));
}

/**
 * How the lines after line 1 of a single-block text are indented:
 *  - `"flush"`: at column 0, exactly as `renderSingleBlockText` (the `before` text) writes them —
 *    what `old_str`/`new_str` edits, so any indent a line has is the content's own.
 *  - `"auto"`: for `content` an agent wrote. Flush as above, unless every later non-blank line is
 *    indented by two spaces or a tab — `page_read`'s shape, which an agent copies, and the only
 *    multi-line shape `content` accepted before B-172. Then the whitespace those lines have in
 *    common is removed first: page_read indents a block at depth d by 2·(d+1) columns, and taking
 *    off only one 2-column unit left a nested block's `scheduled::` line indented — literal text —
 *    so `block.update` unset the property (B-313). A content whose every later line really starts
 *    with the same indent is read as that shape and loses it; that is the price of not turning an
 *    agent's indented `scheduled::` line into literal text.
 */
export type SingleBlockIndent = "flush" | "auto";

/** Single-block text -> one outline bullet the real parser reads: `- ` before line 1, the
 * continuation indent before every later non-empty line. */
function singleBlockBullet(text: string, indent: SingleBlockIndent): string {
  const [first = "", ...rest] = text.split(/\r\n?|\n/);
  const nonBlank = rest.filter((line) => line.trim() !== "");
  const alreadyIndented =
    indent === "auto" &&
    nonBlank.length > 0 &&
    nonBlank.every((line) => line.startsWith("  ") || line.startsWith("\t"));
  // The leading whitespace every non-blank later line shares (B-313). Empty only for a mix like
  // "  a" / "\tb", which keeps the parser's own one-unit strip below, as before.
  const common = alreadyIndented ? commonLeadingWhitespace(nonBlank) : "";
  const body = rest.map((line) => {
    if (common !== "") return line.trim() === "" ? line : `  ${line.slice(common.length)}`;
    return alreadyIndented || line === "" ? line : `  ${line}`;
  });
  return [`- ${first}`, ...body].join("\n");
}

function commonLeadingWhitespace(lines: readonly string[]): string {
  let prefix = /^[ \t]*/.exec(lines[0] ?? "")?.[0] ?? "";
  for (const line of lines) {
    let i = 0;
    while (i < prefix.length && line[i] === prefix[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}

/** `block.update`'s "single-block grammar" (mcp-tools.md §3.2 rule 10): the same grammar as one
 * block, minus the leading bullet, with no nested `child` productions. Implemented by turning the
 * text into one real bullet (`singleBlockBullet`) and reusing the real parser, then rejecting any
 * child bullet.
 *
 * B-172: this used to prefix `- ` to line 1 only. Line 2 onwards then sat at column 0 — top-level
 * blocks of their own — so every block with a property line or a second line (each DONE task has
 * `done::`) failed "content must describe exactly one block", including an `old_str` edit of the
 * block's own `before` text. */
export function parseSingleBlockGrammar(text: string, indent: SingleBlockIndent): OutlineNode {
  // Parsed behind a throwaway first bullet: as the first bullet of a text, a block with no content
  // and only property lines IS a page-properties pre-block to the parser (OUT-2), and came back as
  // no block at all — its `collapsed` gone with it. Only the first node is ever read that way.
  const parsed = parseOutline(`- -\n${singleBlockBullet(applyCheckboxSugar(text), indent)}`);
  if (parsed.blocks.length !== 2) {
    throw new OpError("invalid", "content must describe exactly one block");
  }
  // biome-ignore lint/style/noNonNullAssertion: length check above guarantees index 1 exists
  const node = parsed.blocks[1]!;
  if (node.children.length > 0) {
    throw new OpError(
      "invalid",
      "block_update edits one block; use block_insert to add children",
      "block_update edits one block; use block_insert to add children",
    );
  }
  return node;
}

/** The inverse of `parseSingleBlockGrammar`: a block's own text (marker + priority + content +
 * property lines), with no leading bullet/indent — used for `block.update`'s `before`/`old_str`. */
export function renderSingleBlockText(block: {
  content: string;
  marker: OutlineNode["marker"];
  priority: OutlineNode["priority"];
  properties: OutlineNode["properties"];
  collapsed: boolean;
}): string {
  const node: OutlineNode = {
    content: block.content,
    marker: block.marker,
    priority: block.priority,
    properties: block.properties,
    collapsed: block.collapsed,
    children: [],
  };
  const full = serializeOutline({ properties: {}, blocks: [node] }, { ids: "none" });
  const lines = full.replace(/\n$/, "").split("\n");
  const first = (lines[0] ?? "").replace(/^- ?/, "");
  const rest = lines.slice(1).map((l) => (l.startsWith("  ") ? l.slice(2) : l));
  return [first, ...rest].join("\n");
}

// ---------------------------------------------------------------------------------------------
// Write side: OutlineNode[] -> Op[]
// ---------------------------------------------------------------------------------------------

/** Rule 6: every ` ^id` in write input must already exist (upsert) or be entirely absent (create). */
export function validateOutlineIds(driver: SqlDriver, nodes: OutlineNode[]): void {
  const stack = [...nodes];
  while (stack.length > 0) {
    // biome-ignore lint/style/noNonNullAssertion: loop guarded by stack.length > 0
    const node = stack.pop()!;
    if (node.id !== undefined) {
      if (!isId(node.id) || !getBlockRowAny(driver, node.id)) {
        throw new OpError(
          "invalid",
          `unknown block id ${node.id}`,
          `unknown block id ${node.id}; remove ^id to create a new block`,
        );
      }
    }
    stack.push(...node.children);
  }
}

export interface InsertOpsResult {
  ops: Op[];
  created: string[];
  updated: string[];
}

/** Walk `nodes`, minting `block.create`/`block.place`+`block.text`+`block.prop` ops, positioned
 * within `bounds`'s (pageId, parentId, lower, upper) siblings-order window. Mutates each node with
 * its resolved id (`node.id = entity`) so the caller can re-serialize the same tree for `outline`. */
export function buildInsertOps(
  mintOp: (entity: string, payload: OpPayload) => Op,
  nodes: OutlineNode[],
  bounds: OrderBounds,
): InsertOpsResult {
  const ops: Op[] = [];
  const created: string[] = [];
  const updated: string[] = [];
  const now = Date.now();

  const walk = (
    list: OutlineNode[],
    pageId: string,
    parentId: string | null,
    b: [string | null, string | null],
  ) => {
    const keys = newOrderKeys({ pageId, parentId, lower: b[0], upper: b[1] }, list.length);
    list.forEach((node, i) => {
      const order = keys[i] as string;
      let entity: string;
      if (node.id !== undefined) {
        entity = node.id;
        ops.push(mintOp(entity, { kind: "block.place", place: { pageId, parentId, order } }));
        ops.push(mintOp(entity, { kind: "block.text", content: node.content }));
        ops.push(mintOp(entity, { kind: "block.prop", key: "marker", value: node.marker }));
        ops.push(mintOp(entity, { kind: "block.prop", key: "priority", value: node.priority }));
        ops.push(
          mintOp(entity, {
            kind: "block.prop",
            key: "collapsed",
            value: node.collapsed ? "true" : "false",
          }),
        );
        for (const [k, v] of Object.entries(node.properties))
          ops.push(mintOp(entity, { kind: "block.prop", key: k, value: v }));
        updated.push(entity);
      } else {
        entity = newId();
        ops.push(
          mintOp(entity, {
            kind: "block.create",
            place: { pageId, parentId, order },
            content: node.content,
            marker: node.marker,
            priority: node.priority,
            collapsed: node.collapsed,
            properties: node.properties,
            createdAt: now,
          }),
        );
        created.push(entity);
      }
      node.id = entity;
      if (node.children.length > 0) walk(node.children, pageId, entity, [null, null]);
    });
  };

  walk(nodes, bounds.pageId, bounds.parentId, [bounds.lower, bounds.upper]);
  return { ops, created, updated };
}

export interface MarkdownInsertResult extends InsertOpsResult {
  outline: string;
  /** The markdown's page-properties pre-block, `{}` without one. Non-empty only under `"accept"`,
   * and then the caller applies it. */
  pageProperties: Properties;
}

/** Write markdown, parsed and checked, before any op is minted — see `checkWriteMarkdown`. */
export interface CheckedMarkdown {
  blocks: OutlineNode[];
  /** The page-properties pre-block, `{}` without one; non-empty only under `"accept"`. */
  pageProperties: Properties;
}

/**
 * Parse write markdown and refuse what cannot be written, touching nothing — no target page is
 * needed yet. `page.append` calls this BEFORE resolving (and possibly creating) its page, so a
 * refusal no longer leaves a fresh, empty page or journal day behind (B-312); the other callers
 * get it through `prepareMarkdownInsert`.
 *
 * A pre-block of page properties (`read-only:: true` before the first bullet, or a first bullet
 * holding nothing but property lines — OUT-2) used to vanish: only the blocks were kept, and the
 * write reported success (B-235). Only a page being created takes one (`"accept"`, the caller
 * applies it); every write into an existing page refuses it (`"refuse"`), since an append silently
 * changing the page's own properties is as surprising as dropping them, and an agent that meant a
 * first block with only properties needs to hear that the parser read it otherwise.
 */
export function checkWriteMarkdown(
  driver: SqlDriver,
  markdown: string,
  pageProperties: "accept" | "refuse",
): CheckedMarkdown {
  const parsed = parseMarkdownPage(markdown);
  const keys = Object.keys(parsed.properties);
  if (keys.length > 0 && pageProperties === "refuse") {
    throw new OpError(
      "invalid",
      `markdown starts with page properties (${keys.join(", ")}), which only page_create applies`,
      "set a page's properties with page_update; to give a block properties, put the key:: value " +
        "lines under that block's bullet, after its first line",
    );
  }
  if (parsed.blocks.length === 0 && keys.length === 0) {
    throw new OpError(
      "invalid",
      "markdown did not parse to any blocks",
      "check for a dangling fence or empty input",
    );
  }
  validateOutlineIds(driver, parsed.blocks);
  return { blocks: parsed.blocks, pageProperties: parsed.properties };
}

/** The full write path shared by `page.append`/`block.insert`/`page.create`'s `markdown` field:
 * check (`checkWriteMarkdown`, unless the caller already did), mint ops, and render the (now
 * ^id-annotated) inserted tree as text. Does NOT call `ctx.applyOps` itself — the caller applies
 * (batches often combine several of these). */
export function prepareMarkdownInsert(
  ctx: OpContext,
  markdown: string | CheckedMarkdown,
  bounds: OrderBounds,
  pageProperties: "accept" | "refuse" = "refuse",
): MarkdownInsertResult {
  const checked =
    typeof markdown === "string" ? checkWriteMarkdown(ctx.db, markdown, pageProperties) : markdown;
  const nodes = checked.blocks;
  const { ops, created, updated } = buildInsertOps(ctx.mintOp, nodes, bounds);
  const outline = nodes.length > 0 ? renderOutlineNodes(nodes) : "";
  return { ops, created, updated, outline, pageProperties: checked.pageProperties };
}

// ---------------------------------------------------------------------------------------------
// Read side: ServerBlockNode[] -> outline text / wire BlockNodeT
// ---------------------------------------------------------------------------------------------

function toOutlineNode(node: ServerBlockNode): OutlineNode {
  return {
    id: node.id,
    content: node.content,
    marker: node.marker,
    priority: node.priority,
    properties: node.properties,
    collapsed: node.collapsed,
    children: node.children.map(toOutlineNode),
  };
}

export function renderOutlineText(nodes: ServerBlockNode[], ids: "all" | "none" = "all"): string {
  const page: ParsedPage = { properties: {}, blocks: nodes.map(toOutlineNode) };
  return serializeOutline(page, { ids: ids === "none" ? "none" : "present" });
}

/** Render an already-`^id`-annotated `OutlineNode[]` (post `buildInsertOps`) straight to text —
 * used by every write op's `WriteResult.outline` (always shows ids, per the spec's examples). */
export function renderOutlineNodes(nodes: OutlineNode[]): string {
  return serializeOutline({ properties: {}, blocks: nodes }, { ids: "present" });
}

export interface RenderedOutline {
  text: string;
  truncated: boolean;
  lastIncludedId?: string;
  omittedCount: number;
}

/** Cut `nodes` (siblings at one level) at whole-top-level-chunk boundaries once the accumulated
 * text would exceed `maxChars` (mcp-tools.md §3.2 rule 8: "never mid-block"). The first chunk is
 * always included in full even alone it exceeds `maxChars`. */
export function renderTruncated(
  nodes: ServerBlockNode[],
  ids: "all" | "none",
  maxChars: number,
): RenderedOutline {
  let text = "";
  let lastIncludedId: string | undefined;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as ServerBlockNode;
    const chunk = renderOutlineText([node], ids);
    if (text.length > 0 && text.length + chunk.length > maxChars) {
      return { text, truncated: true, lastIncludedId, omittedCount: nodes.length - i };
    }
    text += chunk;
    lastIncludedId = node.id;
  }
  return { text, truncated: false, lastIncludedId, omittedCount: 0 };
}

/**
 * `block_read`'s output schema requires BOTH a full JSON `block` tree (bounded only by `depth`)
 * AND a rendered `text` (bounded by `depth` and `max_chars`) unconditionally — `format` does not
 * gate either field away for this op (contrast `page_read`, where `tree`/`text` are alternatives).
 * Truncation boundary here is "how many of the root's immediate children fit", since there is
 * exactly one root (no sibling list to chunk across, unlike `page_read`'s top-level blocks).
 */
export function renderRootTruncated(
  root: ServerBlockNode,
  ids: "all" | "none",
  maxChars: number,
): RenderedOutline {
  let best = renderOutlineText([{ ...root, children: [] }], ids);
  if (root.children.length === 0)
    return { text: best, truncated: false, lastIncludedId: root.id, omittedCount: 0 };
  let included = 0;
  for (let k = 1; k <= root.children.length; k++) {
    const candidate = renderOutlineText([{ ...root, children: root.children.slice(0, k) }], ids);
    if (candidate.length > maxChars && k > 1) break;
    best = candidate;
    included = k;
    if (candidate.length > maxChars) break; // even the first child alone is huge; keep it whole anyway
  }
  const truncated = included < root.children.length;
  return {
    text: best,
    truncated,
    lastIncludedId: included > 0 ? root.children[included - 1]?.id : root.id,
    omittedCount: root.children.length - included,
  };
}

/** `ServerBlockNode` (camelCase, epoch-ms `updatedAt`) -> the wire `BlockNodeT` (snake_case,
 * ISO `updated_at`/`version`, optional `updated_by`/`child_count`) used by `format: 'json'`. */
export function toWireBlockNode(driver: SqlDriver, node: ServerBlockNode): BlockNodeT {
  const updatedBy = driver.get<{ origin: string; actor: string }>(
    "SELECT origin, actor FROM changes WHERE entity_type = 'block' AND entity_id = ? ORDER BY seq DESC LIMIT 1",
    [node.id],
  );
  const iso = new Date(node.updatedAt).toISOString();
  const wire: BlockNodeT = {
    id: node.id,
    content: node.content,
    marker: node.marker,
    priority: node.priority,
    properties: Object.keys(node.properties).length > 0 ? node.properties : undefined,
    collapsed: node.collapsed,
    children: node.children.map((c) => toWireBlockNode(driver, c)),
    version: iso,
    updated_at: iso,
    child_count: node.childCount,
  };
  if (updatedBy) wire.updated_by = updatedBy as { origin: string; actor: string };
  return wire;
}
