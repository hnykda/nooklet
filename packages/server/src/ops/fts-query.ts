/**
 * Turns what a person (or an agent) typed into an FTS5 `MATCH` expression that cannot fail to
 * parse.
 *
 * FTS5's query language is not "search box" syntax: `c++`, `what's`, `a.b`, `(` and an unbalanced
 * `"` are all syntax errors, `AND` alone is an error, and `e-mail` / `foo -bar` are read as a
 * *column filter* ("no such column: bar") — see `tools/probes/fts5-query-syntax.mjs`. Handing the
 * raw string to `MATCH` turned every one of those into an HTTP 500, which for a Czech user typing
 * an e-mail address or a C++ note is not an edge case.
 *
 * The grammar this accepts is the one `search`'s description promises: words, `"quoted phrases"`,
 * and `-exclusions`, plus a trailing `*` on a bare word for prefix matching. Every term is emitted
 * as an FTS5 string literal (`"…"` with inner quotes doubled), which is the one form the parser
 * takes verbatim, so nothing the user types can reach the query language itself.
 */

interface Term {
  text: string;
  negated: boolean;
  prefix: boolean;
}

/** Split on whitespace, keeping `"…"` groups together; an unterminated quote runs to the end. */
function tokenize(raw: string): Array<{ text: string; quoted: boolean; negated: boolean }> {
  const out: Array<{ text: string; quoted: boolean; negated: boolean }> = [];
  let i = 0;
  const n = raw.length;
  while (i < n) {
    const ch = raw[i] as string;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    let negated = false;
    if (ch === "-" && i + 1 < n && !/\s/.test(raw[i + 1] as string)) {
      negated = true;
      i++;
    }
    if (raw[i] === '"') {
      const close = raw.indexOf('"', i + 1);
      const end = close === -1 ? n : close;
      out.push({ text: raw.slice(i + 1, end), quoted: true, negated });
      i = close === -1 ? n : close + 1;
      continue;
    }
    let j = i;
    while (j < n && !/\s/.test(raw[j] as string)) j++;
    out.push({ text: raw.slice(i, j), quoted: false, negated });
    i = j;
  }
  return out;
}

function toTerms(raw: string): Term[] {
  const terms: Term[] = [];
  for (const tok of tokenize(raw)) {
    let text = tok.text;
    let prefix = false;
    if (!tok.quoted && text.endsWith("*") && text.length > 1) {
      prefix = true;
      text = text.slice(0, -1);
    }
    // A bare `"` pair, a lone `*`, or a token that was only its `-` sign carries no term.
    text = text.trim();
    if (text === "" || text === "*") continue;
    terms.push({ text, negated: tok.negated, prefix });
  }
  return terms;
}

function literal(term: Term): string {
  return `"${term.text.replaceAll('"', '""')}"${term.prefix ? "*" : ""}`;
}

/**
 * The `MATCH` expression for `raw`, or `null` when there is nothing positive to match — an empty
 * query, or exclusions only (FTS5 has no "everything except", and "no hits" is the honest answer
 * for `-foo` on its own).
 */
export function toFtsQuery(raw: string): string | null {
  const terms = toTerms(raw);
  const positive = terms.filter((t) => !t.negated);
  if (positive.length === 0) return null;
  const negative = terms.filter((t) => t.negated);
  let expr = positive.map(literal).join(" ");
  for (const t of negative) expr += ` NOT ${literal(t)}`;
  return expr;
}

/** A single exact phrase as a `MATCH` expression (for "mentions of this page name"). */
export function ftsPhrase(text: string): string {
  return `"${text.replaceAll('"', '""')}"`;
}
