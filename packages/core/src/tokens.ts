/**
 * Inline tokenizer and block-content classifier (`docs/spec/markdown-grammar.md`).
 *
 * `tokenizeLine` is a single left-to-right, non-backtracking scan per physical line (INL-2):
 * unknown or malformed syntax always falls back to plain text, never an error. It is used
 * both as the top-level entry point and recursively for the interior of every nesting token
 * (strong/em/strike/highlight, link labels, wikilink targets).
 *
 * `classifyBlockContent` classifies a block's whole `content` string (§2.7) into exactly one
 * of paragraph/heading/fence/quote/table/hr and tokenizes accordingly. `tokenizeContent` is
 * the flat, `br`-joined convenience view of a paragraph/quote block used by the corpus and by
 * the (future) token-based `refs.ts` refactor.
 *
 * This file intentionally re-implements (rather than imports) a few small helpers that also
 * exist, unexported, in `refs.ts` (`findClosingBrackets`, `findBacktickRun`, the tag
 * preceder/stop/trailing sets, the block-ref UUID pattern): `refs.ts` is out of scope for this
 * change and must not be modified or given new exports.
 */

import { isId } from "./ids.js";

/** 0-based, half-open, UTF-16 code unit offset into the string that was tokenized. */
export type Offset = number;

interface TokBase {
  start: Offset;
  end: Offset;
}

export type InlineToken =
  | (TokBase & { kind: "text" })
  | (TokBase & { kind: "br" })
  | (TokBase & { kind: "escape"; char: string })
  | (TokBase & {
      kind: "wikilink";
      target: string;
      targetStart: Offset;
      targetEnd: Offset;
      alias?: string;
      nested?: InlineToken[]; // kind: "wikilink", recursively
    })
  | (TokBase & { kind: "tag"; name: string; multiWord: boolean })
  | (TokBase & { kind: "blockRef"; id: string })
  | (TokBase & {
      kind: "embed";
      target: { kind: "page"; name: string } | { kind: "block"; id: string } | null;
    })
  | (TokBase & { kind: "macro"; name: string; args: string })
  | (TokBase & { kind: "linkToPage"; target: string; label: InlineToken[] })
  | (TokBase & { kind: "linkToBlock"; id: string; label: InlineToken[] })
  | (TokBase & { kind: "link"; href: string; label: InlineToken[] })
  | (TokBase & { kind: "autolink"; href: string })
  | (TokBase & { kind: "image"; alt: string; src: string })
  | (TokBase & { kind: "strong"; children: InlineToken[] })
  | (TokBase & { kind: "em"; children: InlineToken[] })
  | (TokBase & { kind: "strike"; children: InlineToken[] })
  | (TokBase & { kind: "highlight"; children: InlineToken[] })
  | (TokBase & { kind: "code"; code: string })
  /** `display` is present (and true) only for `$$…$$`, Logseq's display form (B-264). */
  | (TokBase & { kind: "math"; tex: string; display?: true })
  | (TokBase & { kind: "checkbox"; checked: boolean });

export type Align = "left" | "center" | "right" | null;

export type BlockContent =
  | {
      kind: "paragraph";
      lines: InlineToken[][];
      /** Index of `lines[0]` among the content's lines, when not 0 (a `mixed` part). */
      firstLine?: number;
    }
  | {
      kind: "heading";
      level: 1 | 2 | 3 | 4 | 5 | 6;
      title: InlineToken[];
      trailing?: InlineToken[][];
    }
  | { kind: "fence"; lang: string; code: string }
  | { kind: "quote"; lines: InlineToken[][] }
  | { kind: "table"; align: Align[]; header: InlineToken[][]; rows: InlineToken[][][] }
  | { kind: "hr" }
  /** Prose with one or more tables in it, in order (CLS-T). */
  | {
      kind: "mixed";
      parts: (
        | Extract<BlockContent, { kind: "paragraph" }>
        | Extract<BlockContent, { kind: "table" }>
      )[];
    };

// ---------------------------------------------------------------------------------------------
// Shared constants (mirroring refs.ts's private constants; kept in sync by hand, refs.ts §8/9).
// ---------------------------------------------------------------------------------------------

/** ESC: backslash-escapable characters (§2.8-ESC). */
const ESCAPABLE = new Set([
  "\\",
  "[",
  "]",
  "(",
  ")",
  "{",
  "}",
  "#",
  "*",
  "_",
  "~",
  "=",
  "`",
  "$",
  "|",
  "<",
  ">",
  "!",
  "^",
]);

const TAG_STOP = new Set([" ", "\t", ",", ";", ")", "]", "}", "'", '"']);
const TAG_PRECEDER = new Set([" ", "\t", "(", ",", ";", "[", "{", '"', "'"]);
const TAG_TRAILING = /[.!?:]+$/;
/** Logseq UUID pattern (refs.ts's UUID_BODY, not ids.ts's stricter v4-only isUuid). */
const UUID_BODY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTOLINK_TRAIL = new Set([".", ",", ";", ":", "!", "?", "'", '"', ")", "]"]);
const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR_RE.test(ch);
}

// ---------------------------------------------------------------------------------------------
// Small scanning primitives, reused across several token kinds.
// ---------------------------------------------------------------------------------------------

/** Index of the "]]" closing the "[[" opened before `from`, honoring nesting; -1 if none. */
function findClosingBrackets(text: string, from: number): number {
  let depth = 1;
  for (let i = from; i < text.length - 1; i++) {
    if (text[i] === "[" && text[i + 1] === "[") {
      depth++;
      i++;
    } else if (text[i] === "]" && text[i + 1] === "]") {
      depth--;
      if (depth === 0) return i;
      i++;
    }
  }
  return -1;
}

/**
 * Index of a single balanced "]" opened before `from` (depth counting single brackets).
 * Unlike `findClosingBrackets` (wikilinks, unchanged refs.ts behavior), this helper backs a
 * wholly new construct (link labels), so it honors ESC (§2.8): an escaped `\]`/`\[` never
 * affects the depth count (escaping is legal inside link labels, §6).
 */
function findClosingBracket(text: string, from: number): number {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length) {
      i++;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Index of a single balanced ")" opened before `from` (depth counting single parens, ESC-aware). */
function findClosingParen(text: string, from: number): number {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length) {
      i++;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findBacktickRun(text: string, from: number, len: number): number {
  let i = from;
  while (i < text.length) {
    if (text[i] === "`") {
      let run = 1;
      while (text[i + run] === "`") run++;
      if (run === len) return i;
      i += run;
    } else i++;
  }
  return -1;
}

/** Index of the first "|" at bracket-depth 0 (honoring nested [[...]]); -1 if none. */
export function findTopLevelPipe(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "[" && text[i + 1] === "[") {
      depth++;
      i++;
      continue;
    }
    if (text[i] === "]" && text[i + 1] === "]") {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (text[i] === "|" && depth === 0) return i;
  }
  return -1;
}

/** First run of `ch` at or after `from` whose length is >= `minLen`; skips shorter runs. */
function findRunClose(
  text: string,
  from: number,
  ch: string,
  minLen: number,
): { start: number; len: number } | null {
  let j = from;
  while (j < text.length) {
    if (text[j] === ch) {
      let len = 1;
      while (text[j + len] === ch) len++;
      if (len >= minLen) return { start: j, len };
      j += len;
    } else j++;
  }
  return null;
}

/** First *isolated* (run length exactly 1) occurrence of `ch` at or after `from`; skips longer runs. */
function findLoneRun(text: string, from: number, ch: string): number {
  let j = from;
  while (j < text.length) {
    if (text[j] === ch) {
      let len = 1;
      while (text[j + len] === ch) len++;
      if (len === 1) return j;
      j += len;
    } else j++;
  }
  return -1;
}

/** A complete, balanced `[label](href)` starting at `text[i] === "["`. Indices are local to `text`. */
function tryBracketParen(
  text: string,
  i: number,
): { label: string; labelStart: number; href: string; end: number } | null {
  const labelEnd = findClosingBracket(text, i + 1);
  if (labelEnd === -1) return null;
  if (text[labelEnd + 1] !== "(") return null;
  const hrefStart = labelEnd + 2;
  const hrefEnd = findClosingParen(text, hrefStart);
  if (hrefEnd === -1) return null;
  return {
    label: text.slice(i + 1, labelEnd),
    labelStart: i + 1,
    href: text.slice(hrefStart, hrefEnd),
    end: hrefEnd + 1,
  };
}

/** `href` is exactly a `[[...]]` shape (nothing else) -> trimmed inner target text, else null. */
function exactWikilinkTarget(href: string): string | null {
  if (!href.startsWith("[[") || !href.endsWith("]]")) return null;
  const end = findClosingBrackets(href, 2);
  if (end === -1 || end + 2 !== href.length) return null;
  return href.slice(2, end).trim();
}

/** `href` is exactly a `((...))` shape (nothing else) -> trimmed inner id text, else null. */
function exactBlockRefId(href: string): string | null {
  if (!href.startsWith("((") || !href.endsWith("))")) return null;
  const end = href.indexOf("))", 2);
  if (end === -1 || end + 2 !== href.length) return null;
  return href.slice(2, end).trim();
}

function parseEmbedTarget(
  rest: string,
): { kind: "page"; name: string } | { kind: "block"; id: string } | null {
  const page = exactWikilinkTarget(rest);
  if (page !== null) return { kind: "page", name: page };
  const block = exactBlockRefId(rest);
  if (block !== null) return { kind: "block", id: block };
  return null;
}

/** A complete `[[target]]` / `[[target|alias]]` starting at `text[i..i+1] === "[["`. */
function tryWikilink(
  text: string,
  i: number,
  base: Offset,
): { token: Extract<InlineToken, { kind: "wikilink" }>; nextI: number } | null {
  const end = findClosingBrackets(text, i + 2);
  if (end === -1) return null;
  const inner = text.slice(i + 2, end);
  const pipeIdx = findTopLevelPipe(inner);
  const rawTarget = pipeIdx === -1 ? inner : inner.slice(0, pipeIdx);
  const rawAlias = pipeIdx === -1 ? null : inner.slice(pipeIdx + 1);
  const nested = findNestedWikilinks(rawTarget, base + i + 2);
  const token: Extract<InlineToken, { kind: "wikilink" }> = {
    kind: "wikilink",
    start: base + i,
    end: base + end + 2,
    target: rawTarget.trim(),
    targetStart: base + i + 2,
    targetEnd: base + end,
  };
  if (rawAlias !== null) token.alias = rawAlias.trim();
  if (nested.length > 0) token.nested = nested;
  return { token, nextI: end + 2 };
}

/** Complete `[[...]]` occurrences found strictly inside `text` (§2.9 wikilink "nested"). */
function findNestedWikilinks(text: string, base: Offset): InlineToken[] {
  const out: InlineToken[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "[" && text[i + 1] === "[") {
      const r = tryWikilink(text, i, base);
      if (r) {
        out.push(r.token);
        i = r.nextI;
        continue;
      }
    }
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// tokenizeLine
// ---------------------------------------------------------------------------------------------

/** One physical line, no `\n`. Offsets are relative to `base` (§3). */
export function tokenizeLine(line: string, base: Offset = 0): InlineToken[] {
  const out: InlineToken[] = [];
  const n = line.length;
  let textStart = 0;
  let i = 0;

  const flushText = (end: number): void => {
    if (end > textStart) {
      out.push({ kind: "text", start: base + textStart, end: base + end });
    }
  };

  while (i < n) {
    const ch = line[i] as string;

    if (ch === "\\") {
      const next = line[i + 1];
      if (next !== undefined && ESCAPABLE.has(next)) {
        flushText(i);
        out.push({ kind: "escape", start: base + i, end: base + i + 2, char: next });
        i += 2;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }

    if (ch === "`") {
      let run = 1;
      while (line[i + run] === "`") run++;
      const closeIdx = findBacktickRun(line, i + run, run);
      if (closeIdx !== -1) {
        let code = line.slice(i + run, closeIdx);
        if (
          code.length > 0 &&
          code[0] === " " &&
          code[code.length - 1] === " " &&
          /\S/.test(code)
        ) {
          code = code.slice(1, -1);
        }
        flushText(i);
        out.push({ kind: "code", start: base + i, end: base + closeIdx + run, code });
        i = closeIdx + run;
        textStart = i;
        continue;
      }
      // No closer on the line (INL-2 fallback, refs.ts precedent): skip the whole opening run.
      i += run;
      continue;
    }

    if (ch === "[") {
      if (line[i + 1] === "[") {
        const wl = tryWikilink(line, i, base);
        if (wl) {
          flushText(i);
          out.push(wl.token);
          i = wl.nextI;
          textStart = i;
          continue;
        }
      }
      const bp = tryBracketParen(line, i);
      if (bp) {
        flushText(i);
        const label = tokenizeLine(bp.label, base + bp.labelStart);
        const wikiTarget = exactWikilinkTarget(bp.href);
        const blockId = wikiTarget === null ? exactBlockRefId(bp.href) : null;
        if (wikiTarget !== null) {
          out.push({
            kind: "linkToPage",
            start: base + i,
            end: base + bp.end,
            target: wikiTarget,
            label,
          });
        } else if (blockId !== null) {
          out.push({
            kind: "linkToBlock",
            start: base + i,
            end: base + bp.end,
            id: blockId,
            label,
          });
        } else {
          out.push({ kind: "link", start: base + i, end: base + bp.end, href: bp.href, label });
        }
        i = bp.end;
        textStart = i;
        continue;
      }
      const c1 = line[i + 1];
      if ((c1 === " " || c1 === "x" || c1 === "X") && line[i + 2] === "]") {
        flushText(i);
        out.push({ kind: "checkbox", start: base + i, end: base + i + 3, checked: c1 !== " " });
        i += 3;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }

    if (ch === "!" && line[i + 1] === "[") {
      const bp = tryBracketParen(line, i + 1);
      if (bp) {
        flushText(i);
        out.push({
          kind: "image",
          start: base + i,
          end: base + bp.end,
          alt: bp.label,
          src: bp.href,
        });
        i = bp.end;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }

    if (ch === "(" && line[i + 1] === "(") {
      const end = line.indexOf("))", i + 2);
      if (end !== -1) {
        const inner = line.slice(i + 2, end).trim();
        if (isId(inner) || UUID_BODY.test(inner)) {
          flushText(i);
          out.push({ kind: "blockRef", start: base + i, end: base + end + 2, id: inner });
          i = end + 2;
          textStart = i;
          continue;
        }
      }
      i++;
      continue;
    }

    if (ch === "{" && line[i + 1] === "{") {
      const end = line.indexOf("}}", i + 2);
      if (end !== -1) {
        const trimmedInner = line.slice(i + 2, end).trim();
        let sp = 0;
        while (sp < trimmedInner.length && !/\s/.test(trimmedInner[sp] as string)) sp++;
        const name = trimmedInner.slice(0, sp);
        const rest = trimmedInner.slice(sp).trim();
        flushText(i);
        if (name === "embed") {
          out.push({
            kind: "embed",
            start: base + i,
            end: base + end + 2,
            target: parseEmbedTarget(rest),
          });
        } else {
          out.push({ kind: "macro", start: base + i, end: base + end + 2, name, args: rest });
        }
        i = end + 2;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }

    if (ch === "#") {
      const isPreceder = i === 0 || TAG_PRECEDER.has(line[i - 1] as string);
      if (isPreceder) {
        const next = line[i + 1];
        if (next === "[" && line[i + 2] === "[") {
          const end = findClosingBrackets(line, i + 3);
          if (end !== -1) {
            const name = line.slice(i + 3, end).trim();
            flushText(i);
            out.push({
              kind: "tag",
              start: base + i,
              end: base + end + 2,
              name,
              multiWord: true,
            });
            i = end + 2;
            textStart = i;
            continue;
          }
        } else if (next !== undefined && next !== "#" && next !== "+" && !TAG_STOP.has(next)) {
          let j = i + 1;
          while (j < n && !TAG_STOP.has(line[j] as string)) j++;
          const raw = line.slice(i + 1, j);
          const trimmed = raw.replace(TAG_TRAILING, "");
          const tokenEnd = i + 1 + trimmed.length;
          flushText(i);
          out.push({
            kind: "tag",
            start: base + i,
            end: base + tokenEnd,
            name: trimmed,
            multiWord: false,
          });
          i = tokenEnd;
          textStart = i;
          continue;
        }
      }
      i++;
      continue;
    }

    if (ch === "~" && line[i + 1] === "~") {
      const closeIdx = line.indexOf("~~", i + 2);
      if (closeIdx !== -1) {
        flushText(i);
        const children = tokenizeLine(line.slice(i + 2, closeIdx), base + i + 2);
        out.push({ kind: "strike", start: base + i, end: base + closeIdx + 2, children });
        i = closeIdx + 2;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }

    if (ch === "=" && line[i + 1] === "=") {
      const closeIdx = line.indexOf("==", i + 2);
      if (closeIdx !== -1) {
        flushText(i);
        const children = tokenizeLine(line.slice(i + 2, closeIdx), base + i + 2);
        out.push({ kind: "highlight", start: base + i, end: base + closeIdx + 2, children });
        i = closeIdx + 2;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }

    if (ch === "*") {
      let run = 1;
      while (line[i + run] === "*") run++;
      if (run >= 2) {
        const close = findRunClose(line, i + run, "*", 2);
        if (close) {
          flushText(i);
          const children = tokenizeLine(line.slice(i + run, close.start), base + i + run);
          out.push({
            kind: "strong",
            start: base + i,
            end: base + close.start + close.len,
            children,
          });
          i = close.start + close.len;
          textStart = i;
          continue;
        }
      } else {
        // A run of exactly 1 closes: skip over any run >= 2 along the way (that's a nested
        // strong's delimiter, not this em's closer), matching "*text **bold** more*" recursion.
        const closeIdx = findLoneRun(line, i + 1, "*");
        if (closeIdx !== -1) {
          flushText(i);
          const children = tokenizeLine(line.slice(i + 1, closeIdx), base + i + 1);
          out.push({ kind: "em", start: base + i, end: base + closeIdx + 1, children });
          i = closeIdx + 1;
          textStart = i;
          continue;
        }
      }
      i++;
      continue;
    }

    if (ch === "_") {
      const prev = i > 0 ? (line[i - 1] as string) : undefined;
      if (!isWordChar(prev)) {
        let j = i + 1;
        let closeIdx = -1;
        while (j < n) {
          if (line[j] === "_" && !isWordChar(line[j + 1])) {
            closeIdx = j;
            break;
          }
          j++;
        }
        if (closeIdx !== -1) {
          flushText(i);
          const children = tokenizeLine(line.slice(i + 1, closeIdx), base + i + 1);
          out.push({ kind: "em", start: base + i, end: base + closeIdx + 1, children });
          i = closeIdx + 1;
          textStart = i;
          continue;
        }
      }
      i++;
      continue;
    }

    if (ch === "$" && line[i + 1] === "$") {
      // Display math `$$tex$$` — Logseq's syntax, and on the owner's graph (`$$CO_2$$`). Without
      // this the second `$` opened inline math and the fourth was left as a stray dollar (B-264).
      // The closer keeps the inline rule's price guard (not followed by a digit), so
      // `$$5 and $$10` stays text; an unclosed or empty `$$` falls through to the inline rules.
      const closeIdx = line.indexOf("$$", i + 2);
      const tex = closeIdx === -1 ? "" : line.slice(i + 2, closeIdx);
      const after = closeIdx === -1 ? undefined : line[closeIdx + 2];
      if (tex.trim() !== "" && (after === undefined || !/[0-9]/.test(after))) {
        flushText(i);
        out.push({ kind: "math", start: base + i, end: base + closeIdx + 2, tex, display: true });
        i = closeIdx + 2;
        textStart = i;
        continue;
      }
    }

    if (ch === "$") {
      const next = line[i + 1];
      if (next !== undefined && !/\s/.test(next) && next !== "$") {
        const closeIdx = line.indexOf("$", i + 1);
        if (closeIdx !== -1) {
          const before = line[closeIdx - 1] as string;
          const after = line[closeIdx + 1];
          const beforeOk = !/\s/.test(before);
          const afterOk = after === undefined || !/[0-9]/.test(after);
          if (beforeOk && afterOk) {
            flushText(i);
            out.push({
              kind: "math",
              start: base + i,
              end: base + closeIdx + 1,
              tex: line.slice(i + 1, closeIdx),
            });
            i = closeIdx + 1;
            textStart = i;
            continue;
          }
        }
      }
      i++;
      continue;
    }

    if (ch === "h" && (line.startsWith("http://", i) || line.startsWith("https://", i))) {
      let j = i;
      while (j < n && !/\s/.test(line[j] as string)) j++;
      let end = j;
      while (end > i && AUTOLINK_TRAIL.has(line[end - 1] as string)) end--;
      if (end > i) {
        flushText(i);
        out.push({ kind: "autolink", start: base + i, end: base + end, href: line.slice(i, end) });
        i = end;
        textStart = i;
        continue;
      }
    }

    i++;
  }

  flushText(n);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Block content classification (§2.7)
// ---------------------------------------------------------------------------------------------

const FENCE_OPEN_RE = /^(`{3,}|~{3,})/;
const HEADING_RE = /^(#{1,6}) (.*)$/;
const HR_RE = /^(-{3,}|\*{3,}|_{3,})$/;
const DELIM_ROW_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** Opening fence marker for line 1 (unchanged rule from outline.ts's `openingFence`). */
function openingFenceMarker(line: string): string | null {
  const m = FENCE_OPEN_RE.exec(line);
  if (!m) return null;
  const fence = m[1] as string;
  const rest = line.slice(fence.length);
  if (rest.includes(fence[0] as string)) return null;
  return fence;
}

/** Closing fence line per CLS-F: trimmed text is *only* a run of the fence char, length >= opener's. */
function fenceCloseRunLength(line: string, fenceChar: string, minLen: number): number {
  const t = line.replace(/^[ \t]+/, "");
  let i = 0;
  while (t[i] === fenceChar) i++;
  if (i < minLen) return 0;
  return t.slice(i).trim() === "" ? i : 0;
}

function classifyFence(content: string): BlockContent | null {
  const lines = content.split("\n");
  const first = lines[0] as string;
  const fence = openingFenceMarker(first);
  if (fence === null) return null;
  const fenceChar = fence[0] as string;
  const lang = first.slice(fence.length).trim();
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (fenceCloseRunLength(lines[i] as string, fenceChar, fence.length) > 0) {
      closeIdx = i;
      break;
    }
  }
  const codeLines = closeIdx === -1 ? lines.slice(1) : lines.slice(1, closeIdx);
  return { kind: "fence", lang, code: codeLines.join("\n") };
}

function classifyHeading(content: string): BlockContent | null {
  const lines = content.split("\n");
  const first = lines[0] as string;
  const m = HEADING_RE.exec(first);
  if (!m) return null;
  const hashes = m[1] as string;
  const level = hashes.length as 1 | 2 | 3 | 4 | 5 | 6;
  const prefixLen = hashes.length + 1;
  const title = tokenizeLine(m[2] as string, prefixLen);
  const result: BlockContent = { kind: "heading", level, title };
  if (lines.length > 1) {
    const trailing: InlineToken[][] = [];
    let base = first.length + 1;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i] as string;
      trailing.push(tokenizeLine(line, base));
      base += line.length + 1;
    }
    (result as Extract<BlockContent, { kind: "heading" }>).trailing = trailing;
  }
  return result;
}

function classifyQuote(content: string): BlockContent | null {
  const lines = content.split("\n");
  let hasQuoteLine = false;
  for (const line of lines) {
    if (line === "") continue;
    if (!line.startsWith(">")) return null;
    hasQuoteLine = true;
  }
  if (!hasQuoteLine) return null;

  const outLines: InlineToken[][] = [];
  let base = 0;
  for (const line of lines) {
    let prefixLen = 0;
    if (line.startsWith(">")) {
      prefixLen = line[1] === " " ? 2 : 1;
    }
    outLines.push(tokenizeLine(line.slice(prefixLen), base + prefixLen));
    base += line.length + 1;
  }
  return { kind: "quote", lines: outLines };
}

interface TableCell {
  text: string;
  /** Offset of `text` within its row line. */
  start: number;
}

/**
 * Split a table row on unescaped `|`, trim cells, and drop the optional outer pipes.
 *
 * Each cell keeps its offset within the line, because inline tokens are offsets into the block's
 * whole `content` and the renderer slices `content` with them. Tokenizing every cell at offset 0
 * made each cell of `| a | b |` render `content[0..1]`, the leading `|` (B-702).
 */
function splitTableRow(line: string): TableCell[] {
  const raw: TableCell[] = [];
  let cellStart = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (ch === "\\" && i + 1 < line.length) {
      i++;
      continue;
    }
    if (ch === "|") {
      raw.push({ text: line.slice(cellStart, i), start: cellStart });
      cellStart = i + 1;
    }
  }
  raw.push({ text: line.slice(cellStart), start: cellStart });
  const cells = raw.map((c) => {
    const lead = c.text.length - c.text.trimStart().length;
    return { text: c.text.trim(), start: c.start + lead };
  });
  if (cells.length > 0 && cells[0]?.text === "" && line.trimStart().startsWith("|")) cells.shift();
  if (cells.length > 0 && cells[cells.length - 1]?.text === "" && line.trimEnd().endsWith("|")) {
    cells.pop();
  }
  return cells;
}

function cellAlign(cell: string): Align {
  const t = cell.trim();
  const left = t.startsWith(":");
  const right = t.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

type TableContent = Extract<BlockContent, { kind: "table" }>;
type ParagraphContent = Extract<BlockContent, { kind: "paragraph" }>;

/**
 * The GFM table whose header row is `lines[at]`, or `null`. `bases[i]` is line i's offset in the
 * whole content. The table runs until the first blank line, line without a `|`, or the end.
 */
function tableAt(
  lines: readonly string[],
  bases: readonly number[],
  at: number,
): { table: TableContent; end: number } | null {
  const headLine = lines[at];
  const delimLine = lines[at + 1];
  if (headLine === undefined || delimLine === undefined) return null;
  if (!headLine.includes("|") || !delimLine.includes("|")) return null;
  if (!DELIM_ROW_RE.test(delimLine)) return null;
  const header = splitTableRow(headLine);
  const delims = splitTableRow(delimLine);
  // GFM: the header and delimiter rows must agree; body rows need not (see below).
  if (delims.length !== header.length || header.length === 0) return null;
  const width = header.length;

  const tokenizeRow = (cells: TableCell[], lineBase: number): InlineToken[][] =>
    cells.map((c) => tokenizeLine(c.text, lineBase + c.start));

  const rows: InlineToken[][][] = [];
  let end = at + 2;
  for (; end < lines.length; end++) {
    const line = lines[end] as string;
    if (line.trim() === "" || !line.includes("|")) break;
    // GFM ragged rows: a short row is padded with empty cells, a long row's excess is dropped
    // from the rendering (the stored text is untouched, so nothing is lost from the mirror).
    const cells = tokenizeRow(splitTableRow(line).slice(0, width), bases[end] as number);
    while (cells.length < width) cells.push([]);
    rows.push(cells);
  }
  return {
    table: {
      kind: "table",
      align: delims.map((d) => cellAlign(d.text)),
      header: tokenizeRow(header, bases[at] as number),
      rows,
    },
    end,
  };
}

/**
 * CLS-T: a block that is one table, or prose with tables in it. The second is the shape every
 * table in a real Logseq graph had (B-702): a line of prose, a blank line, then the table — and
 * requiring the table to start on line 1 rendered all of them as pipes. Blank lines next to a
 * table only separate it from the prose and are not rendered.
 */
function classifyTables(content: string): BlockContent | null {
  if (!content.includes("|")) return null;
  const lines = content.split("\n");
  const bases: number[] = [];
  let pos = 0;
  for (const line of lines) {
    bases.push(pos);
    pos += line.length + 1;
  }
  const parts: (ParagraphContent | TableContent)[] = [];
  let pending: number[] = []; // line indexes of the prose run being collected
  const flush = (): void => {
    while (pending.length > 0 && (lines[pending.at(-1) as number] as string).trim() === "") {
      pending.pop();
    }
    if (pending.length > 0) {
      const first = pending[0] as number;
      parts.push({
        kind: "paragraph",
        lines: pending.map((i) => tokenizeLine(lines[i] as string, bases[i])),
        ...(first > 0 ? { firstLine: first } : {}),
      });
    }
    pending = [];
  };
  let afterTable = false;
  for (let i = 0; i < lines.length; ) {
    const found = tableAt(lines, bases, i);
    if (found) {
      flush();
      parts.push(found.table);
      i = found.end;
      afterTable = true;
      continue;
    }
    if (!(afterTable && pending.length === 0 && (lines[i] as string).trim() === "")) {
      pending.push(i);
    }
    i++;
  }
  if (parts.length === 0) return null;
  flush();
  if (parts.length === 1 && parts[0]?.kind === "table") return parts[0];
  return { kind: "mixed", parts };
}

function classifyHr(content: string): BlockContent | null {
  if (content.includes("\n")) return null;
  return HR_RE.test(content) ? { kind: "hr" } : null;
}

function classifyParagraph(content: string): BlockContent {
  const lines = content.split("\n");
  const outLines: InlineToken[][] = [];
  let base = 0;
  for (const line of lines) {
    outLines.push(tokenizeLine(line, base));
    base += line.length + 1;
  }
  return { kind: "paragraph", lines: outLines };
}

/** Classifies `content` (§2.7) and tokenizes it. Never throws. */
export function classifyBlockContent(content: string): BlockContent {
  return (
    classifyFence(content) ??
    classifyHeading(content) ??
    classifyQuote(content) ??
    classifyTables(content) ??
    classifyHr(content) ??
    classifyParagraph(content)
  );
}

/**
 * The flat inline token stream for a paragraph- or quote-classified block, offsets into the
 * whole `content` string, `br` tokens inserted at every `\n`. `[]` for fence/table/hr/heading.
 */
export function tokenizeContent(content: string): InlineToken[] {
  let bc = classifyBlockContent(content);
  // A snippet of prose-with-a-table (search hit, backlink, block ref) stays the one inline run it
  // was before tables inside prose were recognized; a table can't be laid out inline anyway.
  if (bc.kind === "mixed") bc = classifyParagraph(content);
  if (bc.kind !== "paragraph" && bc.kind !== "quote") return [];

  const rawLines = content.split("\n");
  const out: InlineToken[] = [];
  let pos = 0;
  for (let i = 0; i < bc.lines.length; i++) {
    out.push(...(bc.lines[i] as InlineToken[]));
    pos += (rawLines[i] as string).length;
    if (i < bc.lines.length - 1) {
      out.push({ kind: "br", start: pos, end: pos + 1 });
      pos += 1;
    }
  }
  return out;
}
