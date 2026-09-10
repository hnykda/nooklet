/**
 * Logseq-compatible outline markdown: text <-> tree of OutlineNode.
 *
 * File format (what Logseq writes, and what we write):
 *
 *   title:: Page Title            <- optional page properties ("pre-block"), no bullet
 *
 *   - first block                 <- one bullet per block; children indented by one tab
 *     id:: 66f0...                <- block properties as `key:: value` lines after the first line
 *     second line of the block    <- continuation lines: block indent + 2 spaces
 *   	- TODO child block         <- task marker (and optional [#A] priority) at line start
 *   	  collapsed:: true
 *   	  ```js
 *   	  - not a bullet: inside a fence
 *   	  ```
 *
 * Parsing is indentation-width based (tab = 4 columns), so 2-space and 4-space
 * indented files import as well. Serialization always writes tabs, like Logseq.
 */

import type { OutlineNode, ParsedPage, Priority, Properties, TaskMarker } from "./model.js";

const TAB_WIDTH = 4;
const BULLET_RE = /^([\t ]*)-(?: (.*))?$/;
const FENCE_RE = /^(`{3,}|~{3,})/;
const PROPERTY_RE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):: ?(.*)$/;
const MARKER_RE =
  /^(TODO|DOING|DONE|LATER|NOW|WAITING|WAIT|CANCELED|CANCELLED|IN-PROGRESS)(?=\s|$)/;
const PRIORITY_RE = /^\[#([ABC])\](?=\s|$)/;
const FRONT_MATTER_LINE_RE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):\s*(.*)$/;

const MARKER_ALIASES: Record<string, TaskMarker> = {
  WAIT: "WAITING",
  CANCELLED: "CANCELED",
  "IN-PROGRESS": "DOING",
};

interface RawNode {
  width: number;
  lines: string[];
  children: RawNode[];
  bullet: boolean;
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

/** Opening fence: line starts with ``` or ~~~ and the same fence does not close on the same line. */
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

  // YAML front matter (older Logseq graphs / other tools)
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

  const startNode = (width: number, firstLine: string, bullet: boolean): void => {
    while (stack.length > 0 && (stack[stack.length - 1] as RawNode).width >= width) stack.pop();
    const node: RawNode = { width, lines: [firstLine], children: [], bullet };
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

    // Plain paragraph (no bullet) at this indentation: becomes its own block.
    startNode(w, line.slice(ws.length), false);
  }

  const nodes = roots.map(finalizeNode);

  // Pre-block: a leading property-only block holds the page properties.
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

function finalizeNode(raw: RawNode): OutlineNode {
  const properties: Properties = {};
  const kept: string[] = [];
  let id: string | undefined;
  let collapsed = false;
  let fence: string | null = null;
  let firstKeptWasFirstLine = false;

  raw.lines.forEach((line, idx) => {
    if (fence !== null) {
      kept.push(line);
      if (closesFence(line, fence)) fence = null;
      return;
    }
    const pm = PROPERTY_RE.exec(line);
    if (pm) {
      const key = (pm[1] as string).toLowerCase();
      const value = (pm[2] as string).trim();
      if (key === "id") id = value;
      else if (key === "collapsed") collapsed = value === "true";
      else properties[key] = value;
      return;
    }
    if (kept.length === 0 && idx === 0) firstKeptWasFirstLine = true;
    kept.push(line);
    fence = openingFence(line);
  });

  let marker: TaskMarker | null = null;
  let priority: Priority | null = null;
  if (firstKeptWasFirstLine && kept.length > 0) {
    let first = kept[0] as string;
    const mm = MARKER_RE.exec(first);
    if (mm) {
      const raw = mm[1] as string;
      marker = MARKER_ALIASES[raw] ?? (raw as TaskMarker);
      first = first.slice(raw.length).trimStart();
    }
    const pm = PRIORITY_RE.exec(first);
    if (pm) {
      priority = pm[1] as Priority;
      first = first.slice(pm[0].length).trimStart();
    }
    kept[0] = first;
  }

  while (kept.length > 0 && (kept[kept.length - 1] as string).trim() === "") kept.pop();
  const content = kept.join("\n").replace(/[ \t]+$/gm, (m) => (m.length ? "" : m));

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
  /** Indent unit for nesting. Logseq writes tabs. */
  indent?: "\t" | "  " | "    ";
  /** Which nodes get an `id::` line: nodes that have an id (default) or none. */
  ids?: "present" | "none";
}

/** Tree -> Logseq-compatible markdown text. */
export function serializeOutline(page: ParsedPage, opts: SerializeOptions = {}): string {
  const indentUnit = opts.indent ?? "\t";
  const writeIds = opts.ids !== "none";
  const out: string[] = [];

  const pageProps = Object.entries(page.properties);
  if (pageProps.length > 0) {
    for (const [k, v] of pageProps) out.push(`${k}:: ${v}`);
  }

  const walk = (node: OutlineNode, level: number): void => {
    const indent = indentUnit.repeat(level);
    const cont = `${indent}  `;
    const head = [node.marker, node.priority ? `[#${node.priority}]` : null]
      .filter((s): s is string => s !== null)
      .join(" ");
    const contentLines = node.content === "" ? [] : node.content.split("\n");
    const first = contentLines[0] ?? "";
    const firstLine = [head, first].filter((s) => s !== "").join(" ");
    out.push(firstLine === "" ? `${indent}-` : `${indent}- ${firstLine}`);

    const props: Array<[string, string]> = [];
    if (writeIds && node.id) props.push(["id", node.id]);
    if (node.collapsed) props.push(["collapsed", "true"]);
    for (const [k, v] of Object.entries(node.properties)) props.push([k, v]);
    for (const [k, v] of props) out.push(`${cont}${k}:: ${v}`);

    for (const rest of contentLines.slice(1)) out.push(rest === "" ? "" : `${cont}${rest}`);
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
