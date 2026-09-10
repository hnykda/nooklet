import { z } from "zod";
import { getBlockRow, resolveInsertionBounds } from "../data-api.js";
import { runWithDryRun } from "./dry-run.js";
import { prepareMarkdownInsert } from "./outline-bridge.js";
import { checkIfVersion, currentHeadSeq, wirePageName } from "./resolve.js";
import { defineOp, OpError } from "./registry.js";
import { BlockId, IdempotencyKey, IfVersion, MarkdownInput, Position, WriteResult } from "./schemas.js";

export const blockInsert = defineOp({
  name: "block.insert",
  summary: "Insert Markdown relative to a block",
  description:
    "Parses Markdown into blocks and inserts them relative to ref: child_first/child_last nest " +
    "under ref; before/after place them as ref's siblings. Returns the created blocks with ^ids. " +
    "Use page_append when you just want to add to the end of a page - this is for precise " +
    "placement next to one existing block. Pass if_version (from a recent read of ref or its " +
    "parent) to avoid inserting relative to a block that moved unexpectedly since you read it.",
  input: z
    .object({
      ref: BlockId,
      position: Position,
      markdown: MarkdownInput,
      if_version: IfVersion,
      dry_run: z.boolean().default(false),
      idempotency_key: IdempotencyKey,
    })
    .strict(),
  output: WriteResult,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  scopes: ["write"],
  render: (out) => out.outline || `(no blocks created near ^${out.page})`,
  handler: async (input, ctx) => {
    return runWithDryRun(ctx, input.dry_run, async (ctx) => {
      const refRow = getBlockRow(ctx.db, input.ref);
      if (!refRow) throw new OpError("not_found", `no block with id ${input.ref}`);
      checkIfVersion(refRow.updated_at, input.if_version);
      const bounds = resolveInsertionBounds(ctx.db, input.ref, input.position);
      if (!bounds) throw new OpError("not_found", `no block with id ${input.ref}`);
      const { ops, created, outline } = prepareMarkdownInsert(ctx, input.markdown, bounds);
      const applyResult = ops.length > 0 ? await ctx.applyOps(ops) : undefined;
      const pageRow = ctx.db.get<{ name: string; journal_day: number | null }>(
        "SELECT name, journal_day FROM page WHERE id = ?",
        [refRow.page_id],
      );
      const pageWire = pageRow
        ? wirePageName({ id: refRow.page_id, name: pageRow.name, key: "", journalDay: pageRow.journal_day, properties: {}, createdAt: 0, updatedAt: 0 })
        : refRow.page_id;
      const seq = applyResult?.seq ?? currentHeadSeq(ctx.db);
      return { page: pageWire, created, updated: [], deleted: [], outline, seq, dry_run: input.dry_run };
    });
  },
});
