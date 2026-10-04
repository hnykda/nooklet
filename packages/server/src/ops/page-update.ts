import { aliasKeysOf, normalizePageName, splitList } from "@nooklet/core";
import { z } from "zod";
import { buildWikilinkRewriteOps } from "../data-api.js";
import { unclaimedReferencePageForKey } from "../ref-pages.js";
import { runWithDryRun } from "./dry-run.js";
import { defineOp, OpError } from "./registry.js";
import { checkIfVersion, currentHeadSeq, pageMetaWire, requirePage } from "./resolve.js";
import {
  BatchIdOut,
  IdempotencyKey,
  IfVersion,
  PageMeta,
  PageRef,
  PropertiesPatch,
} from "./schemas.js";

export const pageUpdate = defineOp({
  name: "page.update",
  summary: "Rename a page and/or set page properties",
  description:
    "Renames a page (every [[link]]/#tag to it is rewritten; the old name becomes an alias unless " +
    "keep_alias is false) and/or sets page-level properties (null unsets a property). Cannot " +
    "rename journal days (their properties can be set). To edit a page's content use the block " +
    "tools, not this.",
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
  output: z.object({
    page: PageMeta,
    refs_rewritten: z.number().int(),
    seq: z.number().int(),
    batch_id: BatchIdOut,
    dry_run: z.boolean(),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ["write"],
  render: (out) => `${out.page.name} updated (${out.refs_rewritten} ref(s) rewritten)`,
  handler: async (input, ctx) => {
    return runWithDryRun(ctx, input.dry_run, async (ctx) => {
      const page = await requirePage(ctx, input.page);
      // Only a rename is refused on a journal day. This check used to run for every journal
      // update, before looking at what was asked, so a properties-only update (favourite, lock,
      // icon — which a person sets on a day from the properties panel) failed "cannot rename a
      // journal day" with no new_name given (B-236).
      if (
        page.journalDay !== null &&
        input.new_name !== undefined &&
        input.new_name !== page.name
      ) {
        throw new OpError(
          "invalid",
          "cannot rename a journal day",
          "journal pages are addressed by date, not renamed; set properties without new_name",
        );
      }
      checkIfVersion(page.updatedAt, input.if_version);

      const ops = [];
      let refsRewritten = 0;
      if (input.new_name !== undefined && input.new_name !== page.name) {
        const existing = await ctx.data.pages.get({ name: input.new_name });
        // The name held only by an empty page its links made (ADR 024) is free to take: that page
        // goes in the same batch, before the rename, and the links then resolve to this page.
        const holder = unclaimedReferencePageForKey(ctx.db, normalizePageName(input.new_name));
        if (existing && existing.id !== page.id && existing.id !== holder) {
          throw new OpError("conflict", `page "${input.new_name}" already exists`);
        }
        if (holder && holder !== page.id) {
          ops.push(ctx.mintOp(holder, { kind: "page.delete", deletedAt: Date.now() }));
        }
        ops.push(ctx.mintOp(page.id, { kind: "page.rename", name: input.new_name }));
        const rewriteOps = buildWikilinkRewriteOps(ctx.db, ctx.mintOp, page.name, input.new_name);
        refsRewritten = rewriteOps.length;
        ops.push(...rewriteOps);
        if (input.keep_alias) {
          // The old name becomes an entry in the page's `alias::` property — an ordinary
          // `page.prop` op, so it syncs, replays, and shows up in the mirror like any other
          // property. `page_alias` is derived from that property on write (`../page-aliases.ts`);
          // writing the index directly, as this once did, produced a row no other device and no
          // `rebuild()` would ever reproduce.
          const newKey = normalizePageName(input.new_name);
          const oldKey = normalizePageName(page.name);
          // Drop the name the page is taking (renaming back to a former alias must not leave a
          // page listed as its own alias), add the one it is giving up unless already there.
          const kept = splitList(page.properties.alias ?? "").filter(
            (item) => !aliasKeysOf(item, "").includes(newKey),
          );
          const next = aliasKeysOf(kept.join(", "), newKey).includes(oldKey)
            ? kept
            : [...kept, page.name];
          if (next.join(", ") !== (page.properties.alias ?? "")) {
            ops.push(
              ctx.mintOp(page.id, {
                kind: "page.prop",
                key: "alias",
                value: next.length > 0 ? next.join(", ") : null,
              }),
            );
          }
        }
      }
      if (input.properties) {
        for (const [k, v] of Object.entries(input.properties))
          ops.push(ctx.mintOp(page.id, { kind: "page.prop", key: k, value: v }));
      }

      const applyResult = ops.length > 0 ? await ctx.applyOps(ops) : undefined;
      const after = await ctx.data.pages.get(page.id);
      if (!after) throw new OpError("internal", "page disappeared during update");
      return {
        page: pageMetaWire(ctx.db, after),
        refs_rewritten: refsRewritten,
        seq: applyResult?.seq ?? currentHeadSeq(ctx.db),
        batch_id: input.dry_run ? undefined : applyResult?.batchId,
        dry_run: input.dry_run,
      };
    });
  },
});
