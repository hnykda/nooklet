import { formatDoneIso, type Op } from "@nooklet/core";
import { z } from "zod";
import { getBlockRow, pageWireNameById } from "../rows.js";
import { runWithDryRun } from "./dry-run.js";
import {
  parseSingleBlockGrammar,
  renderOutlineNodes,
  renderSingleBlockText,
} from "./outline-bridge.js";
import { defineOp, OpError } from "./registry.js";
import { checkIfVersion } from "./resolve.js";
import { BlockId, IdempotencyKey, IfVersion, PropertiesPatch, WriteResult } from "./schemas.js";

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  for (;;) {
    idx = haystack.indexOf(needle, idx);
    if (idx === -1) break;
    count++;
    idx += needle.length;
  }
  return count;
}

/** The plain object schema, before `.refine()` wraps it in a `ZodEffects` (which drops `.omit()`/
 * `.shape` — `ZodObject`-only methods). `batch.ts` needs this pre-refine shape to build a
 * placeholder-tolerant variant of this op's input for use inside a `batch` entry. */
export const blockUpdateInputShape = z
  .object({
    id: BlockId,
    content: z
      .string()
      .max(100_000)
      .optional()
      .describe("New full text for this block, single-block grammar (no children)"),
    old_str: z
      .string()
      .max(100_000)
      .optional()
      .describe("Must occur exactly once in the block's current raw text"),
    new_str: z.string().max(100_000).optional(),
    properties: PropertiesPatch.optional(),
    if_version: IfVersion,
    dry_run: z.boolean().default(false),
    idempotency_key: IdempotencyKey,
  })
  .strict();

export const blockUpdate = defineOp({
  name: "block.update",
  summary: "Edit one block's text/properties",
  description:
    "Replaces one block's own text and/or properties; children are untouched. Give exactly one " +
    "of: content (the block's full new text, in the single-block grammar - marker, priority, " +
    "first line, continuation lines, property lines, but no nested bullets), or old_str/new_str " +
    "(an exact, unique substring replacement within that same raw text - use this for a small " +
    "edit like flipping a marker or fixing a word without retyping the whole block). properties, " +
    "if given, is applied after either of those and always wins for the keys it lists (null " +
    "unsets a property). A text line that looks like a property or timestamp is written with a " +
    "backslash before its colon (scheduled\\:: 2026-09-20), as page_read shows it; without the " +
    "backslash it is a real property. Pass if_version from a recent read to avoid clobbering a concurrent " +
    "edit. To add blocks use block_insert; to reparent or reorder use block_move.",
  input: blockUpdateInputShape.refine(
    (v) =>
      (v.content !== undefined) !== (v.old_str !== undefined || v.new_str !== undefined) ||
      (v.content === undefined && v.old_str === undefined && v.properties !== undefined),
    {
      message:
        "give content, or old_str+new_str, or properties (or combine properties with either)",
    },
  ),
  output: WriteResult.extend({
    before: z.string().describe("The block's previous raw text, for your own verification"),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ["write"],
  render: (out) => out.outline,
  handler: async (input, ctx) => {
    return runWithDryRun(ctx, input.dry_run, async (ctx) => {
      const row = getBlockRow(ctx.db, input.id);
      if (!row) throw new OpError("not_found", `no block with id ${input.id}`);
      checkIfVersion(row.updated_at, input.if_version);
      const before = await ctx.data.blocks.get(input.id);
      if (!before) throw new OpError("not_found", `no block with id ${input.id}`);
      const beforeRaw = renderSingleBlockText(before);

      const ops: Op[] = [];
      let newMarker = before.marker;

      const applyTextReplace = (node: ReturnType<typeof parseSingleBlockGrammar>) => {
        newMarker = node.marker;
        ops.push(ctx.mintOp(input.id, { kind: "block.text", content: node.content }));
        ops.push(ctx.mintOp(input.id, { kind: "block.prop", key: "marker", value: node.marker }));
        ops.push(
          ctx.mintOp(input.id, { kind: "block.prop", key: "priority", value: node.priority }),
        );
        const newKeys = new Set(Object.keys(node.properties));
        for (const k of Object.keys(before.properties)) {
          if (!newKeys.has(k))
            ops.push(ctx.mintOp(input.id, { kind: "block.prop", key: k, value: null }));
        }
        for (const [k, v] of Object.entries(node.properties))
          ops.push(ctx.mintOp(input.id, { kind: "block.prop", key: k, value: v }));
      };

      if (input.content !== undefined) {
        applyTextReplace(parseSingleBlockGrammar(input.content, "auto"));
      } else if (input.old_str !== undefined || input.new_str !== undefined) {
        if (input.old_str === undefined || input.new_str === undefined) {
          throw new OpError("invalid", "give both old_str and new_str");
        }
        const occurrences = countOccurrences(beforeRaw, input.old_str);
        if (occurrences !== 1) {
          throw new OpError(
            "invalid",
            `old_str occurs ${occurrences} time(s) in the block's current text, not exactly once`,
            "old_str must match exactly once; read the block again and copy the exact text",
          );
        }
        const idx = beforeRaw.indexOf(input.old_str);
        const newRaw =
          beforeRaw.slice(0, idx) + input.new_str + beforeRaw.slice(idx + input.old_str.length);
        const node = parseSingleBlockGrammar(newRaw, "flush");
        applyTextReplace(node);
        // `before` renders a folded block's `collapsed:: true` line, so an edit of that line is how
        // an agent folds or unfolds by text; it answered 200 and changed nothing (B-314). Only here:
        // `content` is an agent's full text, which rarely repeats the line, and reading its absence
        // as "unfold" would expand blocks nobody asked to.
        if (node.collapsed !== before.collapsed) {
          ops.push(
            ctx.mintOp(input.id, {
              kind: "block.prop",
              key: "collapsed",
              value: node.collapsed ? "true" : "false",
            }),
          );
        }
      }

      if (input.properties) {
        for (const [k, v] of Object.entries(input.properties))
          ops.push(ctx.mintOp(input.id, { kind: "block.prop", key: k, value: v }));
      }

      // Logseq-style convenience: stamp/clear `done` when the marker transitions to/from DONE.
      if (newMarker !== before.marker) {
        if (newMarker === "DONE") {
          ops.push(
            ctx.mintOp(input.id, {
              kind: "block.prop",
              key: "done",
              value: formatDoneIso(Date.now()),
            }),
          );
        } else if (before.marker === "DONE") {
          ops.push(ctx.mintOp(input.id, { kind: "block.prop", key: "done", value: null }));
        }
      }

      if (ops.length === 0) {
        throw new OpError("invalid", "give content, or old_str+new_str, or properties");
      }

      const applyResult = await ctx.applyOps(ops);
      const after = await ctx.data.blocks.get(input.id);
      if (!after) throw new OpError("internal", "block disappeared during update");
      const outline = renderOutlineNodes([
        {
          id: input.id,
          content: after.content,
          marker: after.marker,
          priority: after.priority,
          properties: after.properties,
          collapsed: after.collapsed,
          children: [],
        },
      ]);
      return {
        page: pageWireNameById(ctx.db, row.page_id),
        created: [],
        updated: [input.id],
        deleted: [],
        outline,
        seq: applyResult.seq,
        batch_id: input.dry_run ? undefined : applyResult.batchId,
        dry_run: input.dry_run,
        before: beforeRaw,
      };
    });
  },
});
