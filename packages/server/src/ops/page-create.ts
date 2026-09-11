import { parseJournalTitle } from "@nooklet/core";
import { z } from "zod";
import { boundsForPageEnd, isoFromJournalDay, journalDayFromWire } from "../data-api.js";
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
    "'append' appends the given markdown to it; 'error' fails with a conflict. You do not need " +
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
          `use page_append with page: "${isoFromJournalDay(asJournalDay)}" instead`,
        );
      }
      const existing = await ctx.data.pages.get({ name: input.name });
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
          dry_run: input.dry_run,
        };
      }

      const page = await ctx.data.pages.create({ name: input.name, properties: input.properties });
      let created: string[] = [];
      let outline = "";
      let seq = currentHeadSeq(ctx.db);
      if (input.markdown) {
        const bounds = boundsForPageEnd(ctx.db, page.id, "end");
        const res = prepareMarkdownInsert(ctx, input.markdown, bounds);
        created = res.created;
        outline = res.outline;
        if (res.ops.length > 0) {
          const applyResult = await ctx.applyOps(res.ops);
          seq = applyResult.seq;
        }
      }
      return {
        page: wirePageName(page),
        existed: false,
        page_id: page.id,
        created,
        updated: [],
        deleted: [],
        outline,
        seq,
        dry_run: input.dry_run,
      };
    });
  },
});
