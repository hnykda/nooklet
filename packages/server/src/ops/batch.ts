import { isId, newId } from "@vrite/core";
import { z } from "zod";
import { blockDelete } from "./block-delete.js";
import { blockInsert } from "./block-insert.js";
import { blockMove, blockMoveInputShape } from "./block-move.js";
import { blockUpdate, blockUpdateInputShape } from "./block-update.js";
import { pageAppend } from "./page-append.js";
import { pageCreate } from "./page-create.js";
import { pageUpdate } from "./page-update.js";
import { defineOp, OpError, type OpContext } from "./registry.js";
import { IdempotencyKey } from "./schemas.js";

/** `$N`/`$N.k` placeholders (00-conventions.md glossary) may be typed as a bare id even in fields
 * whose standalone-call schema is a strictly-regexed `BlockId` (`ref`/`id` on the block ops) — see
 * `blockUpdateInputShape`'s comment. This is a deliberate, documented widening of mcp-tools.md's
 * literal `BatchOp` sketch (which reuses each op's `BlockId` field verbatim and so could never
 * actually accept "$1" there); `$N` chaining is otherwise only usable through the already-loose
 * `PageRef` fields, which the spec's own worked example (page.create -> page.append) happens not
 * to exercise this gap in.
 */
const PLACEHOLDER_RE = /^\$\d+(\.\d+)?$/;
const IdOrPlaceholder = z
  .string()
  .refine((v) => isId(v) || PLACEHOLDER_RE.test(v), { message: 'must be a 14-char id or a "$N"/"$N.k" batch placeholder' });

const BatchOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("page.create") }).extend(pageCreate.input.omit({ idempotency_key: true, dry_run: true }).shape),
  z
    .object({ op: z.literal("page.append") })
    .extend(pageAppend.input.omit({ idempotency_key: true, dry_run: true }).shape)
    .extend({ parent: IdOrPlaceholder.optional() }),
  z
    .object({ op: z.literal("block.insert") })
    .extend(blockInsert.input.omit({ idempotency_key: true, dry_run: true }).shape)
    .extend({ ref: IdOrPlaceholder }),
  z
    .object({ op: z.literal("block.update") })
    .extend(blockUpdateInputShape.omit({ idempotency_key: true, dry_run: true }).shape)
    .extend({ id: IdOrPlaceholder }),
  z
    .object({ op: z.literal("block.move") })
    .extend(blockMoveInputShape.omit({ idempotency_key: true, dry_run: true }).shape)
    .extend({ id: IdOrPlaceholder, ref: IdOrPlaceholder.optional() }),
  z
    .object({ op: z.literal("block.delete") })
    .extend(blockDelete.input.omit({ idempotency_key: true, dry_run: true }).shape)
    .extend({ id: IdOrPlaceholder }),
  z.object({ op: z.literal("page.update") }).extend(pageUpdate.input.omit({ idempotency_key: true, dry_run: true }).shape),
]);

type BatchOpName = z.infer<typeof BatchOp>["op"];

// biome-ignore lint/suspicious/noExplicitAny: each op's own zod schema types its own input; the
// dispatch table below is inherently heterogeneous (that's exactly what `batch` is for).
const OPS_BY_NAME: Record<BatchOpName, { input: z.ZodType; handler: (input: any, ctx: OpContext) => unknown }> = {
  "page.create": pageCreate,
  "page.append": pageAppend,
  "block.insert": blockInsert,
  "block.update": blockUpdate,
  "block.move": blockMove,
  "block.delete": blockDelete,
  "page.update": pageUpdate,
};

interface StepBinding {
  firstId?: string;
  created: string[];
}

function bindingFor(opName: BatchOpName, result: Record<string, unknown>): StepBinding {
  const created = Array.isArray(result.created) ? (result.created as string[]) : [];
  if (opName === "page.create") return { firstId: result.page_id as string | undefined, created };
  return { firstId: created[0], created };
}

function resolvePlaceholders(entry: Record<string, unknown>, bindings: StepBinding[], index: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (typeof value === "string") {
      const m = PLACEHOLDER_RE.test(value) ? /^\$(\d+)(?:\.(\d+))?$/.exec(value) : null;
      if (m) {
        const n = Number(m[1]);
        const k = m[2] !== undefined ? Number(m[2]) : undefined;
        if (n < 1 || n > bindings.length) {
          throw new OpError("invalid", `"${value}" references an op that has not run (only ${bindings.length} earlier op(s))`, undefined, { index });
        }
        // biome-ignore lint/style/noNonNullAssertion: bounds checked above
        const step = bindings[n - 1]!;
        if (k !== undefined) {
          const id = step.created[k];
          if (id === undefined) {
            throw new OpError("invalid", `"${value}" is out of range for op ${n}'s created ids`, undefined, { index });
          }
          out[key] = id;
        } else {
          if (step.firstId === undefined) {
            throw new OpError("invalid", `"${value}" references an op that created no ids`, undefined, { index });
          }
          out[key] = step.firstId;
        }
        continue;
      }
    }
    out[key] = value;
  }
  return out;
}

export const batch = defineOp({
  name: "batch",
  summary: "Apply several write operations atomically",
  description:
    "Runs up to 100 write operations (page.create, page.append, block.insert, block.update, " +
    "block.move, block.delete, page.update) in order, inside one transaction: either every one " +
    'succeeds or none are applied. A later operation can reference an id created by an earlier ' +
    'one with "$1" (that op\'s first created id) or "$1.2" (its third created id, 0-indexed) ' +
    "wherever a page or block id is expected. dry_run: true validates everything and resolves " +
    "placeholders without writing anything. One idempotency_key covers the whole batch.",
  input: z
    .object({
      ops: z.array(BatchOp).min(1).max(100).describe('Fields inside may reference "$N" / "$N.k" ids created by earlier entries'),
      dry_run: z.boolean().default(false),
      idempotency_key: IdempotencyKey,
    })
    .strict(),
  output: z.object({
    results: z.array(
      z.object({
        index: z.number().int(),
        ok: z.boolean(),
        result: z.unknown().optional().describe("That op's own output shape on success"),
        error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }).optional(),
      }),
    ),
    applied: z.boolean(),
    seq: z.number().int().optional(),
    batch_id: z.string(),
    dry_run: z.boolean(),
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  scopes: ["write"],
  render: (out) => `batch ${out.batch_id}: ${out.results.length} op(s), applied=${out.applied}`,
  handler: async (input, ctx) => {
    /**
     * Runs every entry in `input.ops` against `runCtx`, in order, sharing one `batchId` (every
     * `changes` row from this call groups under it, per 00-conventions.md's audit rule). Throws
     * (with `details.index`) on the first failure — `input.ops[i]`'s own placeholder resolution,
     * schema validation, or handler error all surface the same way (mcp-tools.md §4.3.15) — and
     * per §3.5.1 v1 has no partial-apply mode, so `runAllSteps` itself never returns a "some ok,
     * some failed" result; the caller (below) decides what "rolled back" means for the two phases.
     */
    async function runAllSteps(runCtx: OpContext, batchId: string) {
      const results: Array<{ index: number; ok: true; result: unknown }> = [];
      const bindings: StepBinding[] = [];
      const stepCtx: OpContext = {
        ...runCtx,
        async applyOps(ops, meta) {
          return runCtx.applyOps(ops, { batchId, ...meta });
        },
      };
      for (let i = 0; i < input.ops.length; i++) {
        // biome-ignore lint/style/noNonNullAssertion: loop bound by input.ops.length
        const entry = input.ops[i]! as Record<string, unknown> & { op: BatchOpName };
        const opDef = OPS_BY_NAME[entry.op];
        const { op: _op, ...rest } = entry;
        const resolved = resolvePlaceholders(rest, bindings, i);
        const parsed = opDef.input.safeParse({ ...resolved, dry_run: false });
        if (!parsed.success) {
          throw new OpError("invalid", z.prettifyError(parsed.error), undefined, { index: i });
        }
        let result: Record<string, unknown>;
        try {
          result = (await opDef.handler(parsed.data, stepCtx)) as Record<string, unknown>;
        } catch (e) {
          if (e instanceof OpError) {
            const details = e.details && typeof e.details === "object" && !Array.isArray(e.details) ? e.details : {};
            throw new OpError(e.code, e.message, e.hint, { ...details, index: i });
          }
          throw e;
        }
        results.push({ index: i, ok: true, result });
        bindings.push(bindingFor(entry.op, result));
      }
      return results;
    }

    // Phase 1 (ALWAYS, dry_run or not): run for real against a throwaway clone of the whole graph
    // (`ctx.forkForTrial()`, `./clone-db.ts`) — never the actual database. A failure anywhere
    // throws here, before the real `ctx` has been touched at all: this is what gives `batch` its
    // atomicity (mcp-tools.md §3.5.1) and `dry_run` its "as if the batch had run" semantics
    // (§3.5.3), without needing a nested SQL transaction (see `./clone-db.ts`'s header comment for
    // why that path does not work here).
    const trialBatchId = newId();
    const trialResults = await runAllSteps(ctx.forkForTrial(), trialBatchId);

    if (input.dry_run) {
      return { results: trialResults, applied: false, seq: undefined, batch_id: trialBatchId, dry_run: true };
    }

    // Phase 2: the trial proved every step succeeds, so replay the same sequence for real. Fresh
    // ids/batchId (this is a completely independent, second pass — the trial's clone is discarded).
    const realBatchId = newId();
    const realResults = await runAllSteps(ctx, realBatchId);
    const seq = ctx.db.get<{ n: number }>("SELECT COALESCE(MAX(seq), 0) AS n FROM changes WHERE batch_id = ?", [realBatchId])?.n ?? 0;
    return { results: realResults, applied: true, seq, batch_id: realBatchId, dry_run: false };
  },
});
