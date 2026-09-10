import { todayJournalDay } from "@vrite/core";
import { z } from "zod";
import { isoFromJournalDay } from "../data-api.js";
import { defineOp, type OriginKind } from "./registry.js";
import { OriginEnum } from "./schemas.js";

export const graphOverview = defineOp({
  name: "graph.overview",
  summary: "Orient: what is in this graph",
  description:
    "Start here. Returns page/journal/block counts, today's date and server timezone, the 7 most " +
    "recent journal days with their first line, the 20 most recently edited pages, top-level " +
    "namespaces, and the most-used tags. Cheap, under 1,000 tokens. Do not use this to enumerate " +
    "pages - use search or page_list for that; use it once at the start of a session to get " +
    "oriented and to get a seq for changes_since later.",
  input: z.object({}).strict(),
  output: z.object({
    today: z.string().describe("YYYY-MM-DD"),
    timezone: z.string(),
    counts: z.object({
      pages: z.number().int(),
      journals: z.number().int(),
      blocks: z.number().int(),
    }),
    recent_journals: z.array(
      z.object({ date: z.string(), first_line: z.string(), block_count: z.number().int() }),
    ),
    recent_pages: z.array(
      z.object({
        name: z.string(),
        updated_at: z.string(),
        updated_by: z.object({ origin: OriginEnum, actor: z.string() }).optional(),
      }),
    ),
    namespaces: z.array(z.object({ name: z.string(), pages: z.number().int() })),
    top_tags: z.array(z.object({ tag: z.string(), uses: z.number().int() })),
    seq: z.number().int().describe("Current changes-log position; pass to changes_since as cursor"),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ["read"],
  expose: { mcp: { alwaysLoad: true } },
  render: (out) =>
    `${out.counts.pages} pages, ${out.counts.journals} journals, ${out.counts.blocks} blocks. today ${out.today}. seq ${out.seq}`,
  handler: async (_input, ctx) => {
    const driver = ctx.db;
    const pages =
      driver.get<{ n: number }>(
        "SELECT count(*) AS n FROM page WHERE deleted_at IS NULL AND journal_day IS NULL",
      )?.n ?? 0;
    const journals =
      driver.get<{ n: number }>(
        "SELECT count(*) AS n FROM page WHERE deleted_at IS NULL AND journal_day IS NOT NULL",
      )?.n ?? 0;
    const blocks =
      driver.get<{ n: number }>("SELECT count(*) AS n FROM block WHERE deleted_at IS NULL")?.n ?? 0;

    const recentJournalRows = driver.all<{ id: string; journal_day: number }>(
      "SELECT id, journal_day FROM page WHERE deleted_at IS NULL AND journal_day IS NOT NULL ORDER BY journal_day DESC LIMIT 7",
    );
    const recentJournals = recentJournalRows.map((r) => {
      const first = driver.get<{ content: string }>(
        "SELECT content FROM block WHERE page_id = ? AND parent_id IS NULL AND deleted_at IS NULL ORDER BY order_key LIMIT 1",
        [r.id],
      );
      const count = driver.get<{ n: number }>(
        "SELECT count(*) AS n FROM block WHERE page_id = ? AND deleted_at IS NULL",
        [r.id],
      );
      return {
        date: isoFromJournalDay(r.journal_day),
        first_line: (first?.content ?? "").split("\n")[0] ?? "",
        block_count: count?.n ?? 0,
      };
    });

    // Recent non-journal pages come from `page.updated_at` directly, NOT from replaying the
    // `changes` log. Deriving them from the log meant a bounded window (the last N change rows)
    // could contain only one kind of entity — after importing a graph that is mostly journals,
    // every recent row was a journal block, all of which this list skips, so a 127-page graph
    // reported zero recent pages. `graph_overview` is the always-loaded tool an agent orients
    // itself with, so an empty list there is actively misleading. Attribution is looked back up
    // per page (at most `limit` cheap indexed lookups) and is simply absent for a page whose
    // last touch predates the retained audit rows.
    const pageRows = driver.all<{ id: string; name: string; updated_at: number }>(
      `SELECT id, name, updated_at FROM page
       WHERE journal_day IS NULL AND deleted_at IS NULL
       ORDER BY updated_at DESC LIMIT 20`,
    );
    const recentPages: Array<{
      name: string;
      updated_at: string;
      updated_by?: { origin: OriginKind; actor: string };
    }> = pageRows.map((p) => {
      const attribution = driver.get<{ origin: string; actor: string }>(
        `SELECT origin, actor FROM changes
         WHERE (entity_type = 'page' AND entity_id = ?)
            OR (entity_type = 'block' AND entity_id IN (SELECT id FROM block WHERE page_id = ?))
         ORDER BY seq DESC LIMIT 1`,
        [p.id, p.id],
      );
      return {
        name: p.name,
        updated_at: new Date(p.updated_at).toISOString(),
        ...(attribution
          ? { updated_by: { origin: attribution.origin as OriginKind, actor: attribution.actor } }
          : {}),
      };
    });

    const nameRows = driver.all<{ name: string }>(
      "SELECT name FROM page WHERE deleted_at IS NULL AND journal_day IS NULL",
    );
    const nsCounts = new Map<string, number>();
    for (const r of nameRows) {
      const idx = r.name.indexOf("/");
      if (idx === -1) continue;
      const ns = r.name.slice(0, idx);
      nsCounts.set(ns, (nsCounts.get(ns) ?? 0) + 1);
    }
    const namespaces = [...nsCounts.entries()]
      .map(([name, count]) => ({ name, pages: count }))
      .sort((a, b) => b.pages - a.pages);

    const topTags = driver.all<{ tag: string; uses: number }>(
      "SELECT dst_page_key AS tag, count(*) AS uses FROM ref WHERE kind = 'tag' AND dst_page_key IS NOT NULL GROUP BY dst_page_key ORDER BY uses DESC LIMIT 10",
    );

    const seq = driver.get<{ n: number }>("SELECT COALESCE(MAX(seq), 0) AS n FROM changes")?.n ?? 0;

    return {
      today: isoFromJournalDay(todayJournalDay()),
      timezone: ctx.config.timezone,
      counts: { pages, journals, blocks },
      recent_journals: recentJournals,
      recent_pages: recentPages,
      namespaces,
      top_tags: topTags,
      seq,
    };
  },
});
