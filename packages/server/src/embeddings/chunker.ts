/**
 * Pure text transforms for embedding units (`docs/research/06-embeddings.md` §4.2): cleaning raw
 * block markdown, formatting a block/page unit's text (breadcrumb + own text + capped flattened
 * descendants), token estimation/capping, and hashing. No DB access here — `units.ts` supplies the
 * breadcrumb/descendant arrays these functions format, which keeps the cap/format logic testable
 * with plain fixtures.
 */

import { createHash } from "node:crypto";

export interface ChunkOptions {
  maxTokens: number;
}

export const DEFAULT_BLOCK_MAX_TOKENS = 300;
export const DEFAULT_PAGE_MAX_TOKENS = 500;
/** A block with less than this many cleaned chars, and no children, isn't worth its own unit
 * (research/06 §4.2: "own text ... >= ~24 chars or has children"). */
export const MIN_BLOCK_CHARS = 24;

/** chars/3 as a conservative token estimate (research/06 §4.2). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Clean raw block markdown into embeddable plain text, mirroring mcp-logseq's regexes
 * (research/06 §4.2): drop `key:: value` property lines, `[[Page]]` -> `Page`, `#tag` -> `tag`,
 * `((uuid))` -> dropped (the spec allows "or drop"), strip common markdown emphasis markers,
 * collapse whitespace.
 */
export function cleanBlockText(raw: string): string {
  let t = raw;
  t = t.replace(/^[ \t]*[a-z][a-z0-9-]*::.*$/gim, "");
  t = t.replace(/\[\[([^[\]]+)\]\]/g, "$1");
  t = t.replace(/#([^\s#[\]]+)/g, "$1");
  t = t.replace(/\(\(([a-z0-9-]+)\)\)/gi, "");
  // Paired emphasis/code markers -> their inner text (most specific first), not a blanket strip
  // of every `_`/`*` (those appear unpaired in code identifiers, math, etc.).
  t = t.replace(/\*\*\*([^*]+)\*\*\*/g, "$1");
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
  t = t.replace(/__([^_]+)__/g, "$1");
  t = t.replace(/~~([^~]+)~~/g, "$1");
  t = t.replace(/`([^`]+)`/g, "$1");
  t = t.replace(/\*([^*\s][^*]*?)\*/g, "$1");
  t = t.replace(/(?<![\w])_([^_\s][^_]*?)_(?![\w])/g, "$1");
  t = t.replace(/^[ \t]*[-*][ \t]+/gm, "");
  t = t.replace(/[ \t]+/g, " ");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

export function firstLine(cleaned: string): string {
  return (cleaned.split("\n")[0] ?? "").trim();
}

/** A block is worth its own embedding unit when it has enough of its own text, or has children
 * whose flattened text can still make the unit meaningful (research/06 §4.2). */
export function isEmbeddableBlock(cleanedOwnText: string, hasChildren: boolean): boolean {
  return cleanedOwnText.length >= MIN_BLOCK_CHARS || hasChildren;
}

/**
 * Format a block unit's embedded text:
 *   {Page title} › {ancestor-1 first line} › {ancestor-2 first line}
 *   {block text}
 *   - {descendant line}
 *   - {descendant line}
 * `breadcrumb` is page title first, then ancestors root-to-immediate-parent (oldest to nearest).
 * Descendants are appended depth-first, "- " prefixed, until `opts.maxTokens` is reached; the
 * rest are cut (they get their own units).
 */
export function formatBlockUnitText(
  breadcrumb: readonly string[],
  blockText: string,
  descendantLines: readonly string[],
  opts: ChunkOptions = { maxTokens: DEFAULT_BLOCK_MAX_TOKENS },
): string {
  const header = breadcrumb.filter((s) => s.length > 0).join(" › ");
  const parts: string[] = [];
  if (header) parts.push(header);
  parts.push(blockText);
  let body = parts.join("\n");
  let used = estimateTokens(body);

  const kept: string[] = [];
  for (const line of descendantLines) {
    if (line.length === 0) continue;
    const withPrefix = `- ${line}`;
    const add = estimateTokens(withPrefix) + 1;
    if (used + add > opts.maxTokens) break;
    kept.push(withPrefix);
    used += add;
  }
  if (kept.length > 0) body = `${body}\n${kept.join("\n")}`;
  return body;
}

/** Page unit: title + top-level blocks flattened, capped (research/06 §4.2). */
export function formatPageUnitText(
  title: string,
  topLevelLines: readonly string[],
  opts: ChunkOptions = { maxTokens: DEFAULT_PAGE_MAX_TOKENS },
): string {
  let body = title;
  let used = estimateTokens(body);
  const kept: string[] = [];
  for (const line of topLevelLines) {
    if (line.length === 0) continue;
    const withPrefix = `- ${line}`;
    const add = estimateTokens(withPrefix) + 1;
    if (used + add > opts.maxTokens) break;
    kept.push(withPrefix);
    used += add;
  }
  if (kept.length > 0) body = `${body}\n${kept.join("\n")}`;
  return body;
}
