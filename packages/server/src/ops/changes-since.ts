import { z } from "zod";
import { defineOp, OpError } from "./registry.js";
import { currentHeadSeq, requirePage, wirePageName } from "./resolve.js";
import { Limit, OriginEnum } from "./schemas.js";

interface ChangeRow {
  seq: number;
  created_at: number;
  origin: string;
  actor: string;
  batch_id: string;
  entity_type: "page" | "block";
  entity_id: string;
  op_ids_json: string;
}

interface OpRow {
  id: string;
  kind: string;
  payload_json: string;
}

function firstLine(content: string): string {
  return (content.split("\n")[0] ?? "").trim();
}

function opsForRow(driver: import("@nooklet/core").SqlDriver, opIdsJson: string): OpRow[] {
  let ids: string[] = [];
  try {
    ids = JSON.parse(opIdsJson) as string[];
  } catch {
    ids = [];
  }
  if (ids.length === 0) return [];
  return driver.all<OpRow>(
    `SELECT id, kind, payload_json FROM op WHERE id IN (${ids.map(() => "?").join(",")})`,
    ids,
  );
}

function classify(entityType: "page" | "block", ops: OpRow[]): { kind: string; summary: string } {
  const byKind = new Map(ops.map((o) => [o.kind, o]));
  if (entityType === "block") {
    const create = byKind.get("block.create");
    if (create) {
      const p = JSON.parse(create.payload_json) as { content: string };
      return { kind: "block.created", summary: `created: "${firstLine(p.content)}"` };
    }
    if (byKind.get("block.delete")) return { kind: "block.deleted", summary: "deleted" };
    const text = byKind.get("block.text");
    if (text) {
      const p = JSON.parse(text.payload_json) as { content: string };
      return { kind: "block.updated", summary: `-> ${firstLine(p.content)}` };
    }
    if (byKind.get("block.place")) return { kind: "block.moved", summary: "moved" };
    return { kind: "block.updated", summary: "updated" };
  }
  const create = byKind.get("page.create");
  if (create) {
    const p = JSON.parse(create.payload_json) as { name: string };
    return { kind: "page.created", summary: `created "${p.name}"` };
  }
  if (byKind.get("page.delete")) return { kind: "page.deleted", summary: "deleted" };
  const rename = byKind.get("page.rename");
  if (rename) {
    const p = JSON.parse(rename.payload_json) as { name: string };
    return { kind: "page.renamed", summary: `renamed to "${p.name}"` };
  }
  return { kind: "page.updated", summary: "updated" };
}

export const changesSince = defineOp({
  name: "changes.since",
  summary: "What changed since a cursor",
  description:
    "Returns what changed since a cursor: blocks/pages created, updated, moved, deleted, " +
    "restored, or renamed, oldest first, with who did it (origin, actor) and a one-line summary. " +
    "Get a starting cursor from graph_overview.seq or from any write's seq. Use this to catch up " +
    "after the user or another agent edited the graph, to build a changelog, or to find what your " +
    "own last batch changed. has_more: true means call again immediately with the returned cursor " +
    "to keep draining; has_more: false means you are caught up - the returned cursor safely skips " +
    "nothing if you poll again later.",
  input: z
    .object({
      cursor: z.string().describe('Seq to resume after; "0" for the beginning of history'),
      page: z.string().min(1).max(512).optional().describe("Only changes to this page"),
      actor: z.string().optional().describe("Only changes by this actor label (exact match)"),
      origin: OriginEnum.optional(),
      limit: Limit,
    })
    .strict(),
  output: z.object({
    items: z.array(
      z.object({
        seq: z.number().int(),
        at: z.string(),
        origin: OriginEnum,
        actor: z.string(),
        client: z.string().optional(),
        batch_id: z.string(),
        kind: z.enum([
          "block.created",
          "block.updated",
          "block.moved",
          "block.deleted",
          "block.restored",
          "page.created",
          "page.renamed",
          "page.updated",
          "page.deleted",
          "page.restored",
        ]),
        page: z.string(),
        block_id: z.string().optional(),
        summary: z.string(),
      }),
    ),
    cursor: z.string().describe("Pass as cursor on the next call"),
    has_more: z
      .boolean()
      .describe("true = more events available now, call again immediately; false = caught up"),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ["read"],
  render: (out) => `${out.items.length} change(s), has_more=${out.has_more}`,
  handler: async (input, ctx) => {
    const cursorNum = Number(input.cursor);
    if (!Number.isInteger(cursorNum) || cursorNum < 0) {
      throw new OpError(
        "invalid",
        "cursor is not a valid seq",
        'pass a numeric seq string, or "0" for the beginning',
      );
    }
    const driver = ctx.db;
    const conditions = ["seq > ?"];
    const params: unknown[] = [cursorNum];
    if (input.actor) {
      conditions.push("actor = ?");
      params.push(input.actor);
    }
    if (input.origin) {
      conditions.push("origin = ?");
      params.push(input.origin);
    }
    if (input.page) {
      const page = await requirePage(ctx, input.page);
      conditions.push(
        "((entity_type = 'page' AND entity_id = ?) OR (entity_type = 'block' AND entity_id IN (SELECT id FROM block WHERE page_id = ?)))",
      );
      params.push(page.id, page.id);
    }
    const rows = driver.all<ChangeRow>(
      `SELECT seq, created_at, origin, actor, batch_id, entity_type, entity_id, op_ids_json FROM changes WHERE ${conditions.join(" AND ")} ORDER BY seq ASC LIMIT ?`,
      [...params, input.limit + 1],
    );
    const hasMore = rows.length > input.limit;
    const page = rows.slice(0, input.limit);

    const items = page.map((r) => {
      const ops = opsForRow(driver, r.op_ids_json);
      const { kind, summary } = classify(r.entity_type, ops);
      let pageWire: string;
      let blockId: string | undefined;
      if (r.entity_type === "page") {
        const p = driver.get<{ name: string; journal_day: number | null }>(
          "SELECT name, journal_day FROM page WHERE id = ?",
          [r.entity_id],
        );
        pageWire = p
          ? wirePageName({
              id: r.entity_id,
              name: p.name,
              key: "",
              journalDay: p.journal_day,
              properties: {},
              createdAt: 0,
              updatedAt: 0,
            })
          : r.entity_id;
      } else {
        blockId = r.entity_id;
        const b = driver.get<{ page_id: string }>("SELECT page_id FROM block WHERE id = ?", [
          r.entity_id,
        ]);
        const p = b
          ? driver.get<{ name: string; journal_day: number | null }>(
              "SELECT name, journal_day FROM page WHERE id = ?",
              [b.page_id],
            )
          : undefined;
        pageWire = p
          ? wirePageName({
              id: b?.page_id ?? "",
              name: p.name,
              key: "",
              journalDay: p.journal_day,
              properties: {},
              createdAt: 0,
              updatedAt: 0,
            })
          : (b?.page_id ?? "");
      }
      return {
        seq: r.seq,
        at: new Date(r.created_at).toISOString(),
        origin: r.origin as z.infer<typeof OriginEnum>,
        actor: r.actor,
        batch_id: r.batch_id,
        kind: kind as
          | "block.created"
          | "block.updated"
          | "block.moved"
          | "block.deleted"
          | "block.restored"
          | "page.created"
          | "page.renamed"
          | "page.updated"
          | "page.deleted"
          | "page.restored",
        page: pageWire,
        block_id: blockId,
        summary,
      };
    });

    const cursor = hasMore
      ? String(page[page.length - 1]?.seq ?? cursorNum)
      : String(currentHeadSeq(driver));
    return { items, cursor, has_more: hasMore };
  },
});
