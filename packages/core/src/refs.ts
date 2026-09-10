/**
 * Reference extraction from block content and properties.
 *
 *   [[Page Name]]        -> pageRefs
 *   #tag  #[[multi word]] -> tags (tags are also page refs, kept separately for display)
 *   ((uuid))             -> blockRefs
 *   {{embed [[x]]}} / {{embed ((uuid))}} are covered by the rules above.
 *
 * Text inside inline code spans and fenced code blocks is ignored.
 * Property values: `tags::` and `alias::` are comma-separated lists;
 * other values contribute their [[refs]] and #tags.
 */

import type { Properties } from "./model.js";

export interface ExtractedRefs {
  pageRefs: string[];
  tags: string[];
  blockRefs: string[];
}

const UUID_BODY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const TAG_STOP = new Set([" ", "\t", "\n", ",", ";", ")", "]", "}", "'", '"']);
const TAG_PRECEDER = new Set([" ", "\t", "\n", "(", ",", ";", "[", "{", '"', "'"]);
const TAG_TRAILING = /[.!?:]+$/;

class RefSet {
  readonly pageRefs = new Set<string>();
  readonly tags = new Set<string>();
  readonly blockRefs = new Set<string>();

  toResult(): ExtractedRefs {
    return {
      pageRefs: [...this.pageRefs],
      tags: [...this.tags],
      blockRefs: [...this.blockRefs],
    };
  }
}

export function extractRefs(content: string, properties: Properties = {}): ExtractedRefs {
  const acc = new RefSet();
  scanText(content, acc, true);
  for (const [key, value] of Object.entries(properties)) {
    if (key === "tags" || key === "alias") {
      for (const item of splitList(value)) {
        const name = unwrapRef(item);
        if (name === "") continue;
        if (key === "tags") acc.tags.add(name);
        else acc.pageRefs.add(name);
      }
    } else {
      scanText(value, acc, false);
    }
  }
  return acc.toResult();
}

/** Split a comma-separated property value, respecting [[a, b]] brackets. */
export function splitList(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "[") depth++;
    else if (ch === "]") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out.filter((s) => s.length > 0);
}

function unwrapRef(s: string): string {
  let t = s.trim();
  if (t.startsWith("#")) t = t.slice(1);
  if (t.startsWith("[[") && t.endsWith("]]")) t = t.slice(2, -2);
  return t.trim();
}

function scanText(text: string, acc: RefSet, allowFences: boolean): void {
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    if (fence !== null) {
      if (line.trimStart().startsWith(fence)) fence = null;
      continue;
    }
    if (allowFences) {
      const fm = FENCE_RE.exec(line);
      if (fm) {
        fence = fm[1] as string;
        continue;
      }
    }
    scanLine(line, acc);
  }
}

function scanLine(line: string, acc: RefSet): void {
  const n = line.length;
  let i = 0;
  while (i < n) {
    const ch = line[i] as string;

    if (ch === "`") {
      let run = 1;
      while (line[i + run] === "`") run++;
      const close = findBacktickRun(line, i + run, run);
      i = close === -1 ? i + run : close + run;
      continue;
    }

    if (ch === "[" && line[i + 1] === "[") {
      const end = findClosingBrackets(line, i + 2);
      if (end !== -1) {
        const inner = line.slice(i + 2, end);
        addPageRef(acc, inner);
        i = end + 2;
        continue;
      }
    }

    if (ch === "(" && line[i + 1] === "(") {
      const end = line.indexOf("))", i + 2);
      if (end !== -1) {
        const inner = line.slice(i + 2, end).trim();
        if (UUID_BODY.test(inner)) {
          acc.blockRefs.add(inner.toLowerCase());
          i = end + 2;
          continue;
        }
      }
    }

    if (ch === "#" && (i === 0 || TAG_PRECEDER.has(line[i - 1] as string))) {
      const next = line[i + 1];
      if (next === "[" && line[i + 2] === "[") {
        const end = findClosingBrackets(line, i + 3);
        if (end !== -1) {
          const inner = line.slice(i + 3, end).trim();
          if (inner !== "") acc.tags.add(inner);
          i = end + 2;
          continue;
        }
      } else if (next !== undefined && next !== "#" && next !== "+" && !TAG_STOP.has(next)) {
        let j = i + 1;
        while (j < n && !TAG_STOP.has(line[j] as string)) j++;
        const tag = line.slice(i + 1, j).replace(TAG_TRAILING, "");
        if (tag !== "") acc.tags.add(tag);
        i = j;
        continue;
      }
    }

    i++;
  }
}

function addPageRef(acc: RefSet, inner: string): void {
  const name = inner.trim();
  if (name === "") return;
  acc.pageRefs.add(name);
  // nested refs like [[a [[b]]]]
  if (name.includes("[[")) scanLine(name, acc);
}

/** Index of the "]]" closing the "[[" opened before `from`, honoring nesting; -1 if none. */
function findClosingBrackets(line: string, from: number): number {
  let depth = 1;
  for (let i = from; i < line.length - 1; i++) {
    if (line[i] === "[" && line[i + 1] === "[") {
      depth++;
      i++;
    } else if (line[i] === "]" && line[i + 1] === "]") {
      depth--;
      if (depth === 0) return i;
      i++;
    }
  }
  return -1;
}

function findBacktickRun(line: string, from: number, len: number): number {
  let i = from;
  while (i < line.length) {
    if (line[i] === "`") {
      let run = 1;
      while (line[i + run] === "`") run++;
      if (run === len) return i;
      i += run;
    } else i++;
  }
  return -1;
}
