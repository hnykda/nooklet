/**
 * Tokenizer for the `when`-clause grammar (R6). Hand-written rather than a single mega-regex so
 * every failure carries a precise offset for `WhenClauseError`.
 */
import { WhenClauseError } from "./errors.js";

// Note: `true`/`false` are lexed as plain `ident` tokens, matching the grammar's `Identifier`
// production literally (its character class includes them). Position decides meaning: the parser
// accepts an `ident` token spelled "true"/"false" as a `Literal` only in `Comparison`'s RHS
// (parser.ts#parseLiteral); as a bare `Primary` it stays an `{ t: 'ident' }` AST node, which
// `evaluate.ts` special-cases to the literal boolean (never looked up in `WhenContext`) — this is
// what makes the ubiquitous `when: "true"` ("always enabled") table entries work.
export type TokenType =
  | "lparen"
  | "rparen"
  | "and"
  | "or"
  | "not"
  | "eq"
  | "neq"
  | "ident"
  | "string"
  | "number"
  | "eof";

export interface Token {
  type: TokenType;
  value?: string | number | boolean;
  pos: number;
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const ch = src[i] as string;

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }

    if (ch === "(") {
      tokens.push({ type: "lparen", pos: i });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen", pos: i });
      i++;
      continue;
    }

    if (ch === "&") {
      if (src[i + 1] === "&") {
        tokens.push({ type: "and", pos: i });
        i += 2;
        continue;
      }
      throw new WhenClauseError("expected '&&'", src, i);
    }

    if (ch === "|") {
      if (src[i + 1] === "|") {
        tokens.push({ type: "or", pos: i });
        i += 2;
        continue;
      }
      throw new WhenClauseError("expected '||'", src, i);
    }

    if (ch === "!") {
      if (src[i + 1] === "=") {
        tokens.push({ type: "neq", pos: i });
        i += 2;
        continue;
      }
      tokens.push({ type: "not", pos: i });
      i++;
      continue;
    }

    if (ch === "=") {
      if (src[i + 1] === "=") {
        tokens.push({ type: "eq", pos: i });
        i += 2;
        continue;
      }
      throw new WhenClauseError("expected '==' (single '=' is not valid)", src, i);
    }

    if (ch === "'") {
      const start = i;
      i++;
      let value = "";
      while (i < n && src[i] !== "'") {
        value += src[i];
        i++;
      }
      if (i >= n) {
        throw new WhenClauseError("unterminated string literal", src, start);
      }
      i++; // closing quote
      tokens.push({ type: "string", value, pos: start });
      continue;
    }

    if (DIGIT.test(ch)) {
      const start = i;
      let value = "";
      while (i < n && DIGIT.test(src[i] as string)) {
        value += src[i];
        i++;
      }
      tokens.push({ type: "number", value: Number.parseInt(value, 10), pos: start });
      continue;
    }

    if (IDENT_START.test(ch)) {
      const start = i;
      let value = "";
      while (i < n && IDENT_PART.test(src[i] as string)) {
        value += src[i];
        i++;
      }
      tokens.push({ type: "ident", value, pos: start });
      continue;
    }

    throw new WhenClauseError(`unexpected character '${ch}'`, src, i);
  }

  tokens.push({ type: "eof", pos: n });
  return tokens;
}
