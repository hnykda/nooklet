/**
 * The ```` ```query ```` fence language (ADR 011, amended 2026-09-12): one compact filter syntax
 * over blocks, written as whitespace-separated terms —
 *
 *     TODO tag:work scheduled:<=today sort:deadline
 *     (marker:open or done:>=-7d) and [[Project X]] not #someday
 *
 * — parsed here into a small boolean AST, matched against one block at a time (`matchQuery`),
 * sorted (`compareForQuery`) and, for the client's SQLite replica, compiled into a *necessary*
 * SQL condition (`queryPrefilter`) that narrows the candidate rows before the exact JavaScript
 * predicate runs. Three pure functions, no I/O, no date "now" read anywhere — the caller passes
 * `today` so results are reproducible in tests and identical on every device.
 *
 * Why a filter language and not Logseq's Datalog: research/13 §2.2 — queries are the forum's
 * largest help topic precisely because the built-in syntax is hard; task queries dominate what
 * people actually write. Why the prefilter is only "necessary", never "sufficient": the client
 * schema has no `ref` table (docs/spec/sql-schema.md rule 1), so tag/ref matching must read the
 * block's text (`extractRefs`) — SQL can only say which rows *might* contain a reference.
 *
 * Never throws: malformed input is a `{ ok: false, error }` with the offending span, so the
 * renderer can say what is wrong in words rather than crash a page.
 */

import { addDays, addMonths, addWeeks, addYears } from "date-fns";
import { dateToJournalDay, journalDayToDate } from "./journal.js";
import type { Priority, Properties, TaskMarker } from "./model.js";
import { normalizePageName } from "./page-name.js";
import { extractRefs } from "./refs.js";

// ---------------------------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------------------------

export type DateExpr =
  | { kind: "abs"; day: number }
  | { kind: "rel"; n: number; unit: "d" | "w" | "m" | "y" };

export type DateCmp =
  | { op: "none" }
  | { op: "any" }
  | { op: "eq" | "lt" | "le" | "gt" | "ge"; value: DateExpr }
  | { op: "between"; from: DateExpr; to: DateExpr };

export type DateField =
  | "scheduled"
  | "deadline"
  | "due"
  | "done"
  | "created"
  | "updated"
  | "journal";

export type QueryTerm =
  /** `marker:TODO,DOING`, `marker:open|closed|any|none`, or a bare `TODO`. Empty `values` with
   * `mode` set covers the any/none forms. */
  | { kind: "marker"; values: TaskMarker[]; mode: "list" | "any" | "none" }
  | { kind: "priority"; values: Priority[]; mode: "list" | "any" | "none" }
  /** `tag:x`, `ref:x`, bare `#x`, bare `[[x]]`: the block references page `x` — via `#x`,
   * `#[[x]]`, `[[x]]`, `[label]([[x]])`, or a `tags::` property line. */
  | { kind: "ref"; name: string }
  | { kind: "page"; name: string }
  | { kind: "namespace"; name: string }
  | { kind: "journal"; value: boolean }
  | { kind: "date"; field: DateField; cmp: DateCmp }
  /** Case-insensitive substring of the block's content. */
  | { kind: "text"; value: string }
  /** `prop:key` (has the property) or `prop:key=value` (case-insensitive equality). */
  | { kind: "prop"; key: string; value?: string };

export type QueryExpr =
  | { kind: "and"; items: QueryExpr[] }
  | { kind: "or"; items: QueryExpr[] }
  | { kind: "not"; item: QueryExpr }
  | { kind: "term"; term: QueryTerm; start: number; end: number };

export type SortField = "due" | "scheduled" | "deadline" | "done" | "created" | "updated" | "priority" | "page";

export interface Query {
  where: QueryExpr;
  sort: { field: SortField; dir: "asc" | "desc" };
  /** `limit:N`; `null` = no limit requested (the renderer applies its own display cap). */
  limit: number | null;
}

export interface QueryError {
  message: string;
  /** Offsets into the query text (UTF-16 units, half-open). */
  start: number;
  end: number;
}

export type ParseQueryResult = { ok: true; query: Query } | { ok: false; error: QueryError };

/** Every `key:` a query may use, for error messages and docs. */
export const QUERY_KEYS = [
  "marker",
  "priority",
  "tag",
  "ref",
  "page",
  "namespace",
  "journal",
  "scheduled",
  "deadline",
  "due",
  "done",
  "created",
  "updated",
  "text",
  "prop",
  "sort",
  "limit",
] as const;

const KEY_ALIASES: Record<string, (typeof QUERY_KEYS)[number]> = {
  task: "marker",
  todo: "marker",
  prio: "priority",
  ns: "namespace",
  content: "text",
  property: "prop",
};

const MARKER_ALIASES: Record<string, TaskMarker> = {
  WAIT: "WAITING",
  CANCELLED: "CANCELED",
  "IN-PROGRESS": "DOING",
};

const CANONICAL_MARKERS: readonly TaskMarker[] = [
  "TODO",
  "DOING",
  "LATER",
  "NOW",
  "WAITING",
  "DONE",
  "CANCELED",
];

export const OPEN_MARKERS: readonly TaskMarker[] = ["TODO", "DOING", "LATER", "NOW", "WAITING"];
export const CLOSED_MARKERS: readonly TaskMarker[] = ["DONE", "CANCELED"];

const SORT_FIELDS: readonly SortField[] = [
  "due",
  "scheduled",
  "deadline",
  "done",
  "created",
  "updated",
  "priority",
  "page",
];

const DEFAULT_SORT: Query["sort"] = { field: "due", dir: "asc" };

// ---------------------------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------------------------

type Tok =
  | { kind: "lparen" | "rparen" | "and" | "or" | "not"; start: number; end: number }
  | {
      kind: "word";
      /** `key` of a `key:value` term, lowercased; absent for a bare term. */
      key?: string;
      /** The value/bare text with quotes and `[[ ]]` removed. */
      value: string;
      /** How the value was written — decides bare-word sugar (`#x`, `[[x]]`, `TODO`). */
      form: "raw" | "quoted" | "bracketed" | "tag";
      start: number;
      end: number;
    };

class LexError extends Error {
  constructor(
    message: string,
    readonly start: number,
    readonly end: number,
  ) {
    super(message);
  }
}

function isSpace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r";
}

function isWordEnd(c: string | undefined): boolean {
  return c === undefined || isSpace(c) || c === "(" || c === ")";
}

const KEY_RE = /^([A-Za-z][A-Za-z0-9_-]*):/;

function lex(text: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = text.length;

  /** A `"..."` run starting at `i` (which must be the opening quote). Returns the inner text
   * and leaves `i` after the closing quote. */
  const readQuoted = (): string => {
    const open = i;
    i++;
    let out = "";
    while (i < n) {
      const c = text[i] as string;
      if (c === "\\" && i + 1 < n) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') {
        i++;
        return out;
      }
      out += c;
      i++;
    }
    throw new LexError("unterminated \" quote", open, n);
  };

  /** A `[[...]]` run starting at `i`. Returns the inner text, trimmed. */
  const readBracketed = (): string => {
    const open = i;
    const close = text.indexOf("]]", i + 2);
    if (close === -1) throw new LexError("unterminated [[ reference", open, n);
    const inner = text.slice(i + 2, close).trim();
    i = close + 2;
    return inner;
  };

  /** A raw run up to whitespace/paren; a `"` inside it (`prop:type="a b"`) splices in a quoted
   * segment, a `[[` splices in a bracketed one. */
  const readRaw = (): { value: string; quoted: boolean } => {
    let out = "";
    let quoted = false;
    while (!isWordEnd(text[i])) {
      const c = text[i] as string;
      if (c === '"') {
        out += readQuoted();
        quoted = true;
        continue;
      }
      if (c === "[" && text[i + 1] === "[") {
        out += readBracketed();
        quoted = true;
        continue;
      }
      out += c;
      i++;
    }
    return { value: out, quoted };
  };

  while (i < n) {
    const c = text[i] as string;
    if (isSpace(c)) {
      i++;
      continue;
    }
    const start = i;
    if (c === "(") {
      toks.push({ kind: "lparen", start, end: ++i });
      continue;
    }
    if (c === ")") {
      toks.push({ kind: "rparen", start, end: ++i });
      continue;
    }
    // `-term` / `-(...)` is `not`. A `-` followed by a digit is left to the word reader so a
    // stray `-7d` fails as an unknown filter rather than negating a text search for "7d"; a
    // dangling `-` is a `not` with nothing after it, which the parser reports as such.
    if (c === "-" && !/[0-9]/.test(text[i + 1] ?? "")) {
      toks.push({ kind: "not", start, end: ++i });
      continue;
    }
    if (c === '"') {
      const value = readQuoted();
      toks.push({ kind: "word", value, form: "quoted", start, end: i });
      continue;
    }
    if (c === "[" && text[i + 1] === "[") {
      const value = readBracketed();
      toks.push({ kind: "word", value, form: "bracketed", start, end: i });
      continue;
    }
    if (c === "#") {
      i++;
      let value: string;
      if (text[i] === "[" && text[i + 1] === "[") value = readBracketed();
      else value = readRaw().value;
      toks.push({ kind: "word", value, form: "tag", start, end: i });
      continue;
    }
    const keyMatch = KEY_RE.exec(text.slice(i));
    if (keyMatch) {
      const key = (keyMatch[1] as string).toLowerCase();
      i += keyMatch[0].length;
      let value: string;
      let form: "raw" | "quoted" | "bracketed" = "raw";
      if (text[i] === '"') {
        value = readQuoted();
        form = "quoted";
      } else if (text[i] === "[" && text[i + 1] === "[") {
        value = readBracketed();
        form = "bracketed";
      } else {
        const r = readRaw();
        value = r.value;
        if (r.quoted) form = "quoted";
      }
      toks.push({ kind: "word", key, value, form, start, end: i });
      continue;
    }
    const raw = readRaw();
    const lower = raw.value.toLowerCase();
    if (!raw.quoted && (lower === "and" || lower === "or" || lower === "not")) {
      toks.push({ kind: lower, start, end: i });
      continue;
    }
    toks.push({ kind: "word", value: raw.value, form: raw.quoted ? "quoted" : "raw", start, end: i });
  }
  return toks;
}

// ---------------------------------------------------------------------------------------------
// Term parsing
// ---------------------------------------------------------------------------------------------

class TermError extends Error {}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const REL_DATE_RE = /^([+-])(\d+)([dwmy])$/;

function parseDateExpr(raw: string): DateExpr {
  const s = raw.toLowerCase();
  if (s === "today") return { kind: "rel", n: 0, unit: "d" };
  if (s === "tomorrow") return { kind: "rel", n: 1, unit: "d" };
  if (s === "yesterday") return { kind: "rel", n: -1, unit: "d" };
  const rel = REL_DATE_RE.exec(s);
  if (rel) {
    const n = Number(rel[2]) * (rel[1] === "-" ? -1 : 1);
    return { kind: "rel", n, unit: rel[3] as "d" | "w" | "m" | "y" };
  }
  const abs = ISO_DATE_RE.exec(s);
  if (abs) {
    const day = Number(abs[1]) * 10000 + Number(abs[2]) * 100 + Number(abs[3]);
    if (dateToJournalDay(journalDayToDate(day)) !== day) throw new TermError(`"${raw}" is not a real date`);
    return { kind: "abs", day };
  }
  throw new TermError(
    `"${raw}" is not a date — use today, tomorrow, yesterday, YYYY-MM-DD, or +7d / -2w / +1m / -1y`,
  );
}

function parseDateCmp(raw: string): DateCmp {
  const s = raw.trim();
  if (s === "") throw new TermError("expected a date after the colon");
  const lower = s.toLowerCase();
  if (lower === "none") return { op: "none" };
  if (lower === "any") return { op: "any" };
  const range = s.split("..");
  if (range.length === 2) {
    return { op: "between", from: parseDateExpr(range[0] as string), to: parseDateExpr(range[1] as string) };
  }
  if (range.length > 2) throw new TermError(`"${raw}" has more than one ".."`);
  let op: "eq" | "lt" | "le" | "gt" | "ge" = "eq";
  let rest = s;
  if (s.startsWith("<=")) {
    op = "le";
    rest = s.slice(2);
  } else if (s.startsWith(">=")) {
    op = "ge";
    rest = s.slice(2);
  } else if (s.startsWith("<")) {
    op = "lt";
    rest = s.slice(1);
  } else if (s.startsWith(">")) {
    op = "gt";
    rest = s.slice(1);
  } else if (s.startsWith("=")) {
    rest = s.slice(1);
  }
  return { op, value: parseDateExpr(rest) };
}

function parseMarkerList(raw: string): QueryTerm {
  const s = raw.trim();
  if (s === "") throw new TermError("expected a task state after marker:, e.g. marker:TODO");
  const lower = s.toLowerCase();
  if (lower === "any") return { kind: "marker", values: [], mode: "any" };
  if (lower === "none") return { kind: "marker", values: [], mode: "none" };
  const values: TaskMarker[] = [];
  for (const part of s.split(",")) {
    const p = part.trim();
    if (p === "") continue;
    const pl = p.toLowerCase();
    if (pl === "open") {
      values.push(...OPEN_MARKERS);
      continue;
    }
    if (pl === "closed") {
      values.push(...CLOSED_MARKERS);
      continue;
    }
    const m = markerFromWord(p.toUpperCase());
    if (!m) {
      throw new TermError(
        `"${p}" is not a task state — use ${CANONICAL_MARKERS.join(", ")}, open, closed, any or none`,
      );
    }
    values.push(m);
  }
  return { kind: "marker", values: [...new Set(values)], mode: "list" };
}

function markerFromWord(word: string): TaskMarker | undefined {
  if ((CANONICAL_MARKERS as readonly string[]).includes(word)) return word as TaskMarker;
  return MARKER_ALIASES[word];
}

function parsePriorityList(raw: string): QueryTerm {
  const s = raw.trim();
  if (s === "") throw new TermError("expected A, B or C after priority:");
  const lower = s.toLowerCase();
  if (lower === "any") return { kind: "priority", values: [], mode: "any" };
  if (lower === "none") return { kind: "priority", values: [], mode: "none" };
  const values: Priority[] = [];
  for (const part of s.split(",")) {
    const p = part.trim().toUpperCase();
    if (p === "") continue;
    if (p !== "A" && p !== "B" && p !== "C") throw new TermError(`"${part}" is not a priority — use A, B or C`);
    values.push(p);
  }
  return { kind: "priority", values: [...new Set(values)], mode: "list" };
}

function stripRefSyntax(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("#")) s = s.slice(1);
  if (s.startsWith("[[") && s.endsWith("]]")) s = s.slice(2, -2);
  return s.trim();
}

function normalizePropKey(key: string): string {
  return key.trim().toLowerCase().replace(/_/g, "-");
}

interface Modifiers {
  sort?: Query["sort"];
  limit?: number;
}

/** A word token -> a term, or `null` when the word was a modifier (`sort:`/`limit:`) that was
 * recorded into `mods` instead. Throws `TermError` for anything malformed. */
function parseWord(tok: Extract<Tok, { kind: "word" }>, mods: Modifiers): QueryTerm | null {
  if (tok.key === undefined) {
    switch (tok.form) {
      case "tag":
      case "bracketed": {
        const name = stripRefSyntax(tok.value);
        if (name === "") throw new TermError("empty reference");
        return { kind: "ref", name };
      }
      case "quoted":
        if (tok.value === "") throw new TermError("empty quoted text");
        return { kind: "text", value: tok.value };
      default: {
        const marker = markerFromWord(tok.value);
        // Bare `TODO`/`DONE`/… (uppercase, as written in a block) is marker sugar; lowercase
        // `done` stays a text search so the sugar never swallows an ordinary word.
        if (marker && tok.value === tok.value.toUpperCase()) {
          return { kind: "marker", values: [marker], mode: "list" };
        }
        return { kind: "text", value: tok.value };
      }
    }
  }

  const key = KEY_ALIASES[tok.key] ?? tok.key;
  const value = tok.value;
  const need = (what: string): string => {
    if (value.trim() === "") throw new TermError(`expected ${what} after ${tok.key}:`);
    return value.trim();
  };
  switch (key) {
    case "marker":
      return parseMarkerList(value);
    case "priority":
      return parsePriorityList(value);
    case "tag":
    case "ref": {
      const name = stripRefSyntax(need("a tag or page name"));
      if (name === "") throw new TermError(`expected a tag or page name after ${tok.key}:`);
      return { kind: "ref", name };
    }
    case "page":
      return { kind: "page", name: stripRefSyntax(need("a page name")) };
    case "namespace":
      return { kind: "namespace", name: stripRefSyntax(need("a namespace")) };
    case "journal": {
      const v = need("true, false or a date comparison").toLowerCase();
      if (v === "true" || v === "yes") return { kind: "journal", value: true };
      if (v === "false" || v === "no") return { kind: "journal", value: false };
      return { kind: "date", field: "journal", cmp: parseDateCmp(v) };
    }
    case "scheduled":
    case "deadline":
    case "due":
    case "done":
    case "created":
    case "updated":
      return { kind: "date", field: key, cmp: parseDateCmp(value) };
    case "text":
      return { kind: "text", value: need("text to search for") };
    case "prop": {
      const v = need("a property key, e.g. prop:type=book");
      const eq = v.indexOf("=");
      if (eq === -1) {
        const k = normalizePropKey(v);
        if (k === "") throw new TermError("expected a property key after prop:");
        return { kind: "prop", key: k };
      }
      const k = normalizePropKey(v.slice(0, eq));
      if (k === "") throw new TermError("expected a property key before =");
      return { kind: "prop", key: k, value: v.slice(eq + 1).trim() };
    }
    case "sort": {
      let v = need("a field to sort by").toLowerCase();
      let dir: "asc" | "desc" = "asc";
      if (v.startsWith("-")) {
        dir = "desc";
        v = v.slice(1);
      }
      if (v.endsWith(":desc")) {
        dir = "desc";
        v = v.slice(0, -5);
      } else if (v.endsWith(":asc")) {
        v = v.slice(0, -4);
      }
      if (!(SORT_FIELDS as readonly string[]).includes(v)) {
        throw new TermError(`cannot sort by "${v}" — use ${SORT_FIELDS.join(", ")}`);
      }
      mods.sort = { field: v as SortField, dir };
      return null;
    }
    case "limit": {
      const v = need("a number");
      if (!/^[1-9]\d*$/.test(v)) throw new TermError(`limit: needs a positive whole number, not "${v}"`);
      mods.limit = Number(v);
      return null;
    }
    default:
      throw new TermError(`unknown filter "${tok.key}:" — known: ${QUERY_KEYS.join(", ")}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Expression parsing: or-expr := and-expr ("or" and-expr)*; and-expr := unary ("and"? unary)*;
// unary := ("not" | "-") unary | "(" or-expr ")" | term. Juxtaposition is `and`; `not` binds
// tightest, then `and`, then `or` — the usual reading of "TODO tag:work or DOING".
// ---------------------------------------------------------------------------------------------

class ParseError extends Error {
  constructor(
    message: string,
    readonly start: number,
    readonly end: number,
  ) {
    super(message);
  }
}

class Parser {
  private pos = 0;
  readonly mods: Modifiers = {};

  constructor(
    private readonly toks: Tok[],
    private readonly textLength: number,
  ) {}

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }

  private eofSpan(): { start: number; end: number } {
    const last = this.toks[this.toks.length - 1];
    return last ? { start: last.end, end: last.end } : { start: this.textLength, end: this.textLength };
  }

  parseOr(): QueryExpr | null {
    const items: QueryExpr[] = [];
    const first = this.parseAnd();
    if (first) items.push(first);
    for (;;) {
      const t = this.peek();
      if (!t || t.kind !== "or") break;
      this.pos++;
      if (items.length === 0) throw new ParseError('"or" needs a filter before it', t.start, t.end);
      const rhs = this.parseAnd();
      if (!rhs) {
        const next = this.peek();
        throw new ParseError('"or" needs a filter after it', t.start, next ? next.end : t.end);
      }
      items.push(rhs);
    }
    if (items.length === 0) return null;
    return items.length === 1 ? (items[0] as QueryExpr) : { kind: "or", items };
  }

  private parseAnd(): QueryExpr | null {
    const items: QueryExpr[] = [];
    for (;;) {
      const t = this.peek();
      if (!t || t.kind === "rparen" || t.kind === "or") break;
      if (t.kind === "and") {
        this.pos++;
        if (items.length === 0) throw new ParseError('"and" needs a filter before it', t.start, t.end);
        const rhs = this.parseUnary();
        if (!rhs) throw new ParseError('"and" needs a filter after it', t.start, t.end);
        items.push(rhs);
        continue;
      }
      const u = this.parseUnary();
      if (u) items.push(u);
    }
    if (items.length === 0) return null;
    return items.length === 1 ? (items[0] as QueryExpr) : { kind: "and", items };
  }

  /** `null` only when the token was a modifier (consumed into `mods`). */
  private parseUnary(): QueryExpr | null {
    const t = this.peek();
    if (!t) return null;
    if (t.kind === "not") {
      this.pos++;
      const inner = this.parseUnary();
      if (!inner) {
        const next = this.peek();
        throw new ParseError('"not" needs a filter after it', t.start, next ? next.end : t.end);
      }
      return { kind: "not", item: inner };
    }
    if (t.kind === "lparen") {
      this.pos++;
      const inner = this.parseOr();
      const close = this.peek();
      if (!close || close.kind !== "rparen") {
        throw new ParseError("missing closing )", t.start, this.eofSpan().end);
      }
      this.pos++;
      if (!inner) throw new ParseError("empty parentheses", t.start, close.end);
      return inner;
    }
    if (t.kind === "rparen") throw new ParseError("unexpected )", t.start, t.end);
    if (t.kind === "and" || t.kind === "or") {
      throw new ParseError(`"${t.kind}" needs a filter before it`, t.start, t.end);
    }
    this.pos++;
    try {
      const term = parseWord(t, this.mods);
      if (term === null) return null;
      return { kind: "term", term, start: t.start, end: t.end };
    } catch (e) {
      if (e instanceof TermError) throw new ParseError(e.message, t.start, t.end);
      throw e;
    }
  }

  atEnd(): boolean {
    return this.pos >= this.toks.length;
  }

  current(): Tok | undefined {
    return this.peek();
  }
}

export function parseQuery(text: string): ParseQueryResult {
  try {
    const toks = lex(text);
    const parser = new Parser(toks, text.length);
    const where = parser.parseOr();
    if (!parser.atEnd()) {
      const t = parser.current() as Tok;
      throw new ParseError(t.kind === "rparen" ? "unexpected )" : "unexpected input", t.start, t.end);
    }
    if (!where) {
      return {
        ok: false,
        error: {
          message: "empty query — add a filter such as TODO, tag:work or [[Some Page]]",
          start: 0,
          end: text.length,
        },
      };
    }
    return {
      ok: true,
      query: { where, sort: parser.mods.sort ?? DEFAULT_SORT, limit: parser.mods.limit ?? null },
    };
  } catch (e) {
    if (e instanceof ParseError || e instanceof LexError) {
      return { ok: false, error: { message: e.message, start: e.start, end: e.end } };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

/** Resolve a date expression against `today` (YYYYMMDD, the device's local calendar day). */
export function resolveQueryDate(expr: DateExpr, today: number): number {
  if (expr.kind === "abs") return expr.day;
  if (expr.n === 0) return today;
  const base = journalDayToDate(today);
  switch (expr.unit) {
    case "d":
      return dateToJournalDay(addDays(base, expr.n));
    case "w":
      return dateToJournalDay(addWeeks(base, expr.n));
    case "m":
      return dateToJournalDay(addMonths(base, expr.n));
    case "y":
      return dateToJournalDay(addYears(base, expr.n));
  }
}

/** Epoch ms -> local calendar day. Default for `QueryEnv.epochToDay`. */
export function epochToLocalDay(ms: number): number {
  return dateToJournalDay(new Date(ms));
}

export interface QueryEnv {
  /** YYYYMMDD. */
  today: number;
  /** How epoch-ms columns (`done_at`, `created_at`, `updated_at`) map to a calendar day; defaults
   * to the local timezone. Tests pass a UTC version for determinism. */
  epochToDay?: (ms: number) => number;
}

function dayMatches(cmp: DateCmp, day: number | null, today: number): boolean {
  switch (cmp.op) {
    case "none":
      return day === null;
    case "any":
      return day !== null;
    case "between": {
      if (day === null) return false;
      const from = resolveQueryDate(cmp.from, today);
      const to = resolveQueryDate(cmp.to, today);
      return day >= Math.min(from, to) && day <= Math.max(from, to);
    }
    default: {
      if (day === null) return false;
      const v = resolveQueryDate(cmp.value, today);
      switch (cmp.op) {
        case "eq":
          return day === v;
        case "lt":
          return day < v;
        case "le":
          return day <= v;
        case "gt":
          return day > v;
        case "ge":
          return day >= v;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------

/** What `matchQuery` needs to know about one block — a `BlockRow` joined with its page, plus its
 * `block_prop` rows. Kept structural (no class) so any row shape can be adapted. */
export interface QueryBlock {
  id: string;
  content: string;
  marker: TaskMarker | null;
  priority: Priority | null;
  scheduledDay: number | null;
  deadlineDay: number | null;
  dueDay: number | null;
  doneAt: number | null;
  createdAt: number;
  updatedAt: number;
  pageName: string;
  /** `normalizePageName(pageName)`; computed when absent. */
  pageKey?: string;
  pageJournalDay: number | null;
  properties: Properties;
}

function pageKeyOf(b: QueryBlock): string {
  return b.pageKey ?? normalizePageName(b.pageName);
}

function dateFieldValue(field: DateField, b: QueryBlock, env: QueryEnv): number | null {
  const toDay = env.epochToDay ?? epochToLocalDay;
  switch (field) {
    case "scheduled":
      return b.scheduledDay;
    case "deadline":
      return b.deadlineDay;
    case "due":
      return b.dueDay;
    case "done":
      return b.doneAt === null ? null : toDay(b.doneAt);
    case "created":
      return toDay(b.createdAt);
    case "updated":
      return toDay(b.updatedAt);
    case "journal":
      return b.pageJournalDay;
  }
}

/** Every page the block references, normalized — tags and `[[links]]` are the same thing here
 * (a tag is a page, ADR 004), so `tag:work` finds `#work` and `[[work]]` alike. */
function refKeys(b: QueryBlock): Set<string> {
  const refs = extractRefs(b.content, b.properties);
  const out = new Set<string>();
  for (const r of refs.tags) out.add(normalizePageName(r));
  for (const r of refs.pageRefs) out.add(normalizePageName(r));
  return out;
}

function matchTerm(term: QueryTerm, b: QueryBlock, env: QueryEnv, refs: () => Set<string>): boolean {
  switch (term.kind) {
    case "marker":
      if (term.mode === "any") return b.marker !== null;
      if (term.mode === "none") return b.marker === null;
      return b.marker !== null && term.values.includes(b.marker);
    case "priority":
      if (term.mode === "any") return b.priority !== null;
      if (term.mode === "none") return b.priority === null;
      return b.priority !== null && term.values.includes(b.priority);
    case "ref":
      return refs().has(normalizePageName(term.name));
    case "page":
      return pageKeyOf(b) === normalizePageName(term.name);
    case "namespace": {
      const ns = normalizePageName(term.name);
      const key = pageKeyOf(b);
      return key === ns || key.startsWith(`${ns}/`);
    }
    case "journal":
      return (b.pageJournalDay !== null) === term.value;
    case "date":
      return dayMatches(term.cmp, dateFieldValue(term.field, b, env), env.today);
    case "text":
      return b.content.toLowerCase().includes(term.value.toLowerCase());
    case "prop": {
      const v = b.properties[term.key];
      if (v === undefined) return false;
      if (term.value === undefined) return true;
      return v.trim().toLowerCase() === term.value.toLowerCase();
    }
  }
}

export function matchQuery(expr: QueryExpr, block: QueryBlock, env: QueryEnv): boolean {
  // Reference extraction is the one non-trivial cost per block; compute it at most once per
  // block per evaluation, and only if a `ref` term is actually reached.
  let refs: Set<string> | undefined;
  const lazyRefs = (): Set<string> => {
    if (!refs) refs = refKeys(block);
    return refs;
  };
  const go = (e: QueryExpr): boolean => {
    switch (e.kind) {
      case "and":
        return e.items.every(go);
      case "or":
        return e.items.some(go);
      case "not":
        return !go(e.item);
      case "term":
        return matchTerm(e.term, block, env, lazyRefs);
    }
  };
  return go(expr);
}

// ---------------------------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------------------------

const PRIORITY_RANK: Record<Priority, number> = { A: 0, B: 1, C: 2 };

function sortKey(field: SortField, b: QueryBlock, env: QueryEnv): number | string | null {
  switch (field) {
    case "priority":
      return b.priority === null ? null : PRIORITY_RANK[b.priority];
    case "page":
      return null; // the tiebreak below IS the page order
    default:
      return dateFieldValue(field, b, env);
  }
}

/** Page order used to break ties (and as the whole order for `sort:page`): journals first,
 * newest first — the capture surface, where the freshest material is — then other pages A→Z. */
function comparePages(a: QueryBlock, b: QueryBlock): number {
  const aj = a.pageJournalDay;
  const bj = b.pageJournalDay;
  if (aj !== null && bj !== null) return bj - aj;
  if (aj !== null) return -1;
  if (bj !== null) return 1;
  return pageKeyOf(a).localeCompare(pageKeyOf(b));
}

/** A comparator for `Array.prototype.sort`: the query's `sort` field (nulls always last,
 * whichever direction), then page order, then `tiebreak` (the caller's within-page order —
 * normally the block's `order_key`, which this module has no column for). */
export function compareForQuery(
  sort: Query["sort"],
  env: QueryEnv,
  tiebreak: (a: QueryBlock, b: QueryBlock) => number = () => 0,
): (a: QueryBlock, b: QueryBlock) => number {
  return (a, b) => {
    const ka = sortKey(sort.field, a, env);
    const kb = sortKey(sort.field, b, env);
    if (ka !== kb) {
      if (ka === null) return 1;
      if (kb === null) return -1;
      const c = ka < kb ? -1 : 1;
      return sort.dir === "desc" ? -c : c;
    }
    const p = comparePages(a, b);
    if (p !== 0) return p;
    return tiebreak(a, b);
  };
}

// ---------------------------------------------------------------------------------------------
// SQL prefilter for the client replica (`block b JOIN page p`, docs/spec/sql-schema.md)
// ---------------------------------------------------------------------------------------------

export interface QueryPrefilter {
  /** A boolean SQL expression over aliases `b` (block) and `p` (page). Every row `matchQuery`
   * would accept satisfies it; rows it accepts still need `matchQuery`. */
  sql: string;
  params: unknown[];
  /** True when `sql` is the *whole* predicate (no `ref`/`text`/`prop`/epoch-day terms), i.e.
   * `matchQuery` cannot reject anything the SQL accepted. */
  exact: boolean;
}

const DATE_COLUMNS: Partial<Record<DateField, string>> = {
  scheduled: "b.scheduled_day",
  deadline: "b.deadline_day",
  due: "b.due_day",
  journal: "p.journal_day",
};

/**
 * Every fragment is written to be two-valued — never NULL — because `NOT` sits above it: in SQL,
 * `NOT (marker IN ('TODO') AND scheduled_day = 20260912)` is NULL, not TRUE, for a row whose
 * `scheduled_day` is NULL, and a NULL in a WHERE clause drops the row. The JavaScript predicate
 * says that row matches. So every comparison on a nullable column is guarded with `IS NOT NULL`.
 */
function dateCmpSql(column: string, cmp: DateCmp, today: number): QueryPrefilter {
  switch (cmp.op) {
    case "none":
      return { sql: `${column} IS NULL`, params: [], exact: true };
    case "any":
      return { sql: `${column} IS NOT NULL`, params: [], exact: true };
    case "between": {
      const from = resolveQueryDate(cmp.from, today);
      const to = resolveQueryDate(cmp.to, today);
      return {
        sql: `(${column} IS NOT NULL AND ${column} BETWEEN ? AND ?)`,
        params: [Math.min(from, to), Math.max(from, to)],
        exact: true,
      };
    }
    default: {
      const op = { eq: "=", lt: "<", le: "<=", gt: ">", ge: ">=" }[cmp.op];
      return {
        sql: `(${column} IS NOT NULL AND ${column} ${op} ?)`,
        params: [resolveQueryDate(cmp.value, today)],
        exact: true,
      };
    }
  }
}

function isAscii(s: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the range is the point — ASCII only
  return /^[\x00-\x7f]*$/.test(s);
}

function inList(column: string, values: readonly string[]): QueryPrefilter {
  if (values.length === 0) return { sql: "0", params: [], exact: true };
  return {
    sql: `(${column} IS NOT NULL AND ${column} IN (${values.map(() => "?").join(",")}))`,
    params: [...values],
    exact: true,
  };
}

function termSql(term: QueryTerm, today: number): QueryPrefilter {
  switch (term.kind) {
    case "marker":
      if (term.mode === "any") return { sql: "b.marker IS NOT NULL", params: [], exact: true };
      if (term.mode === "none") return { sql: "b.marker IS NULL", params: [], exact: true };
      return inList("b.marker", term.values);
    case "priority":
      if (term.mode === "any") return { sql: "b.priority IS NOT NULL", params: [], exact: true };
      if (term.mode === "none") return { sql: "b.priority IS NULL", params: [], exact: true };
      return inList("b.priority", term.values);
    case "ref":
      // Anything that can carry a reference: a `#`, a `[[`, or a `tags::` property. Necessary,
      // not sufficient — `extractRefs` decides for real (code spans, escapes, the exact name).
      return {
        sql:
          "(instr(b.content, '#') > 0 OR instr(b.content, '[[') > 0 OR EXISTS " +
          "(SELECT 1 FROM block_prop bp WHERE bp.block_id = b.id AND bp.key = 'tags'))",
        params: [],
        exact: false,
      };
    case "page":
      return { sql: "p.key = ?", params: [normalizePageName(term.name)], exact: true };
    case "namespace": {
      const ns = normalizePageName(term.name);
      return {
        sql: "(p.key = ? OR substr(p.key, 1, ?) = ?)",
        params: [ns, ns.length + 1, `${ns}/`],
        exact: true,
      };
    }
    case "journal":
      return {
        sql: term.value ? "p.journal_day IS NOT NULL" : "p.journal_day IS NULL",
        params: [],
        exact: true,
      };
    case "date": {
      const column = DATE_COLUMNS[term.field];
      if (column) return dateCmpSql(column, term.cmp, today);
      // Epoch-ms columns: the calendar day depends on the device's timezone, which SQL cannot
      // see — only null-ness is safe to push down.
      if (term.field === "done") {
        if (term.cmp.op === "none") return { sql: "b.done_at IS NULL", params: [], exact: true };
        return { sql: "b.done_at IS NOT NULL", params: [], exact: false };
      }
      return { sql: "1", params: [], exact: false };
    }
    case "text":
      // SQLite's lower() folds ASCII only, so a needle with any other letter cannot be matched
      // case-insensitively in SQL; leave those to JavaScript.
      if (!isAscii(term.value)) return { sql: "1", params: [], exact: false };
      return {
        sql: "instr(lower(b.content), ?) > 0",
        params: [term.value.toLowerCase()],
        exact: false,
      };
    case "prop":
      return {
        sql: "EXISTS (SELECT 1 FROM block_prop bp WHERE bp.block_id = b.id AND bp.key = ?)",
        params: [term.key],
        exact: term.value === undefined,
      };
  }
}

function joinSql(parts: QueryPrefilter[], op: "AND" | "OR"): QueryPrefilter {
  return {
    sql: `(${parts.map((p) => p.sql).join(` ${op} `)})`,
    params: parts.flatMap((p) => p.params),
    exact: parts.every((p) => p.exact),
  };
}

export function queryPrefilter(expr: QueryExpr, env: QueryEnv): QueryPrefilter {
  switch (expr.kind) {
    case "term":
      return termSql(expr.term, env.today);
    case "and":
      return joinSql(expr.items.map((e) => queryPrefilter(e, env)), "AND");
    case "or":
      return joinSql(expr.items.map((e) => queryPrefilter(e, env)), "OR");
    case "not": {
      // NOT of an over-approximation is an under-approximation — unsound. Only an exact child
      // can be negated in SQL; otherwise accept everything (and drop the child's params with
      // its SQL) and let JavaScript decide.
      const inner = queryPrefilter(expr.item, env);
      if (!inner.exact) return { sql: "1", params: [], exact: false };
      return { sql: `NOT ${inner.sql}`, params: inner.params, exact: true };
    }
  }
}

/** True when evaluating `expr` needs the block's `block_prop` rows (a `ref` term can be satisfied
 * by a `tags::` line; a `prop` term reads them directly). Lets the client skip a second query. */
export function queryNeedsProperties(expr: QueryExpr): boolean {
  switch (expr.kind) {
    case "term":
      return expr.term.kind === "ref" || expr.term.kind === "prop";
    case "not":
      return queryNeedsProperties(expr.item);
    default:
      return expr.items.some(queryNeedsProperties);
  }
}
