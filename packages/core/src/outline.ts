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
 *   - TODO ^1k7f3q9xz2hav6              <- when line 1 would open a fence, the marker/priority
 *     ```js                                and the id sit alone on the first line (OUT-14)
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
import { isValidJournalDay } from "./journal.js";
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
/** OUT-14: what is left of line 1 when it holds nothing but an id — an empty block (`- ^id`), or
 * a task whose marker strip also took the space before `^` (`- TODO ^id`). */
const ID_ALONE_RE = /^\^([0-9a-z]{14})$/;
/** OUT-23: org timestamp lines. Group 1 = SCHEDULED|DEADLINE, group 2 = the `<...>` interior. */
const SCHEDULED_DEADLINE_RE = /^\s*(SCHEDULED|DEADLINE):\s*<([^>]+)>\s*$/;
/** Interior of an org timestamp: date, optional weekday, optional time, optional repeater.
 * Groups: 1-3 = year, month, day; 4-5 = hour, minute; 6-7 = repeat count, unit.
 *
 * Month, day and hour take ONE digit too: Logseq wrote `<2023-2-17 Fri>` often enough that 20 of
 * the 24 `SCHEDULED:` lines in the owner's graph look like that, and a strict `\d{2}` made every
 * one of them fall through to content text — the date silently gone (B-143). `orgTimestamp`
 * pads them to the only shape the reducer accepts. */
const TIMESTAMP_INNER_RE =
  /^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+[A-Za-z]{2,3})?(?:\s+(\d{1,2}):(\d{2}))?(?:\s+[.+]{1,2}(\d+)([dwmy]))?$/;

/** An org timestamp's interior as ADR 011 values (`YYYY-MM-DD[ HH:MM]`, `<n><unit>`), or
 * `undefined` when it is not one — including an impossible date or time, which the caller keeps
 * as text rather than storing wrong. */
function orgTimestamp(inner: string): { date: string; repeat: string | undefined } | undefined {
  const m = TIMESTAMP_INNER_RE.exec(inner);
  if (!m) return undefined;
  const pad = (s: string | undefined): string => (s ?? "").padStart(2, "0");
  const day = Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
  if (!isValidJournalDay(day)) return undefined;
  let date = `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  if (m[4] !== undefined) {
    if (Number(m[4]) > 23 || Number(m[5]) > 59) return undefined;
    date += ` ${pad(m[4])}:${m[5]}`;
  }
  return { date, repeat: m[6] && m[7] ? `${m[6]}${m[7]}` : undefined };
}
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

/** OUT-16: a first line's task head (marker, then priority) split from the rest of the line.
 * Shared by the fence check and `finalizeNode`, so both read the same line 1 (B-310). */
function splitTaskHead(line: string): {
  marker: TaskMarker | null;
  priority: Priority | null;
  rest: string;
} {
  let rest = line;
  let marker: TaskMarker | null = null;
  let priority: Priority | null = null;
  const mm = MARKER_RE.exec(rest);
  if (mm) {
    const rawMarker = mm[1] as string;
    marker = MARKER_ALIASES[rawMarker] ?? (rawMarker as TaskMarker);
    rest = rest.slice(rawMarker.length).trimStart();
  }
  const pm = PRIORITY_RE.exec(rest);
  if (pm) {
    priority = pm[1] as Priority;
    rest = rest.slice(pm[0].length).trimStart();
  }
  return { marker, priority, rest };
}

/** Whether a block's line 1 opens a fence — looked for after its marker/priority, because
 * `TODO ```js` is a task whose content opens with a fence. Checked on the raw line the fence never
 * opened: the code's `- ` lines came back as child blocks and its `key:: value` lines as
 * properties (B-310). */
function firstLineOpensFence(line: string): string | null {
  return openingFence(splitTaskHead(line).rest);
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
    fence = firstLineOpensFence(firstLine);
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

  const caretIds = new WeakSet<OutlineNode>();
  const nodes = roots.map((raw) => finalizeNode(raw, caretIds));

  // Pre-block: a leading property-only block holds the page properties (OUT-2). Not an empty block
  // with a `^id` (OUT-11): that is a block's own id, never a page's, and a mirror file whose first
  // block is empty (`- ^id`) would otherwise lose that block into `page.properties.id` (B-390).
  const first = nodes[0];
  if (
    first &&
    first.content === "" &&
    first.marker === null &&
    first.children.length === 0 &&
    !caretIds.has(first)
  ) {
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

/** `caretIds` collects the nodes whose id came from `^id` syntax (OUT-11/14) rather than an `id::`
 * line (OUT-15), for the pre-block rule. */
function finalizeNode(raw: RawNode, caretIds: WeakSet<OutlineNode>): OutlineNode {
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
      const ts = orgTimestamp((sdm[2] as string).trim());
      if (ts) {
        const kind = (sdm[1] as string).toLowerCase();
        properties[kind] = ts.date;
        if (ts.repeat) properties.repeat = ts.repeat;
        return;
      }
      // malformed timestamp: fall through and keep the line as ordinary content (no data loss).
    }
    if (kept.length === 0 && idx === 0) firstKeptWasFirstLine = true;
    kept.push(line);
    fence = idx === 0 ? firstLineOpensFence(line) : openingFence(line);
  });

  let marker: TaskMarker | null = null;
  let priority: Priority | null = null;
  let idFromSuffix: string | undefined;

  if (firstKeptWasFirstLine && kept.length > 0) {
    const head = splitTaskHead(kept[0] as string);
    marker = head.marker;
    priority = head.priority;
    let first = head.rest;
    // OUT-12: a trailing " ^id" suffix, checked after marker/priority are stripped — or OUT-14, a
    // line 1 holding nothing but the id. B-390: that form needs no further line. It is how an empty
    // block (`- ^id`) and a task with an empty line 1 (`- LATER ^id`) are written, and requiring
    // one read both back with `^id` as their text and no id.
    const idMatch = ID_SUFFIX_RE.exec(first) ?? ID_ALONE_RE.exec(first);
    if (idMatch && isId(idMatch[1] as string)) {
      idFromSuffix = idMatch[1];
      first = first.slice(0, idMatch.index);
    }
    kept[0] = first;
    // OUT-14: a line 1 left empty by its head and/or id, followed by a line that opens a fence, is
    // not a content line — the serializer wrote the head there because the content opens with that
    // fence. Only then: before any other line, an empty line 1 is the content's own.
    const headOrId = marker !== null || priority !== null || idFromSuffix !== undefined;
    if (first === "" && headOrId && kept.length > 1 && openingFence(kept[1] as string) !== null) {
      kept.shift();
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
    children: raw.children.map((child) => finalizeNode(child, caretIds)),
  };
  if (id !== undefined) node.id = id;
  if (idFromSuffix !== undefined) caretIds.add(node);
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
    const contLine = (line: string): string => (line === "" ? "" : `${cont}${line}`);

    const props: string[] = [];
    if (legacyId !== undefined) props.push(`id:: ${legacyId}`);
    if (node.collapsed) props.push("collapsed:: true");
    for (const [k, v] of Object.entries(node.properties)) props.push(`${k}:: ${v}`);

    if (suffixId !== undefined && openingFence(first) !== null) {
      // OUT-14: line 1 would open a fence, so the head and the id sit alone on it and the fence
      // starts on line 2. B-310: this used to write the id only, and the marker and priority were
      // gone the first time the mirror was read back.
      out.push(
        `${indent}- ${[head, `^${suffixId}`].filter((s) => s !== "").join(" ")}`,
        ...props.map(contLine),
        ...contentLines.map(contLine),
      );
    } else if (props.length > 0 && openingFence(first) !== null) {
      // B-151: with no id to stand alone on line 1, property lines after line 1 sit inside the
      // fence it opens and re-parse as code — `ids: "none"` text (copy, `block.update`'s
      // before-text) silently lost the block's properties. `block-text.ts#joinBlockText`'s
      // placements instead: after the content once every fence in it has closed (the parser takes
      // a property line wherever it sits outside a fence); otherwise before the fence opens — a
      // task's head alone on line 1 (OUT-14's form without the id, B-310), else the bullet line.
      if (fencesClosed(contentLines)) {
        out.push(`${indent}- ${[head, first].filter((s) => s !== "").join(" ")}`);
        out.push(...contentLines.slice(1).map(contLine), ...props.map(contLine));
      } else if (head !== "") {
        out.push(`${indent}- ${head}`, ...props.map(contLine), ...contentLines.map(contLine));
      } else {
        out.push(`${indent}- ${props[0]}`, ...props.slice(1).map(contLine));
        out.push(...contentLines.map(contLine));
      }
    } else {
      let firstLine = [head, first].filter((s) => s !== "").join(" ");
      if (suffixId !== undefined) {
        firstLine = firstLine === "" ? `^${suffixId}` : `${firstLine} ^${suffixId}`;
      }
      out.push(firstLine === "" ? `${indent}-` : `${indent}- ${firstLine}`);
      out.push(...props.map(contLine), ...contentLines.slice(1).map(contLine));
    }
    for (const child of node.children) walk(child, level + 1);
  };

  for (const node of page.blocks) walk(node, 0);
  return `${out.join("\n")}\n`;
}

/** Whether a block's content lines leave no fence open at the end — the parser's own fence
 * tracking, so a property line written after them is read as a property rather than as code. */
function fencesClosed(lines: readonly string[]): boolean {
  let fence: string | null = null;
  for (const line of lines) {
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null;
    } else {
      fence = openingFence(line);
    }
  }
  return fence === null;
}

/** The parser's own line rules, for `block-text.ts` — which splits one block's raw editing text
 * the way `finalizeNode` does. Re-exported rather than copied so the two can never disagree about
 * what a property line or a fence is. */
export {
  closesFence as closesCodeFence,
  normalizePropertyKey,
  openingFence as openingCodeFence,
  PROPERTY_RE as PROPERTY_LINE_RE,
};

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
