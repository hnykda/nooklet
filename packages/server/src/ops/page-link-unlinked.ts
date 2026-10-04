/**
 * `mentions.link` (research/13 §4.2 item 10): turn every plain-text mention of a page into a
 * `[[link]]`, in one batch, so the "Unlinked references" list on that page empties in a click and
 * `batch.undo` with the returned `batch_id` puts every block back.
 *
 * The candidate set is exactly what `page.backlinks` shows as unlinked (`unlinkedMentionRows` in
 * `../data-api.ts`): an FTS phrase hit on the page's short name, on another page, in a block whose
 * path refs do not already reach this page. FTS is looser than the rewrite can afford to be — it
 * folds case and diacritics and tokenizes through punctuation, so "aurora-project.com" and "Aleš"
 * both match a page called "Aurora"/"Ales" — which is why the rewrite is a separate, stricter pass
 * (`linkFirstMention`): a whole-word, case-insensitive, literal match, outside code, links, tags,
 * URLs and property lines. A block the strict pass cannot safely rewrite is reported in `skipped`
 * with the reason rather than being guessed at; it stays in the unlinked list for a human.
 *
 * Only the FIRST safe mention in a block is linked. One link is what makes the block a linked
 * reference; wrapping every repetition in a paragraph is a bigger edit than "link this" asks for,
 * and the smaller rewrite is the easier one to read back and to undo by hand.
 *
 * The rewrite keeps the author's own text where it can: a mention that already resolves to the
 * page by key (ADR 004: page identity is the case-folded name) is wrapped in place, so "aurora"
 * becomes `[[aurora]]` and still reads as the author wrote it. Only a namespaced page, whose short
 * name alone would link to the wrong page, gets the full stored name written in.
 */

import { normalizePageName, type Op, unlinkedMentionRows } from "@nooklet/core";
import { z } from "zod";
import { pageWireNameById } from "../rows.js";
import { runWithDryRun } from "./dry-run.js";
import { defineOp } from "./registry.js";
import { currentHeadSeq, requirePage, wirePageName } from "./resolve.js";
import { BlockId, IdempotencyKey, PageRef, WriteResult } from "./schemas.js";

/** How many mentions one call rewrites. Matches `Limit`'s ceiling; a graph with more plain
 * mentions of one name than this links them over two calls, which is fine — the second call
 * finds only what the first left. */
const MAX_MENTIONS = 500;

const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const PROPERTY_LINE_RE = /^\s*[A-Za-z0-9_.-]+::(\s|$)/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Why an occurrence was left alone. Exported so the HTTP test can pin the reasons a human sees.
 */
export type SkipReason =
  | "no whole-word match"
  | "inside code"
  | "inside a link or reference"
  | "part of a tag"
  | "part of a URL"
  | "on a property line";

/**
 * Find the first occurrence of `plainName` in `content` that is safe to wrap, and return the
 * rewritten content — or the reason nothing could be rewritten. Pure; tested directly.
 *
 * `page.name` is the stored display name ("Projects/Aurora"); `page.key` its identity key.
 */
export function linkFirstMention(
  content: string,
  page: { name: string; key: string },
): { content: string } | { skipped: SkipReason } {
  const plainName = page.name.split("/").pop() ?? page.name;
  // Whole-word: not glued to a letter, digit or underscore on either side. `\p{L}`/`\p{N}` rather
  // than `\b`, which is ASCII-only and would treat "Aleš" as ending after the "e".
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(plainName)}(?![\\p{L}\\p{N}_])`, "giu");

  let firstReason: SkipReason = "no whole-word match";
  let inFence = false;
  let lineStart = 0;
  const lines = content.split("\n");
  for (const line of lines) {
    const lineEnd = lineStart + line.length;
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      lineStart = lineEnd + 1;
      continue;
    }
    if (inFence) {
      if (re.test(line)) firstReason = pickReason(firstReason, "inside code");
      re.lastIndex = 0;
      lineStart = lineEnd + 1;
      continue;
    }
    if (PROPERTY_LINE_RE.test(line)) {
      if (re.test(line)) firstReason = pickReason(firstReason, "on a property line");
      re.lastIndex = 0;
      lineStart = lineEnd + 1;
      continue;
    }

    re.lastIndex = 0;
    let m: RegExpExecArray | null = re.exec(line);
    while (m !== null) {
      const start = m.index;
      const end = start + m[0].length;
      const reason = unsafeReason(line, start, end);
      if (reason === null) {
        const matched = m[0];
        // Wrap the author's own spelling when it already names this page; otherwise the short
        // name would link elsewhere (a namespaced page), so write the full stored name.
        const link =
          normalizePageName(matched) === page.key ? `[[${matched}]]` : `[[${page.name}]]`;
        const abs = lineStart + start;
        return { content: content.slice(0, abs) + link + content.slice(abs + matched.length) };
      }
      firstReason = pickReason(firstReason, reason);
      m = re.exec(line);
    }
    lineStart = lineEnd + 1;
  }
  return { skipped: firstReason };
}

/** The first concrete reason wins over the default; later occurrences do not overwrite it. */
function pickReason(current: SkipReason, next: SkipReason): SkipReason {
  return current === "no whole-word match" ? next : current;
}

/** Why the occurrence at `[start, end)` of `line` must not be wrapped, or `null` if it may be. */
function unsafeReason(line: string, start: number, end: number): SkipReason | null {
  const before = line.slice(0, start);

  // Inline code: an odd number of backticks before the match means we are inside a span.
  if ((before.match(/`/g)?.length ?? 0) % 2 === 1) return "inside code";

  // Inside any bracket construct still open at the match: `[[page]]`, `[label](url)`, `![alt]`.
  // `[` without a later `]` before the match covers wikilinks and link labels in one rule.
  if (before.lastIndexOf("[") > before.lastIndexOf("]")) return "inside a link or reference";
  // `((block ref))` and `{{macro}}` the same way.
  if (before.lastIndexOf("((") > before.lastIndexOf("))")) return "inside a link or reference";
  if (before.lastIndexOf("{{") > before.lastIndexOf("}}")) return "inside a link or reference";
  // A markdown link's `(url)` half: `](` opened and not yet closed.
  if (before.lastIndexOf("](") > before.lastIndexOf(")")) return "part of a URL";

  // `#Aurora` / `#[[Aurora]]`: already a reference (the `[[` case is caught above).
  if (before.endsWith("#")) return "part of a tag";

  // Inside a URL: the whitespace-delimited word around the match carries a scheme or `www.`.
  const wordStart = Math.max(before.lastIndexOf(" "), before.lastIndexOf("\t")) + 1;
  const restEnd = line.slice(end).search(/\s/);
  const wordEnd = restEnd === -1 ? line.length : end + restEnd;
  const word = line.slice(wordStart, wordEnd);
  if (word.includes("://") || /^www\./i.test(word)) return "part of a URL";

  return null;
}

export const pageLinkUnlinked = defineOp({
  name: "mentions.link",
  summary: "Turn plain-text mentions of a page into [[links]], in one undoable batch",
  description:
    "Rewrites every block that mentions a page's name in plain text but does not link to it (the " +
    "unlinked references page_backlinks lists with include_unlinked) so that the first mention " +
    "becomes a [[link]]. Whole-word, case-insensitive; the author's own spelling is kept inside " +
    "the brackets when it resolves to the page, and a namespaced page gets its full name. Mentions " +
    "inside code, existing links, tags, URLs or property lines are left alone and listed in " +
    "skipped with the reason. Give block_ids to link only some of the candidates. Every rewrite " +
    "lands in one batch: pass the returned batch_id to batch_undo to put all of them back. " +
    "Idempotent: a second call finds nothing left to link. Use dry_run to preview.",
  input: z
    .object({
      page: PageRef,
      block_ids: z
        .array(BlockId)
        .max(MAX_MENTIONS)
        .optional()
        .describe(
          "Link only these blocks (each must currently be an unlinked mention of the page); " +
            "omit to link every candidate",
        ),
      dry_run: z.boolean().default(false),
      idempotency_key: IdempotencyKey,
    })
    .strict(),
  output: WriteResult.extend({
    skipped: z
      .array(z.object({ id: BlockId, reason: z.string() }))
      .describe("Candidate blocks left unchanged, with why"),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ["write"],
  render: (out) => out.outline || "(nothing to link)",
  handler: async (input, ctx) => {
    return runWithDryRun(ctx, input.dry_run, async (ctx) => {
      const page = await requirePage(ctx, input.page);
      const wanted = input.block_ids ? new Set(input.block_ids) : undefined;
      const candidates = unlinkedMentionRows(ctx.db, page, MAX_MENTIONS);

      const ops: Op[] = [];
      const updated: string[] = [];
      const skipped: Array<{ id: string; reason: string }> = [];
      const lines: string[] = [];
      const seen = new Set<string>();

      for (const row of candidates) {
        seen.add(row.block_id);
        if (wanted && !wanted.has(row.block_id)) continue;
        const result = linkFirstMention(row.content, page);
        if ("skipped" in result) {
          skipped.push({ id: row.block_id, reason: result.skipped });
          continue;
        }
        ops.push(ctx.mintOp(row.block_id, { kind: "block.text", content: result.content }));
        updated.push(row.block_id);
        const firstLine = (result.content.split("\n")[0] ?? "").trim();
        lines.push(`^${row.block_id} (${pageWireNameById(ctx.db, row.page_id)}): ${firstLine}`);
      }
      if (wanted) {
        for (const id of wanted) {
          if (!seen.has(id)) skipped.push({ id, reason: "not an unlinked mention of this page" });
        }
      }

      const applyResult = ops.length > 0 ? await ctx.applyOps(ops) : undefined;
      return {
        page: wirePageName(page),
        created: [],
        updated,
        deleted: [],
        outline: lines.join("\n"),
        seq: applyResult?.seq ?? currentHeadSeq(ctx.db),
        batch_id: input.dry_run ? undefined : applyResult?.batchId,
        dry_run: input.dry_run,
        skipped,
      };
    });
  },
});
