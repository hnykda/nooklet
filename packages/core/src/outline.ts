/**
 * Outline markdown: text <-> tree of OutlineNode.
 *
 * Canonical format (`docs/spec/markdown-grammar.md`; what our server writes):
 *
 *   title:: Page Title                  <- optional page properties ("pre-block"), no bullet
 *
 *   - first block ^1k7f3q9xz2hav4       <- one bullet per block; a trailing " ^id" suffix
 *     collapsed:: true                     (Obsidian-style, OUT-11) carries the block id
 *     second line of the block          <- continuation lines: block indent + one indent unit
 *   - TODO [#A] child block ^1k7f3q9xz2hav5
 *     scheduled:: 2026-09-12
 *     repeat:: 1w
 *   - ^1k7f3q9xz2hav6                   <- when line 1 would open a fence, the id sits alone
 *     ```js                                on its own first line (OUT-14)
 *     - not a bullet: inside a fence
 *     ```
 *
 * Canonical nesting uses two-space indentation (OUT-6). Parsing is indentation-width based
 * (tab = 4 columns), so tab-, 2-space-, and 4-space-indented files all import identically
 * (each line's own width is computed independently, OUT-5) — this is what makes both Logseq
 * file graphs (tabs) and Logseq DB markdown mirrors (2/4 spaces) import losslessly.
 *
 * Import tolerance (never emitted by the serializer): Logseq's `id:: <uuid>` property line
 * (OUT-15), literal `1. `/`*`/`+` bullets (OUT-4), `custom_id::`/`logseq.order-list-type::`
 * key remapping (OUT-19), `heading:: N` folded into a `#`-prefix (OUT-25), and org-mode
 * `SCHEDULED:`/`DEADLINE:`/`:LOGBOOK:` syntax mapped onto `scheduled::`/`deadline::`/
 * `repeat::` typed properties (ADR 011, OUT-23) with LOGBOOK history simply dropped (that
 * history lives in the sync op log, not the file).
 */

import { isId } from "./ids.js";
import type { OutlineNode, ParsedPage, Priority, Properties, TaskMarker } from "./model.js";

const TAB_WIDTH = 4;
const BULLET_RE = /^([\t ]*)-(?: (.*))?$/;
const ALT_BULLET_RE = /^([\t ]*)[*+](?: (.*))?$/;
const NUMBERED_BULLET_RE = /^([\t ]*)[0-9]+\.(?: (.*))?$/;
const FENCE_RE = /^(`{3,}|~{3,})/;
const PROPERTY_RE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):: ?(.*)$/;
const MARKER_RE =
  /^(TODO|DOING|DONE|LATER|NOW|WAITING|WAIT|CANCELED|CANCELLED|IN-PROGRESS)(?=\s|$)/;
const PRIORITY_RE = /^\[#([ABC])\](?=\s|$)/;
const FRONT_MATTER_LINE_RE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):\s*(.*)$/;
/** OUT-12: a trailing " ^id" suffix on a line that also has other content. */
const ID_SUFFIX_RE = / \^([0-9a-z]{14})$/;
/** OUT-14: a line that is *only* an id (used when line 1 would otherwise open a fence). */
const ID_ALONE_RE = /^\^([0-9a-z]{14})$/;
/** OUT-23: org timestamp lines. Group 1 = SCHEDULED|DEADLINE, group 2 = the `<...>` interior. */
const SCHEDULED_DEADLINE_RE = /^\s*(SCHEDULED|DEADLINE):\s*<([^>]+)>\s*$/;
/** Interior of an org timestamp: date, optional weekday, optional time, optional repeater. */
const TIMESTAMP_INNER_RE =
  /^(\d{4}-\d{2}-\d{2})(?:\s+[A-Za-z]{2,3})?(?:\s+(\d{1,2}:\d{2}))?(?:\s+[.+]{1,2}(\d+)([dwmy]))?$/;
const HEADING_PREFIX_RE = /^#{1,6} /;

const MARKER_ALIASES: Record<string, TaskMarker> = {
  WAIT: "WAITING",
  CANCELLED: "CANCELED",
  "IN-PROGRESS": "DOING",
};

/** OUT-19: keys remapped (after lowercasing) before the generic `_` -> `-` rule applies. */
const PROPERTY_KEY_REMAP: Record<string, string> = {
  custom_id: "id",
  "custom-id": "id",
  "logseq.order-list-type": "list",
};

interface RawNode {
  width: number;
  lines: string[];
  children: RawNode[];
  bullet: boolean;
  /** OUT-4/17: opened by a literal `1. `-style bullet; folded into `list:: number` if unset. */
  numbered: boolean;
}

function indentWidth(ws: string): number {
  let w = 0;
  for (const ch of ws) w += ch === "\t" ? TAB_WIDTH : 1;
  return w;
}

/**
 * Strip the indentation of a continuation line: the parent bullet's indent
 * (up to `width` columns) plus one continuation marker (two spaces or one tab).
 * Anything beyond that is kept verbatim (e.g. indented code inside a block).
 */
function stripContinuation(line: string, width: number): string {
  let i = 0;
  let w = 0;
  while (w < width && (line[i] === " " || line[i] === "\t")) {
    w += line[i] === "\t" ? TAB_WIDTH : 1;
    i++;
  }
  if (line[i] === "\t") i++;
  else {
    let spaces = 0;
    while (spaces < 2 && line[i] === " ") {
      i++;
      spaces++;
    }
  }
  return line.slice(i);
}

/** Opening fence: line starts with ``` or ~~~ and the same fence does not also close on it. */
function openingFence(text: string): string | null {
  const m = FENCE_RE.exec(text);
  if (!m) return null;
  const fence = m[1] as string;
  const rest = text.slice(fence.length);
  if (rest.includes(fence[0] as string)) return null;
  return fence;
}

function closesFence(text: string, fence: string): boolean {
  const t = text.trimStart();
  if (!t.startsWith(fence)) return false;
  return t.slice(fence.length).trim() === "";
}

export function parseOutline(text: string): ParsedPage {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const page: ParsedPage = { properties: {}, blocks: [] };
  const roots: RawNode[] = [];
  const stack: RawNode[] = [];
  let current: RawNode | null = null;
  let pendingBlank = 0;
  let fence: string | null = null;
  let i = 0;

  // YAML front matter (OUT-3: older Logseq graphs / other tools)
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      for (const l of lines.slice(1, end)) {
        const m = FRONT_MATTER_LINE_RE.exec(l);
        if (m) page.properties[(m[1] as string).toLowerCase()] = (m[2] as string).trim();
      }
      i = end + 1;
    }
  }

  const startNode = (width: number, firstLine: string, bullet: boolean, numbered = false): void => {
    while (stack.length > 0 && (stack[stack.length - 1] as RawNode).width >= width) stack.pop();
    const node: RawNode = { width, lines: [firstLine], children: [], bullet, numbered };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
    current = node;
    pendingBlank = 0;
    fence = openingFence(firstLine);
  };

  for (; i < lines.length; i++) {
    const line = lines[i] as string;

    if (fence !== null && current !== null) {
      const stripped = stripContinuation(line, (current as RawNode).width);
      (current as RawNode).lines.push(stripped);
      if (closesFence(stripped, fence)) fence = null;
      continue;
    }

    if (line.trim() === "") {
      pendingBlank++;
      continue;
    }

    const m = BULLET_RE.exec(line);
    if (m) {
      startNode(indentWidth(m[1] as string), m[2] ?? "", true);
      continue;
    }
    const am = ALT_BULLET_RE.exec(line);
    if (am) {
      startNode(indentWidth(am[1] as string), am[2] ?? "", true);
      continue;
    }
    const nm = NUMBERED_BULLET_RE.exec(line);
    if (nm) {
      startNode(indentWidth(nm[1] as string), nm[2] ?? "", true, true);
      continue;
    }

    const ws = /^[\t ]*/.exec(line)?.[0] ?? "";
    const w = indentWidth(ws);
    const cur = current as RawNode | null;
    if (cur !== null && (w > cur.width || (!cur.bullet && w >= cur.width))) {
      // continuation line of the current block (or of a bulletless paragraph)
      const node = cur;
      for (let k = 0; k < pendingBlank; k++) node.lines.push("");
      pendingBlank = 0;
      const stripped = stripContinuation(line, node.width);
      node.lines.push(stripped);
      fence = openingFence(stripped);
      continue;
    }

    // Plain paragraph (no bullet) at this indentation: becomes its own block (OUT-9).
    startNode(w, line.slice(ws.length), false);
  }

  const nodes = roots.map(finalizeNode);

  // Pre-block: a leading property-only block holds the page properties (OUT-2).
  const first = nodes[0];
  if (first && first.content === "" && first.marker === null && first.children.length === 0) {
    const hasProps = Object.keys(first.properties).length > 0 || first.id !== undefined;
    if (hasProps || !(roots[0] as RawNode).bullet) {
      if (first.id !== undefined) page.properties.id = first.id;
      Object.assign(page.properties, first.properties);
      nodes.shift();
    }
  }
  page.blocks = nodes;
  return page;
}

/** Normalize a raw property key per OUT-19: lowercase, remap table, else `_` -> `-`. */
function normalizePropertyKey(raw: string): string {
  const lower = raw.toLowerCase();
  return PROPERTY_KEY_REMAP[lower] ?? lower.replace(/_/g, "-");
}

function finalizeNode(raw: RawNode): OutlineNode {
  const properties: Properties = {};
  const kept: string[] = [];
  let id: string | undefined;
  let collapsed = false;
  let headingLevel: number | undefined;
  let fence: string | null = null;
  let inLogbook = false;
  let firstKeptWasFirstLine = false;

  raw.lines.forEach((line, idx) => {
    if (fence !== null) {
      kept.push(line);
      if (closesFence(line, fence)) fence = null;
      return;
    }
    // OUT-23: a :LOGBOOK: ... :END: drawer is dropped entirely (its history lives in the op log).
    if (inLogbook) {
      if (line.trim() === ":END:") inLogbook = false;
      return;
    }
    if (line.trim() === ":LOGBOOK:") {
      inLogbook = true;
      return;
    }
    const pm = PROPERTY_RE.exec(line);
    if (pm) {
      const key = normalizePropertyKey(pm[1] as string);
      const value = (pm[2] as string).trim();
      if (key === "id") id = value;
      else if (key === "collapsed") collapsed = value === "true";
      else if (key === "heading") {
        const n = Number.parseInt(value, 10);
        if (n >= 1 && n <= 6) headingLevel = n;
      } else properties[key] = value;
      return;
    }
    // OUT-23: org SCHEDULED:/DEADLINE: timestamp lines -> scheduled::/deadline::/repeat::.
    const sdm = SCHEDULED_DEADLINE_RE.exec(line);
    if (sdm) {
      const tm = TIMESTAMP_INNER_RE.exec((sdm[2] as string).trim());
      if (tm) {
        const kind = (sdm[1] as string).toLowerCase();
        properties[kind] = tm[2] ? `${tm[1]} ${tm[2]}` : (tm[1] as string);
        if (tm[3] && tm[4]) properties.repeat = `${tm[3]}${tm[4]}`;
        return;
      }
      // malformed timestamp: fall through and keep the line as ordinary content (no data loss).
    }
    if (kept.length === 0 && idx === 0) firstKeptWasFirstLine = true;
    kept.push(line);
    fence = openingFence(line);
  });

  let marker: TaskMarker | null = null;
  let priority: Priority | null = null;
  let idFromSuffix: string | undefined;

  if (firstKeptWasFirstLine && kept.length > 0) {
    // OUT-14: the id sits alone on line 1 when the real first line would open a fence
    // (accepted harmlessly whenever a further line follows, even a non-fence one).
    if (kept.length > 1) {
      const aloneMatch = ID_ALONE_RE.exec(kept[0] as string);
      if (aloneMatch && isId(aloneMatch[1] as string)) {
        idFromSuffix = aloneMatch[1];
        kept.shift();
      }
    }
    if (idFromSuffix === undefined) {
      let first = kept[0] as string;
      const mm = MARKER_RE.exec(first);
      if (mm) {
        const rawMarker = mm[1] as string;
        marker = MARKER_ALIASES[rawMarker] ?? (rawMarker as TaskMarker);
        first = first.slice(rawMarker.length).trimStart();
      }
      const pm = PRIORITY_RE.exec(first);
      if (pm) {
        priority = pm[1] as Priority;
        first = first.slice(pm[0].length).trimStart();
      }
      // OUT-12: trailing " ^id" suffix, checked after marker/priority are stripped.
      const suffixMatch = ID_SUFFIX_RE.exec(first);
      if (suffixMatch && isId(suffixMatch[1] as string)) {
        idFromSuffix = suffixMatch[1];
        first = first.slice(0, suffixMatch.index);
      }
      kept[0] = first;
    }
  }

  // OUT-15: the ^id suffix wins over an `id::` property line; the property is dropped either way.
  if (idFromSuffix !== undefined) id = idFromSuffix;

  if (raw.numbered && properties.list === undefined) properties.list = "number";

  while (kept.length > 0 && (kept[kept.length - 1] as string).trim() === "") kept.pop();
  let content = kept.join("\n").replace(/[ \t]+$/gm, (m) => (m.length ? "" : m));

  // OUT-25: `heading:: N` folds into a literal `#` prefix; a pre-existing `#` count always wins.
  if (headingLevel !== undefined && !HEADING_PREFIX_RE.test(content)) {
    content = `${"#".repeat(headingLevel)} ${content}`;
  }

  const node: OutlineNode = {
    content,
    marker,
    priority,
    properties,
    collapsed,
    children: raw.children.map(finalizeNode),
  };
  if (id !== undefined) node.id = id;
  return node;
}

export interface SerializeOptions {
  /** Indent unit for nesting. Canonical is two spaces (OUT-6); Logseq OG writes tabs. */
  indent?: "\t" | "  " | "    ";
  /** Which nodes get an ` ^id` suffix: nodes that have an id (default) or none. */
  ids?: "present" | "none";
}

/** Tree -> canonical outline markdown text (`docs/spec/markdown-grammar.md`). */
export function serializeOutline(page: ParsedPage, opts: SerializeOptions = {}): string {
  const indentUnit = opts.indent ?? "  ";
  const writeIds = opts.ids !== "none";
  const out: string[] = [];

  const pageProps = Object.entries(page.properties);
  if (pageProps.length > 0) {
    for (const [k, v] of pageProps) out.push(`${k}:: ${v}`);
  }

  const walk = (node: OutlineNode, level: number): void => {
    const indent = indentUnit.repeat(level);
    const cont = `${indent}  `;
    // Canonical output only ever uses the ^id suffix (OUT-11) for a genuine 14-char id; any
    // other id shape (e.g. a Logseq UUID not yet remapped by the importer) round-trips through
    // the OUT-15 `id::` property line instead, since a non-14-char suffix would not re-parse.
    const suffixId = writeIds && node.id !== undefined && isId(node.id) ? node.id : undefined;
    const legacyId = writeIds && node.id !== undefined && !isId(node.id) ? node.id : undefined;
    const head = [node.marker, node.priority ? `[#${node.priority}]` : null]
      .filter((s): s is string => s !== null)
      .join(" ");
    const contentLines = node.content === "" ? [] : node.content.split("\n");
    const first = contentLines[0] ?? "";
    let restContentLines: string[];

    if (suffixId !== undefined && openingFence(first) !== null) {
      // OUT-14: line 1 would open a fence, so the id sits alone and the fence starts on line 2.
      out.push(`${indent}- ^${suffixId}`);
      restContentLines = contentLines;
    } else {
      let firstLine = [head, first].filter((s) => s !== "").join(" ");
      if (suffixId !== undefined) {
        firstLine = firstLine === "" ? `^${suffixId}` : `${firstLine} ^${suffixId}`;
      }
      out.push(firstLine === "" ? `${indent}-` : `${indent}- ${firstLine}`);
      restContentLines = contentLines.slice(1);
    }

    const props: Array<[string, string]> = [];
    if (legacyId !== undefined) props.push(["id", legacyId]);
    if (node.collapsed) props.push(["collapsed", "true"]);
    for (const [k, v] of Object.entries(node.properties)) props.push([k, v]);
    for (const [k, v] of props) out.push(`${cont}${k}:: ${v}`);

    for (const rest of restContentLines) out.push(rest === "" ? "" : `${cont}${rest}`);
    for (const child of node.children) walk(child, level + 1);
  };

  for (const node of page.blocks) walk(node, 0);
  return `${out.join("\n")}\n`;
}

/** Depth-first walk of an outline tree. */
export function* walkOutline(
  nodes: OutlineNode[],
  parent: OutlineNode | null = null,
  depth = 0,
): Generator<{
  node: OutlineNode;
  parent: OutlineNode | null;
  depth: number;
  index: number;
}> {
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index] as OutlineNode;
    yield { node, parent, depth, index };
    yield* walkOutline(node.children, node, depth + 1);
  }
}
