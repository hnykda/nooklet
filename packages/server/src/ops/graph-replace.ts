/**
 * `graph.replace` (M7, research/13 §4.2 item 4): find and replace across every block's text.
 *
 * Two things shape it. The preview IS the op: `dry_run: true` runs the same matcher over the same
 * rows and returns exactly the blocks that the real run would change, before/after, so what the
 * Find & Replace view shows and what an agent previews is what gets written. And the real run is
 * ONE `applyOps` call — one `batch_id` — so a replacement that turns out wrong is one `batch_undo`
 * away, not a per-block clean-up.
 *
 * Matching runs in JavaScript over a plain `SELECT`, not through SQL `LIKE`/`lower()`: SQLite's
 * `lower()` folds ASCII only, and this graph is half Czech. A regex needs the scan anyway. 18k
 * blocks take a few milliseconds.
 */

import { z } from "zod";
import { pageWireNameById } from "../rows.js";
import { defineOp, OpError } from "./registry.js";
import { currentHeadSeq, resolvePageIds } from "./resolve.js";
import { BatchIdOut, BlockId, IdempotencyKey, PageRef } from "./schemas.js";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Compile the query, refusing a pattern that could not be meant: invalid, or one that matches
 * the empty string (which would insert `replacement` between every two characters of the graph). */
export function compileQuery(query: string, regex: boolean, caseSensitive: boolean): RegExp {
  const flags = caseSensitive ? "g" : "gi";
  let re: RegExp;
  try {
    re = new RegExp(regex ? query : escapeRegExp(query), flags);
  } catch (e) {
    throw new OpError(
      "invalid",
      `query is not a valid regular expression: ${e instanceof Error ? e.message : String(e)}`,
      "fix the pattern, or set regex: false to search for the text literally",
    );
  }
  if (new RegExp(re.source, re.flags.replace("g", "")).test("")) {
    throw new OpError(
      "invalid",
      "query matches the empty string, which would change every block",
      "anchor or require at least one character in the pattern",
    );
  }
  return re;
}

interface Candidate {
  id: string;
  page_id: string;
  content: string;
}

export const graphReplace = defineOp({
  name: "graph.replace",
  summary: "Find and replace text across every block",
  description:
    "Finds query in the text of every block (or only blocks on pages, if given) and replaces " +
    "each occurrence with replacement. Literal text by default, case-insensitive unless " +
    "case_sensitive; regex: true reads query as a JavaScript regular expression, in which case " +
    "replacement may use $1-style group references. ALWAYS call with dry_run: true first: it " +
    "returns every block that would change with its text before and after, and writes nothing. " +
    "Then call again without dry_run to apply. The real run changes every matched block in ONE " +
    "batch and returns its batch_id, so batch_undo reverses the whole replacement at once. Only " +
    "block text is touched - not page names, not properties. Refuses to change more than " +
    "max_blocks blocks (default 2000) so a loose pattern cannot rewrite the graph by accident; " +
    "matches lists at most limit blocks, with truncated: true and the full counts when there are " +
    "more.",
  input: z
    .object({
      query: z.string().min(1).max(500),
      replacement: z.string().max(2000).default(""),
      regex: z.boolean().default(false),
      case_sensitive: z.boolean().default(false),
      pages: z.array(PageRef).max(20).optional().describe("Only blocks on these pages"),
      max_blocks: z
        .number()
        .int()
        .min(1)
        .max(20_000)
        .default(2000)
        .describe("Fail with too_large rather than change more blocks than this"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe("Max entries in matches (the counts always cover everything)"),
      dry_run: z.boolean().default(false),
      idempotency_key: IdempotencyKey,
    })
    .strict(),
  output: z.object({
    matches: z.array(
      z.object({
        block_id: BlockId,
        page: z.string(),
        before: z.string().describe("The block's text before"),
        after: z.string().describe("The block's text after the replacement"),
        count: z.number().int().describe("Occurrences in this block"),
      }),
    ),
    blocks_matched: z.number().int(),
    occurrences: z.number().int(),
    truncated: z.boolean().describe("matches holds fewer entries than blocks_matched"),
    seq: z.number().int(),
    batch_id: BatchIdOut,
    dry_run: z.boolean(),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  scopes: ["write"],
  expose: { mcp: { maxResultSizeChars: 60_000 } },
  render: (out) =>
    `${out.blocks_matched} block(s), ${out.occurrences} occurrence(s) ${out.dry_run ? "would change" : "changed"}`,
  handler: async (input, ctx) => {
    const re = compileQuery(input.query, input.regex, input.case_sensitive);
    // A literal replacement must stay literal: `String.replace` reads `$&`/`$1` in the
    // replacement string, which a person typing "$5" as the new text does not mean.
    const replacer: string | (() => string) = input.regex
      ? input.replacement
      : () => input.replacement;

    const conditions = ["b.deleted_at IS NULL", "p.deleted_at IS NULL"];
    const params: unknown[] = [];
    if (input.pages) {
      const ids = await resolvePageIds(ctx, input.pages);
      if (ids.length === 0) {
        return {
          matches: [],
          blocks_matched: 0,
          occurrences: 0,
          truncated: false,
          seq: currentHeadSeq(ctx.db),
          batch_id: undefined,
          dry_run: input.dry_run,
        };
      }
      conditions.push(`b.page_id IN (${ids.map(() => "?").join(",")})`);
      params.push(...ids);
    }
    const rows = ctx.db.all<Candidate>(
      `SELECT b.id AS id, b.page_id AS page_id, b.content AS content
       FROM block b JOIN page p ON p.id = b.page_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY p.name, b.created_at, b.id`,
      params,
    );

    const changed: Array<Candidate & { after: string; count: number }> = [];
    let occurrences = 0;
    for (const row of rows) {
      re.lastIndex = 0;
      const count = [...row.content.matchAll(re)].length;
      if (count === 0) continue;
      const after = row.content.replace(re, replacer as string);
      if (after === row.content) continue;
      changed.push({ ...row, after, count });
      occurrences += count;
    }

    if (changed.length > input.max_blocks) {
      throw new OpError(
        "too_large",
        `${changed.length} blocks match, more than max_blocks (${input.max_blocks})`,
        "narrow the query (pages, case_sensitive, a longer literal) or raise max_blocks deliberately",
        { blocks_matched: changed.length, occurrences },
      );
    }

    let seq = currentHeadSeq(ctx.db);
    let batchId: string | undefined;
    if (!input.dry_run && changed.length > 0) {
      const applyResult = await ctx.applyOps(
        changed.map((c) => ctx.mintOp(c.id, { kind: "block.text", content: c.after })),
      );
      seq = applyResult.seq;
      batchId = applyResult.batchId;
    }

    return {
      matches: changed.slice(0, input.limit).map((c) => ({
        block_id: c.id,
        page: pageWireNameById(ctx.db, c.page_id),
        before: c.content,
        after: c.after,
        count: c.count,
      })),
      blocks_matched: changed.length,
      occurrences,
      truncated: changed.length > input.limit,
      seq,
      batch_id: batchId,
      dry_run: input.dry_run,
    };
  },
});
