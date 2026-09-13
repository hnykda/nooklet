import { z } from "zod";
import { boundsForPageEnd, boundsForParent } from "../data-api.js";
import { runWithDryRun } from "./dry-run.js";
import { checkWriteMarkdown, prepareMarkdownInsert } from "./outline-bridge.js";
import { defineOp, OpError } from "./registry.js";
import { currentHeadSeq, resolvePageRef, wirePageName } from "./resolve.js";
import { BlockId, IdempotencyKey, MarkdownInput, PageRef, WriteResult } from "./schemas.js";

export const pageAppend = defineOp({
  name: "page.append",
  summary: "Append Markdown to a page or journal",
  description:
    "The main way to write. Parses Markdown into a block tree - indentation becomes nesting - and " +
    "appends it to the end (or start) of a page or journal day, or under a given parent block " +
    "already on that page. Creates the page or journal day if it does not exist yet. Returns the " +
    "created blocks as outline Markdown with their ^ids so you can keep editing without " +
    "re-reading. For inserting next to one specific existing block (not just at the page's " +
    "end/start) use block_insert. This call is not idempotent by itself - pass idempotency_key if " +
    "you might retry after a timeout, or you may get duplicate blocks.",
  input: z
    .object({
      page: PageRef,
      markdown: MarkdownInput,
      position: z.enum(["end", "start"]).default("end"),
      parent: BlockId.optional().describe(
        "Append as children of this block (must already be on the page) instead of at the top level",
      ),
      create_page: z.boolean().default(true),
      dry_run: z
        .boolean()
        .default(false)
        .describe("Parse and show what would be created without writing"),
      idempotency_key: IdempotencyKey,
    })
    .strict(),
  output: WriteResult,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  scopes: ["write"],
  expose: { mcp: { alwaysLoad: true } },
  render: (out) => out.outline || `(no blocks created on ${out.page})`,
  handler: async (input, ctx) => {
    return runWithDryRun(ctx, input.dry_run, async (ctx) => {
      // Checked before the page is resolved: resolving may CREATE the page (or journal day) with
      // its own write, and a refusal after that left the new page behind, empty (B-312). For the
      // same reason `parent` never creates one — a page that does not exist yet holds no parent.
      const checked = checkWriteMarkdown(ctx.db, input.markdown, "refuse");
      const page = await resolvePageRef(ctx, input.page, {
        create: input.create_page && input.parent === undefined,
      });
      if (!page && input.parent !== undefined) {
        throw new OpError("not_found", `block ${input.parent} is not on page "${input.page}"`);
      }
      if (!page) {
        throw new OpError(
          "invalid",
          `page "${input.page}" does not exist and create_page is false`,
          "set create_page: true, or call page_create first",
        );
      }
      let bounds: ReturnType<typeof boundsForPageEnd>;
      if (input.parent) {
        const parentBlock = await ctx.data.blocks.get(input.parent);
        if (!parentBlock || parentBlock.pageId !== page.id) {
          throw new OpError(
            "not_found",
            `block ${input.parent} is not on page "${wirePageName(page)}"`,
          );
        }
        bounds = boundsForParent(ctx.db, page.id, input.parent);
      } else {
        bounds = boundsForPageEnd(ctx.db, page.id, input.position);
      }
      const { ops, created, outline } = prepareMarkdownInsert(ctx, checked, bounds);
      const applyResult = ops.length > 0 ? await ctx.applyOps(ops) : undefined;
      return {
        page: wirePageName(page),
        created,
        updated: [],
        deleted: [],
        outline,
        seq: applyResult?.seq ?? currentHeadSeq(ctx.db),
        batch_id: input.dry_run ? undefined : applyResult?.batchId,
        dry_run: input.dry_run,
      };
    });
  },
});
