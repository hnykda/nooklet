import {
  isoJournalName,
  newId,
  normalizePageName,
  type Op,
  parseJournalTitle,
} from "@nooklet/core";
import { z } from "zod";
import { boundsForPageEnd, journalDayFromWire } from "../data-api.js";
import { isUnclaimedReferencePage } from "../ref-pages.js";
import { runWithDryRun } from "./dry-run.js";
import { prepareMarkdownInsert } from "./outline-bridge.js";
import { defineOp, OpError } from "./registry.js";
import { currentHeadSeq, wirePageName } from "./resolve.js";
import { IdempotencyKey, MarkdownInput, PageRef, Properties, WriteResult } from "./schemas.js";

export const pageCreate = defineOp({
  name: "page.create",
  summary: "Create a page",
  description:
    "Creates a page with optional properties and initial Markdown content. If the page already " +
    "exists: if_exists: 'return' (default) returns the existing page untouched - safe to retry; " +
    "'append' appends the given markdown to it; 'error' fails with a conflict. A page that exists " +
    "only because something links to it, and that nobody has written in, does not count as " +
    "existing: page_create fills it in (existed: false, same page_id). You do not need " +
    "this for journal days - page_append creates them implicitly; use page_create for a named " +
    "page you want to exist even with no content yet, or to set page properties at creation.",
  input: z
    .object({
      name: PageRef,
      properties: Properties.optional(),
      markdown: MarkdownInput.optional(),
      if_exists: z.enum(["return", "append", "error"]).default("return"),
      dry_run: z.boolean().default(false),
      idempotency_key: IdempotencyKey,
    })
    .strict(),
  output: WriteResult.extend({ existed: z.boolean(), page_id: z.string() }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ["write"],
  render: (out) => (out.existed ? `${out.page} already existed` : `created ${out.page}`),
  handler: async (input, ctx) => {
    return runWithDryRun(ctx, input.dry_run, async (ctx) => {
      // Recognise a journal day by ANY of its title formats, not just ISO. The guard used
      // `journalDayFromWire`, which understands only `today`/`yesterday`/`tomorrow` and
      // `YYYY-MM-DD` — so `page.create({name: "Tue, 08.09.2026"})` sailed past it and produced a
      // page with `journal_day = NULL`: named like a journal, looking like one, and invisible to
      // the journal stream forever. `parseJournalTitle` is the same parser the rest of the system
      // resolves journals with, so the guard now matches what the system actually believes.
      const asJournalDay = parseJournalTitle(input.name) ?? journalDayFromWire(input.name);
      if (asJournalDay !== null) {
        throw new OpError(
          "invalid",
          `"${input.name}" is a journal day, and page.create cannot target one`,
          `use page_append with page: "${isoJournalName(asJournalDay)}" instead`,
        );
      }
      const found = await ctx.data.pages.get({ name: input.name });
      // An empty page that exists only because something references the name (ADR 024) is not a
      // page anyone made: creating it takes it over — same id, so every link and open view stays
      // on it — instead of answering "already existed" and dropping the properties and markdown.
      const claim =
        found &&
        found.key === normalizePageName(input.name) &&
        isUnclaimedReferencePage(ctx.db, found.id)
          ? found
          : null;
      const existing = claim ? null : found;
      if (existing) {
        if (input.if_exists === "error") {
          throw new OpError("conflict", `page "${input.name}" already exists`, undefined, {
            page_id: existing.id,
          });
        }
        if (input.if_exists === "return" || !input.markdown) {
          return {
            page: wirePageName(existing),
            existed: true,
            page_id: existing.id,
            created: [],
            updated: [],
            deleted: [],
            outline: "",
            seq: currentHeadSeq(ctx.db),
            dry_run: input.dry_run,
          };
        }
        const bounds = boundsForPageEnd(ctx.db, existing.id, "end");
        const { ops, created, outline } = prepareMarkdownInsert(ctx, input.markdown, bounds);
        const applyResult = ops.length > 0 ? await ctx.applyOps(ops) : undefined;
        return {
          page: wirePageName(existing),
          existed: true,
          page_id: existing.id,
          created,
          updated: [],
          deleted: [],
          outline,
          seq: applyResult?.seq ?? currentHeadSeq(ctx.db),
          batch_id: input.dry_run ? undefined : applyResult?.batchId,
          dry_run: input.dry_run,
        };
      }

      // The page and its initial blocks go in ONE batch: they are audited together, and one
      // batch_undo removes all of it. As two writes (page via DataApi, then blocks) the response
      // could only name the second batch, and undoing it left an empty page behind.
      const pageId = claim?.id ?? newId();
      // Minted first: ops apply in HLC order, and the blocks need their page to exist. Claiming,
      // the rename is what makes the page this caller's (and gives it the casing asked for); the
      // properties follow as their own ops, since there is no create to carry them.
      const ops: Op[] = claim
        ? [
            ctx.mintOp(pageId, { kind: "page.rename", name: input.name }),
            ...Object.entries(input.properties ?? {}).map(([key, value]) =>
              ctx.mintOp(pageId, { kind: "page.prop", key, value }),
            ),
          ]
        : [
            ctx.mintOp(pageId, {
              kind: "page.create",
              name: input.name,
              journalDay: null,
              properties: input.properties,
              createdAt: Date.now(),
            }),
          ];
      let created: string[] = [];
      let outline = "";
      if (input.markdown) {
        // No siblings exist yet, so the bounds are the open interval — no query needed.
        const res = prepareMarkdownInsert(
          ctx,
          input.markdown,
          { pageId, parentId: null, lower: null, upper: null },
          "accept",
        );
        // The markdown's pre-block (`read-only:: true` before the first bullet) is this page's
        // properties; it used to be dropped without a word (B-235). `properties` wins for any key
        // both give: it is the field an agent sets on purpose.
        for (const [key, value] of Object.entries(res.pageProperties)) {
          if (input.properties && Object.hasOwn(input.properties, key)) continue;
          ops.push(ctx.mintOp(pageId, { kind: "page.prop", key, value }));
        }
        created = res.created;
        outline = res.outline;
        ops.push(...res.ops);
      }
      const applyResult = await ctx.applyOps(ops);
      const page = await ctx.data.pages.get(pageId);
      if (!page) throw new OpError("internal", "page.create: failed to read back created page");
      return {
        page: wirePageName(page),
        existed: false,
        page_id: page.id,
        created,
        updated: [],
        deleted: [],
        outline,
        seq: applyResult.seq,
        batch_id: input.dry_run ? undefined : applyResult.batchId,
        dry_run: input.dry_run,
      };
    });
  },
});
