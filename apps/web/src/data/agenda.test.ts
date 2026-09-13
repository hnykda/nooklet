/**
 * `AGENDA_SQL` against a real in-memory SQLite carrying the client's own DDL: which rows reach the
 * "Scheduled and deadline" section at all, before `views/agendaDay.ts` decides the day.
 */

import { DatabaseSync } from "node:sqlite";
import { CORE_SCHEMA_STATEMENTS } from "@nooklet/core";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../db/client.js", () => ({ queryAs: vi.fn() }));
vi.mock("./store.js", () => ({
  stampedFor: <T>(value: T) => ({ value, version: 0 }),
}));

import { AGENDA_SQL, type AgendaSqlRunner, loadAgendaTasks } from "./agenda.js";

describe("loadAgendaTasks", () => {
  const db = new DatabaseSync(":memory:");
  const sql: AgendaSqlRunner = async <T>(s: string, params: unknown[] = []) =>
    db.prepare(s).all(...(params as never[])) as T[];
  let seq = 0;

  function page(id: string, name: string, opts: { journalDay?: number; deleted?: boolean } = {}) {
    db.prepare(
      `INSERT INTO page (id, name, key, journal_day, created_at, updated_at, deleted_at, name_hlc)
       VALUES (?,?,?,?,1,1,?,'h')`,
    ).run(id, name, name.toLowerCase(), opts.journalDay ?? null, opts.deleted ? 5 : null);
  }

  function block(
    content: string,
    pageId: string,
    opts: {
      marker?: string;
      scheduled?: number;
      scheduledTime?: string;
      deadline?: number;
      deleted?: boolean;
    } = {},
  ): void {
    seq++;
    db.prepare(
      `INSERT INTO block (id, page_id, parent_id, order_key, content, marker, scheduled_day,
         scheduled_time, deadline_day, created_at, updated_at, deleted_at, place_hlc, content_hlc)
       VALUES (?,?,NULL,?,?,?,?,?,?,1,1,?,'h','h')`,
    ).run(
      `b${String(seq).padStart(13, "0")}`,
      pageId,
      `a${seq}`,
      content,
      opts.marker ?? null,
      opts.scheduled ?? null,
      opts.scheduledTime ?? null,
      opts.deadline ?? null,
      opts.deleted ? 5 : null,
    );
  }

  beforeAll(() => {
    for (const s of CORE_SCHEMA_STATEMENTS) db.exec(s);
    page("p1", "Project");
    page("p2", "2026-09-10", { journalDay: 20260910 });
    page("gone", "Deleted page", { deleted: true });

    for (const m of ["TODO", "DOING", "LATER", "NOW", "WAITING"]) {
      block(`open ${m}`, "p1", { marker: m, scheduled: 20260913 });
    }
    block("done", "p1", { marker: "DONE", scheduled: 20260913 });
    block("canceled", "p1", { marker: "CANCELED", deadline: 20260913 });
    block("no marker, dated", "p1", { scheduled: 20260913 });
    block("open, undated", "p1", { marker: "TODO" });
    block("deleted task", "p1", { marker: "TODO", scheduled: 20260913, deleted: true });
    block("on a deleted page", "gone", { marker: "TODO", scheduled: 20260913 });
    block("deadline only", "p2", { marker: "TODO", deadline: 20260920 });
    block("timed", "p2", { marker: "TODO", scheduled: 20260914, scheduledTime: "09:30" });
  });

  it("returns open tasks with either date, and nothing finished, undated, marker-less or deleted", async () => {
    const rows = await loadAgendaTasks(sql);
    expect(rows.map((r) => r.content).sort()).toEqual(
      [
        "deadline only",
        "open DOING",
        "open LATER",
        "open NOW",
        "open TODO",
        "open WAITING",
        "timed",
      ].sort(),
    );
  });

  it("maps the columns the section needs", async () => {
    const rows = await loadAgendaTasks(sql);
    expect(rows.find((r) => r.content === "timed")).toMatchObject({
      pageId: "p2",
      pageName: "2026-09-10",
      pageJournalDay: 20260910,
      marker: "TODO",
      scheduledDay: 20260914,
      scheduledTime: "09:30",
      deadlineDay: null,
    });
    expect(rows.find((r) => r.content === "deadline only")).toMatchObject({
      scheduledDay: null,
      deadlineDay: 20260920,
    });
  });

  it("reads only open tasks through an index, never the whole block table", () => {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${AGENDA_SQL}`).all() as Array<{ detail: string }>;
    const scanOfBlock = plan.find((p) => /^SCAN b\b/.test(p.detail));
    expect(scanOfBlock, JSON.stringify(plan)).toBeUndefined();
  });
});
