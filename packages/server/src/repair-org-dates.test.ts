/**
 * `nooklet repair org-dates` (./repair-org-dates.ts): blocks imported before B-143 still hold
 * `SCHEDULED: <2023-2-17 Fri>` as text. The repair must give each the date a re-import would, take
 * the line out, write it all as one undoable batch through `serverApplyOps` — and refuse, writing
 * nothing, whenever that is not clearly right.
 */

import { formatHlc, newId, type Op, type OpPayload } from "@nooklet/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createServerContext, type ServerContext, serverApplyOps } from "./apply-ops.js";
import {
  applyOrgDateRepair,
  formatOrgDateReport,
  ORG_DATES_ACTOR,
  planOrgDateRepair,
} from "./repair-org-dates.js";
import { makeTestServer, post, type TestServer } from "./test-helpers.js";
import { verifyRebuildParity } from "./verify.js";

let s: TestServer;
let ctx: ServerContext;
let journal: string;
let order = 0;

function op(entity: string, payload: OpPayload, hlc = ctx.hlc.next()): Op {
  return { id: hlc, hlc, device: "aaaaaaaa", entity, payload };
}

/** A block written the way the old importer left it: the org line is part of the text. */
function oldBlock(
  content: string,
  opts: { marker?: "DONE" | "TODO"; properties?: Record<string, string>; hlc?: string } = {},
): string {
  const id = newId();
  order++;
  serverApplyOps(
    ctx,
    [
      op(
        id,
        {
          kind: "block.create",
          place: { pageId: journal, parentId: null, order: `a${order}` },
          content,
          ...(opts.marker ? { marker: opts.marker } : {}),
          ...(opts.properties ? { properties: opts.properties } : {}),
          createdAt: Date.now(),
        },
        opts.hlc,
      ),
    ],
    { origin: "import", actor: "test" },
  );
  return id;
}

interface Row {
  content: string;
  marker: string | null;
  scheduled_day: number | null;
  scheduled_time: string | null;
  deadline_day: number | null;
  deadline_time: string | null;
  repeat: string | null;
}

function row(id: string): Row {
  return ctx.driver.get<Row>(
    "SELECT content, marker, scheduled_day, scheduled_time, deadline_day, deadline_time, repeat FROM block WHERE id = ?",
    [id],
  ) as Row;
}

const opCount = (): number => ctx.driver.get<{ n: number }>("SELECT count(*) AS n FROM op")?.n ?? 0;

beforeEach(() => {
  s = makeTestServer();
  ctx = s.serverCtx;
  journal = newId();
  serverApplyOps(
    ctx,
    [op(journal, { kind: "page.create", name: "2023-02-17", journalDay: 20230217, createdAt: 1 })],
    { origin: "import", actor: "test" },
  );
});

describe("repair org-dates", () => {
  it("dry run lists each block before and after and writes nothing", () => {
    const lauko = oldBlock("Mirek\nSCHEDULED: <2023-2-17 Fri>", { marker: "DONE" });
    const before = opCount();

    const plan = planOrgDateRepair(ctx);
    expect(plan.skipped).toEqual([]);
    expect(plan.repairs).toEqual([
      {
        blockId: lauko,
        page: "2023-02-17",
        marker: "DONE",
        before: {
          content: "Mirek\nSCHEDULED: <2023-2-17 Fri>",
          scheduled: null,
          deadline: null,
          repeat: null,
        },
        after: { content: "Mirek", scheduled: "2023-02-17", deadline: null, repeat: null },
      },
    ]);
    expect(opCount()).toBe(before);
    expect(row(lauko).content).toBe("Mirek\nSCHEDULED: <2023-2-17 Fri>");
    const report = formatOrgDateReport(plan);
    expect(report).toContain(lauko);
    expect(report).toContain('before: "Mirek\\nSCHEDULED: <2023-2-17 Fri>"  (no dates)');
    expect(report).toContain('after:  "Mirek"  (scheduled 2023-02-17)');
    expect(report).toContain("dry run: would repair 1 block; run again with --apply");
  });

  it("writes the dates and drops the lines as one batch that verify replays exactly", () => {
    const done = oldBlock("Mirek\nSCHEDULED: <2023-2-17 Fri>", { marker: "DONE" });
    const plain = oldBlock("poslechnout nové album\nSCHEDULED: <2023-2-17 Fri>");
    const timed = oldBlock("standup\nDEADLINE: <2026-9-14 Mon 9:30 .+1w>\nnotes after", {
      marker: "TODO",
    });
    const untouched = oldBlock("nothing to see");

    const result = applyOrgDateRepair(ctx);
    expect(result.repairs.map((r) => r.blockId).sort()).toEqual([done, plain, timed].sort());
    expect(result.batchId).toBeTypeOf("string");

    expect(row(done)).toMatchObject({ content: "Mirek", marker: "DONE", scheduled_day: 20230217 });
    expect(row(plain)).toMatchObject({
      content: "poslechnout nové album",
      marker: null,
      scheduled_day: 20230217,
      scheduled_time: null,
    });
    expect(row(timed)).toMatchObject({
      content: "standup\nnotes after",
      deadline_day: 20260914,
      deadline_time: "09:30",
      repeat: "1w",
      scheduled_day: null,
    });
    expect(row(untouched).content).toBe("nothing to see");

    const changes = ctx.driver.all<{ batch_id: string; actor: string; entity_id: string }>(
      "SELECT DISTINCT batch_id, actor, entity_id FROM changes WHERE actor = ?",
      [ORG_DATES_ACTOR],
    );
    expect(new Set(changes.map((c) => c.batch_id))).toEqual(new Set([result.batchId]));
    expect(new Set(changes.map((c) => c.entity_id))).toEqual(new Set([done, plain, timed]));
    expect(verifyRebuildParity(ctx.driver).ok).toBe(true);

    // Nothing left to do the second time.
    const again = applyOrgDateRepair(ctx);
    expect(again.repairs).toEqual([]);
    expect(again.batchId).toBeUndefined();
    expect(formatOrgDateReport(again, again)).toBe("nothing to repair");
  });

  it("batch_undo with the printed batch_id puts every block back as it was", async () => {
    const a = oldBlock("Mirek\nSCHEDULED: <2023-2-17 Fri>", { marker: "DONE" });
    const b = oldBlock("x\nDEADLINE: <2022-12-8 Thu .+2d>");
    const result = applyOrgDateRepair(ctx);
    expect(formatOrgDateReport(result, result)).toContain(`batch_id ${result.batchId}`);

    const undo = await post(s.app, "/api/v1/batch.undo", s.writeToken, {
      batch_id: result.batchId,
    });
    expect(undo.status).toBe(200);
    expect(row(a)).toMatchObject({
      content: "Mirek\nSCHEDULED: <2023-2-17 Fri>",
      scheduled_day: null,
      marker: "DONE",
    });
    expect(row(b)).toMatchObject({
      content: "x\nDEADLINE: <2022-12-8 Thu .+2d>",
      deadline_day: null,
      repeat: null,
    });
    expect(verifyRebuildParity(ctx.driver).ok).toBe(true);
  });

  it("leaves alone a block whose text disagrees with a date it has, or names two dates", () => {
    const conflicting = oldBlock("moved since\nSCHEDULED: <2023-2-17 Fri>", {
      properties: { scheduled: "2023-03-01" },
    });
    const twice = oldBlock("a\nSCHEDULED: <2023-2-17 Fri>\nSCHEDULED: <2023-2-18 Sat>");
    const twoRepeats = oldBlock(
      "b\nSCHEDULED: <2023-2-17 Fri .+1d>\nDEADLINE: <2023-2-20 Mon .+1w>",
    );
    const sameDate = oldBlock("c\nSCHEDULED: <2023-2-17 Fri>", {
      properties: { scheduled: "2023-02-17" },
    });
    const fenced = oldBlock("code\n```org\nSCHEDULED: <2023-2-17 Fri>\n```");
    const impossible = oldBlock("d\nSCHEDULED: <2023-2-30 Thu>");
    const trashed = oldBlock("e\nSCHEDULED: <2023-2-17 Fri>");
    serverApplyOps(ctx, [op(trashed, { kind: "block.delete", deletedAt: Date.now() })], {
      origin: "user",
      actor: "test",
    });

    const result = applyOrgDateRepair(ctx);
    expect(result.skipped.map((k) => [k.blockId, k.reason])).toEqual(
      expect.arrayContaining([
        [conflicting, "it already has scheduled 2023-03-01, and its text says 2023-02-17"],
        [twice, "its text names 2 different scheduled dates (2023-02-17, 2023-02-18)"],
        [twoRepeats, "its text names 2 different repeats (1d, 1w)"],
      ]),
    );
    expect(result.skipped).toHaveLength(3);
    // A date it already has, written again as text: only the line goes.
    expect(result.repairs.map((r) => r.blockId)).toEqual([sameDate]);
    expect(row(sameDate)).toMatchObject({ content: "c", scheduled_day: 20230217 });
    expect(row(conflicting)).toMatchObject({
      content: "moved since\nSCHEDULED: <2023-2-17 Fri>",
      scheduled_day: 20230301,
    });
    for (const id of [twice, twoRepeats, fenced, impossible, trashed]) {
      expect(row(id).scheduled_day).toBeNull();
    }
    expect(row(fenced).content).toBe("code\n```org\nSCHEDULED: <2023-2-17 Fri>\n```");
    expect(formatOrgDateReport(result, result)).toContain("3 left alone (see above)");
  });

  it("wins over a field last written by a device whose clock ran ahead", () => {
    // 30 s ahead: inside the drift the server accepts. A fresh CLI process's clock (a new
    // ServerContext) is behind that HLC, and without absorbing it first the text op was a noop.
    const ahead = formatHlc({ wall: Date.now() + 30_000, counter: 0, device: "aaaaaaaa" });
    const id = oldBlock("ahead\nSCHEDULED: <2023-2-17 Fri>", { hlc: ahead });
    const cli = createServerContext(ctx.driver);

    const result = applyOrgDateRepair(cli);
    expect(result.repairs).toHaveLength(1);
    expect(row(id)).toMatchObject({ content: "ahead", scheduled_day: 20230217 });
  });

  it("writes nothing at all when one block cannot be repaired safely", () => {
    const fine = oldBlock("fine\nSCHEDULED: <2023-2-17 Fri>");
    const bad = oldBlock("bad\nSCHEDULED: <2023-2-17 Fri>");
    // A content HLC far in the future: absorbing it throws HLC drift, halfway through the plan.
    ctx.driver.run("UPDATE block SET content_hlc = ? WHERE id = ?", [
      formatHlc({ wall: Date.now() + 3_600_000, counter: 0, device: "aaaaaaaa" }),
      bad,
    ]);
    const before = opCount();

    expect(() => applyOrgDateRepair(createServerContext(ctx.driver))).toThrow(/drift/i);
    expect(opCount()).toBe(before);
    expect(row(fine)).toMatchObject({
      content: "fine\nSCHEDULED: <2023-2-17 Fri>",
      scheduled_day: null,
    });
  });
});
