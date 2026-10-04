/**
 * The page outline behind the shelf's "Outline" card mode (M7, research/13 §4.2 item 7): which
 * blocks make the table of contents, and what each one reads as. Pure — no DOM, no store — so it
 * is testable on its own (`shelfOutline.test.ts`) and `Shelf.tsx` stays about rendering.
 */

import { type BlockContent, classifyBlockContent, type InlineToken } from "@nooklet/core";
import { lookupBlockText } from "../data/block-ref-cache.js";
import { displayRefName } from "../data/page-title.js";

export interface OutlineSource {
  id: string;
  content: string;
  children: readonly OutlineSource[];
}

export interface TocEntry {
  id: string;
  /** Plain text of the block's first line — markdown stripped, refs shown by their names. */
  text: string;
  /** Nesting depth in the page tree, for the indent. */
  depth: number;
  /** Heading level when the block is a `#` heading; absent for a plain top-level block. */
  level?: 1 | 2 | 3 | 4 | 5 | 6;
}

/** Inline tokens back to readable text. `text` tokens carry offsets only, so the source is needed;
 * everything else renders the way a person would read it aloud — a link by its name, a tag with
 * its `#`, emphasis by its content. */
export function plainText(tokens: readonly InlineToken[], source: string): string {
  let out = "";
  for (const t of tokens) {
    switch (t.kind) {
      case "text":
        out += source.slice(t.start, t.end);
        break;
      case "br":
        out += " ";
        break;
      case "escape":
        out += t.char;
        break;
      case "wikilink":
        out += t.alias ?? displayRefName(t.target);
        break;
      case "tag":
        out += `#${t.name}`;
        break;
      case "blockRef":
        out += lookupBlockText(t.id) ?? "((…))";
        break;
      case "linkToPage":
      case "linkToBlock":
      case "link":
        out += plainText(t.label, source);
        break;
      case "autolink":
        out += t.href;
        break;
      case "image":
        out += t.alt;
        break;
      case "strong":
      case "em":
      case "strike":
      case "highlight":
        out += plainText(t.children, source);
        break;
      case "code":
        out += t.code;
        break;
      case "math":
        out += t.tex;
        break;
      default:
        // embed, macro, checkbox: nothing to read.
        break;
    }
  }
  return out.trim();
}

/** One line of readable text for a block, and its heading level if it is one. */
export function blockTitle(content: string): { text: string; level?: TocEntry["level"] } {
  const classified: BlockContent = classifyBlockContent(content);
  switch (classified.kind) {
    case "heading":
      return { text: plainText(classified.title, content), level: classified.level };
    case "paragraph":
    case "quote":
      return { text: plainText(classified.lines[0] ?? [], content) };
    case "fence":
      return { text: classified.lang ? `\`\`\`${classified.lang}` : "```" };
    case "table":
      return { text: plainText(classified.header[0] ?? [], content) || "table" };
    case "mixed": {
      const first = classified.parts[0];
      const tokens = first?.kind === "paragraph" ? first.lines[0] : first?.header[0];
      return { text: plainText(tokens ?? [], content) || "table" };
    }
    case "hr":
      return { text: "—" };
  }
}

/**
 * The entries of a page's table of contents: every heading, at any depth, plus every top-level
 * block. Headings because they are what a person put there to be navigated by; top-level blocks
 * because a page written as a plain outline has no headings, and its first level IS its
 * structure. Deeper non-heading blocks are detail, and the content mode shows those. Collapsed
 * subtrees are still walked — a heading under a folded parent is still a place on the page.
 */
export function outlineEntries(nodes: readonly OutlineSource[], depth = 0): TocEntry[] {
  const out: TocEntry[] = [];
  for (const node of nodes) {
    const { text, level } = blockTitle(node.content);
    if (depth === 0 || level !== undefined) {
      out.push({ id: node.id, text: text || "…", depth, ...(level ? { level } : {}) });
    }
    out.push(...outlineEntries(node.children, depth + 1));
  }
  return out;
}
