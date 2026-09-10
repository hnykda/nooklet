/**
 * "What link is under the caret?" — backs `nav.followLink` (commands-and-keymap.md R43).
 *
 * Derived from the same token stream everything else renders from (`@nooklet/core`'s
 * `tokenizeContent`), so what the user sees highlighted and what Enter follows can never disagree.
 * A caret sitting anywhere inside a token counts, including at either edge, which is what makes
 * "put the cursor in a link and press Enter" behave the way people expect.
 */

import { type InlineToken, tokenizeContent } from "@nooklet/core";
import type { LinkAtCaret } from "../commands/hosts/editor-host.js";

function fromToken(tok: InlineToken): LinkAtCaret | null {
  switch (tok.kind) {
    case "wikilink":
      return { type: "page", name: tok.target };
    case "tag":
      return { type: "tag", name: tok.name };
    case "blockRef":
      return { type: "block", id: tok.id };
    case "linkToPage":
      return { type: "page", name: tok.target };
    case "linkToBlock":
      return { type: "block", id: tok.id };
    case "link":
      return { type: "url", href: tok.href };
    case "autolink":
      return { type: "url", href: tok.href };
    case "embed":
      if (tok.target?.kind === "page") return { type: "page", name: tok.target.name };
      if (tok.target?.kind === "block") return { type: "block", id: tok.target.id };
      return null;
    default:
      return null;
  }
}

/** Walks nested tokens (a link inside emphasis, a wikilink nested in another) innermost-first, so
 * the most specific link containing the caret wins. */
function search(tokens: readonly InlineToken[], offset: number): LinkAtCaret | null {
  for (const tok of tokens) {
    if (offset < tok.start || offset > tok.end) continue;
    const children =
      "children" in tok && Array.isArray(tok.children)
        ? (tok.children as InlineToken[])
        : undefined;
    if (children) {
      const inner = search(children, offset);
      if (inner) return inner;
    }
    const nested =
      "nested" in tok && Array.isArray(tok.nested) ? (tok.nested as InlineToken[]) : undefined;
    if (nested) {
      const inner = search(nested, offset);
      if (inner) return inner;
    }
    const label =
      "label" in tok && Array.isArray(tok.label) ? (tok.label as InlineToken[]) : undefined;
    if (label) {
      const inner = search(label, offset);
      if (inner) return inner;
    }
    const here = fromToken(tok);
    if (here) return here;
  }
  return null;
}

export function linkAtCaret(content: string, offset: number): LinkAtCaret | null {
  if (content === "") return null;
  return search(tokenizeContent(content), offset);
}
