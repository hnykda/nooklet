/**
 * Recursive-descent parser for the `when`-clause grammar (R6):
 *
 * ```
 * Expr        ::= OrExpr
 * OrExpr      ::= AndExpr ( "||" AndExpr )*
 * AndExpr     ::= UnaryExpr ( "&&" UnaryExpr )*
 * UnaryExpr   ::= "!" UnaryExpr | Primary
 * Primary     ::= "(" Expr ")" | Comparison | Identifier
 * Comparison  ::= Identifier ( "==" | "!=" ) Literal
 * Identifier  ::= [A-Za-z_][A-Za-z0-9_]*
 * Literal     ::= "'" [^']* "'" | "true" | "false" | [0-9]+
 * ```
 *
 * No `eval`, no regex approximation: a real tokenizer (`tokenizer.ts`) + a real grammar walk.
 * Precedence (tightest first) is `!`, then `&&`, then `||`, encoded directly by the call
 * structure below (parseOr calls parseAnd calls parseUnary calls parsePrimary).
 */
import type { WhenLiteral, WhenNode } from "../types.js";
import { WhenClauseError } from "./errors.js";
import { type Token, tokenize } from "./tokenizer.js";

class Cursor {
  private i = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly src: string,
  ) {}

  peek(): Token {
    // tokenize() always appends an `eof` sentinel, so this index is always in range.
    return this.tokens[this.i] as Token;
  }

  next(): Token {
    const t = this.peek();
    if (t.type !== "eof") this.i++;
    return t;
  }

  fail(message: string): never {
    throw new WhenClauseError(message, this.src, this.peek().pos);
  }
}

function parseExpr(c: Cursor): WhenNode {
  return parseOr(c);
}

function parseOr(c: Cursor): WhenNode {
  let left = parseAnd(c);
  while (c.peek().type === "or") {
    c.next();
    const right = parseAnd(c);
    left = { t: "or", left, right };
  }
  return left;
}

function parseAnd(c: Cursor): WhenNode {
  let left = parseUnary(c);
  while (c.peek().type === "and") {
    c.next();
    const right = parseUnary(c);
    left = { t: "and", left, right };
  }
  return left;
}

function parseUnary(c: Cursor): WhenNode {
  if (c.peek().type === "not") {
    c.next();
    const node = parseUnary(c);
    return { t: "not", node };
  }
  return parsePrimary(c);
}

function parsePrimary(c: Cursor): WhenNode {
  const tok = c.peek();

  if (tok.type === "lparen") {
    c.next();
    const inner = parseExpr(c);
    if (c.peek().type !== "rparen") c.fail("expected closing ')'");
    c.next();
    return inner;
  }

  if (tok.type === "ident") {
    const identTok = c.next();
    const name = identTok.value as string;
    const opTok = c.peek();
    if (opTok.type === "eq" || opTok.type === "neq") {
      c.next();
      const literal = parseLiteral(c);
      return { t: opTok.type, ident: name, literal };
    }
    return { t: "ident", name };
  }

  return c.fail(`expected '(' or an identifier, found ${describeToken(tok)}`);
}

function parseLiteral(c: Cursor): WhenLiteral {
  const tok = c.peek();
  if (tok.type === "string") {
    c.next();
    return tok.value as string;
  }
  if (tok.type === "number") {
    c.next();
    return tok.value as number;
  }
  if (tok.type === "ident" && (tok.value === "true" || tok.value === "false")) {
    c.next();
    return tok.value === "true";
  }
  return c.fail(
    `expected a literal ('...', true, false, or a number), found ${describeToken(tok)}`,
  );
}

function describeToken(tok: Token): string {
  if (tok.type === "eof") return "end of expression";
  if (tok.value !== undefined) return `'${String(tok.value)}'`;
  return `'${tok.type}'`;
}

/** Parse `src` into a `WhenNode`. Throws `WhenClauseError` on any grammar violation, including
 * trailing input after a complete expression. Does NOT perform the R6 bare-non-boolean-identifier
 * validation — see `compile.ts#compileWhen`, which layers that on top and is what commands/
 * callers should use. Exported separately so the grammar itself can be unit-tested in isolation. */
export function parseWhen(src: string): WhenNode {
  const tokens = tokenize(src);
  const cursor = new Cursor(tokens, src);
  const node = parseExpr(cursor);
  if (cursor.peek().type !== "eof") {
    cursor.fail(`unexpected trailing input starting at ${describeToken(cursor.peek())}`);
  }
  return node;
}
