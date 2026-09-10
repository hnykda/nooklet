import { normalizePageName } from "@vrite/core";
import { z } from "zod";
import { buildWikilinkRewriteOps } from "../data-api.js";
import { runWithDryRun } from "./dry-run.js";
import { checkIfVersion, currentHeadSeq, pageMetaWire, requirePage } from "./resolve.js";
import { defineOp, OpError } from "./registry.js";
import { IdempotencyKey, IfVersion, PageMeta, PageRef, PropertiesPatch } from "./schemas.js";

export const pageUpdate = defineOp({
  name: "page.update",
  summary: "Rename a page and/or set page properties",
  description:
    "Renames a page (every [[link]]/#tag to it is rewritten; the old name becomes an alias unless " +
    "keep_alias is false) and/or sets page-level properties (null unsets a property). Cannot " +
    "rename journal days. To edit a page's content use the block tools, not this.",
  input: z
    .object({
      page: PageRef,
      new_name: z.string().min(1).max(512).optional(),
      keep_alias: z.boolean().default(true),
      properties: PropertiesPatch.optional(),
      if_version: IfVersion,
      dry_run: z.boolean().default(false),
      idempotency_key: IdempotencyKey,
    })
    .strict(),
  output: z.object({ page: PageMeta, refs_rewritten: z.number().int(), seq: z.number().int(), dry_run: z.boolean() }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  scopes: ["write"],
  render: (out) => `${out.page.name} updated (${out.refs_rewritten} ref(s) rewritten)`,
  handler: async (input, ctx) => {
    return runWithDryRun(ctx, input.dry_run, async () => {
      const page = await requirePage(ctx, input.page);
      if (page.journalDay !== null) {
        throw new OpError("invalid", "cannot rename a journal day", "journal pages are addressed by date, not renamed");
      }
      checkIfVersion(page.updatedAt, input.if_version);

      const ops = [];
      let refsRewritten = 0;
      if (input.new_name !== undefined && input.new_name !== page.name) {
        const existing = await ctx.data.pages.get({ name: input.new_name });
        if (existing && existing.id !== page.id) {
          throw new OpError("conflict", `page "${input.new_name}" already exists`);
        }
        ops.push(ctx.mintOp(page.id, { kind: "page.rename", name: input.new_name }));
        const rewriteOps = buildWikilinkRewriteOps(ctx.db, ctx.mintOp, page.name, input.new_name);
        refsRewritten = rewriteOps.length;
        ops.push(...rewriteOps);
        if (input.keep_alias) {
          ctx.db.run("INSERT OR IGNORE INTO page_alias(page_id, alias_key) VALUES (?, ?)", [page.id, normalizePageName(page.name)]);
        }
      }
      if (input.properties) {
        for (const [k, v] of Object.entries(input.properties)) ops.push(ctx.mintOp(page.id, { kind: "page.prop", key: k, value: v }));
      }

      const applyResult = ops.length > 0 ? await ctx.applyOps(ops) : undefined;
      const after = await ctx.data.pages.get(page.id);
      if (!after) throw new OpError("internal", "page disappeared during update");
      const seq = applyResult?.seq ?? currentHeadSeq(ctx.db);
      return { page: pageMetaWire(ctx.db, after), refs_rewritten: refsRewritten, seq, dry_run: input.dry_run };
    });
  },
});
