/**
 * `page.merge` (M7, research/13 §4.2 item 3): two pages that turned out to be one thing become
 * one page. The semantics — move, rewrite, alias, delete, all in one undoable batch — are argued
 * in ADR 020; the short version is that the rewrite keeps the graph honest and the alias is the
 * safety net for whatever the rewrite cannot reach (unlinked mentions, files outside the graph).
 */

import { normalizePageName, type Op, splitList } from "@nooklet/core";
import { z } from "zod";
import {
  boundsForPageEnd,
  buildRefRewriteOps,
  newOrderKeys,
  subtreePlaceOps,
} from "../data-api.js";
import { aliasKeysOf, pageLookupKeys } from "../page-aliases.js";
import { runWithDryRun } from "./dry-run.js";
import { defineOp, OpError } from "./registry.js";
import { checkIfVersion, pageMetaWire, requirePage, wirePageName } from "./resolve.js";
import { BatchIdOut, IdempotencyKey, IfVersion, PageMeta, PageRef } from "./schemas.js";

/** `[[x]]` / `#x` / `x` -> `x`, the same tolerance `page-aliases.ts` extends to `alias::`. */
function bareItem(item: string): string {
  const t = item.trim();
  if (t.startsWith("[[") && t.endsWith("]]")) return t.slice(2, -2).trim();
  if (t.startsWith("#")) return t.slice(1).trim();
  return t;
}

/** `base` plus every item of `extra` whose name it does not already carry (by key). */
function unionList(base: string | undefined, extra: readonly string[], ownKey: string): string {
  const items = splitList(base ?? "");
  const seen = new Set(items.map((i) => normalizePageName(bareItem(i))));
  seen.add(ownKey);
  for (const item of extra) {
    const key = normalizePageName(bareItem(item));
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    items.push(item.trim());
  }
  return items.join(", ");
}

export const pageMerge = defineOp({
  name: "page.merge",
  summary: "Merge one page into another",
  description:
    "Merges page source into page target and deletes source: every block of source moves to " +
    "the end of target (order, nesting and ids kept); every [[link]] and #tag to source - by its " +
    "name or any of its aliases, in any casing - anywhere in the graph is rewritten to name " +
    "target; source's aliases and tags are added to target's and its other properties fill in " +
    "any target lacks; source's own name becomes an alias of target (keep_alias: false to skip), " +
    "so anything the rewrite could not reach still resolves; then source is soft-deleted. Cannot " +
    "merge a journal day (move its blocks with block_move_to_page instead) or a page into itself. " +
    "One batch: batch_undo with the returned batch_id restores source, its blocks, every " +
    "rewritten reference and target's properties. Call with dry_run: true first to see how many " +
    "blocks would move and how many references would change.",
  input: z
    .object({
      source: PageRef.describe("The page that disappears"),
      target: PageRef.describe("The page that absorbs it"),
      keep_alias: z
        .boolean()
        .default(true)
        .describe("Add source's name to target's alias:: so the old name still resolves"),
      if_version: IfVersion.describe("Version of source, from a recent page_read"),
      dry_run: z.boolean().default(false),
      idempotency_key: IdempotencyKey,
    })
    .strict(),
  output: z.object({
    source: z.string().describe("The merged-away page's wire name"),
    target: PageMeta,
    blocks_moved: z.number().int(),
    refs_rewritten: z
      .number()
      .int()
      .describe("Individual [[links]]/#tags/list items rewritten to name target"),
    entities_rewritten: z.number().int().describe("Blocks and pages whose text or tags changed"),
    alias_added: z.boolean(),
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
  expose: { mcp: { requiresUserInteraction: true } },
  render: (out) =>
    `merged ${out.source} into ${out.target.name}: ${out.blocks_moved} block(s) moved, ${out.refs_rewritten} reference(s) rewritten`,
  handler: async (input, ctx) => {
    return runWithDryRun(ctx, input.dry_run, async (ctx) => {
      const source = await requirePage(ctx, input.source);
      const target = await requirePage(ctx, input.target);
      if (source.id === target.id) {
        throw new OpError("invalid", "source and target are the same page");
      }
      if (source.journalDay !== null) {
        throw new OpError(
          "invalid",
          "cannot merge a journal day into another page",
          "journal days are addressed by date; move their blocks with block_move_to_page instead",
        );
      }
      checkIfVersion(source.updatedAt, input.if_version);

      const ops: Op[] = [];

      // 1. Blocks: source's top level, in order, appended to target's top level; each subtree's
      //    descendants follow explicitly (B-85).
      const roots = await ctx.data.blocks.children({ page: source.id });
      const keys = newOrderKeys(boundsForPageEnd(ctx.db, target.id, "end"), roots.length);
      let blocksMoved = 0;
      roots.forEach((root, i) => {
        const place = subtreePlaceOps(ctx.db, ctx.mintOp, root.id, {
          pageId: target.id,
          parentId: null,
          order: keys[i] as string,
        });
        blocksMoved += place.length;
        ops.push(...place);
      });

      // 2. References: everything indexed under source's own key or any of its alias keys now
      //    names target. Computed BEFORE the alias change below so `page_alias` still lists
      //    source's aliases as source's.
      const rewrite = buildRefRewriteOps(
        ctx.db,
        ctx.mintOp,
        pageLookupKeys(ctx.db, source),
        target.name,
      );
      ops.push(...rewrite.ops);

      // 3. Properties. `alias::` gains source's name and aliases; `tags::` is the union; anything
      //    else source had that target lacks is copied. Target's own values always win.
      const targetKey = target.key;
      const sourceAliasItems = splitList(source.properties.alias ?? "").filter(
        (item) => aliasKeysOf(item, targetKey).length > 0,
      );
      const aliasExtra = input.keep_alias ? [source.name, ...sourceAliasItems] : sourceAliasItems;
      const nextAlias = unionList(target.properties.alias, aliasExtra, targetKey);
      const aliasAdded = nextAlias !== (target.properties.alias ?? "");
      if (aliasAdded) {
        ops.push(ctx.mintOp(target.id, { kind: "page.prop", key: "alias", value: nextAlias }));
      }
      if (source.properties.tags) {
        const nextTags = unionList(
          target.properties.tags,
          splitList(source.properties.tags),
          targetKey,
        );
        if (nextTags !== (target.properties.tags ?? "")) {
          ops.push(ctx.mintOp(target.id, { kind: "page.prop", key: "tags", value: nextTags }));
        }
      }
      for (const [key, value] of Object.entries(source.properties)) {
        if (key === "alias" || key === "tags" || target.properties[key] !== undefined) continue;
        ops.push(ctx.mintOp(target.id, { kind: "page.prop", key, value }));
      }

      // 4. Source goes. Its blocks are already target's, so nothing else needs a tombstone.
      ops.push(ctx.mintOp(source.id, { kind: "page.delete", deletedAt: Date.now() }));

      const applyResult = await ctx.applyOps(ops);
      const rejected = applyResult.results.find((r) => r.status === "rejected");
      if (rejected) throw new OpError("invalid", `merge rejected: ${rejected.reason}`);

      const after = await ctx.data.pages.get(target.id);
      if (!after) throw new OpError("internal", "target disappeared during merge");
      return {
        source: wirePageName(source),
        target: pageMetaWire(ctx.db, after),
        blocks_moved: blocksMoved,
        refs_rewritten: rewrite.occurrences,
        entities_rewritten: rewrite.entities,
        alias_added: aliasAdded,
        seq: applyResult.seq,
        batch_id: input.dry_run ? undefined : applyResult.batchId,
        dry_run: input.dry_run,
      };
    });
  },
});
