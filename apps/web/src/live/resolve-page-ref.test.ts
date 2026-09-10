import { newId } from "@nooklet/core";
import { describe, expect, it } from "vitest";
import {
  journalDayForRef,
  type PageRefQuery,
  type ResolvedPageRef,
  resolvePageRef,
} from "./resolve-page-ref.js";

function fakeQuery(rows: {
  byId?: Record<string, ResolvedPageRef>;
  byName?: Record<string, ResolvedPageRef>;
  byJournalDay?: Record<number, ResolvedPageRef>;
}): PageRefQuery & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async byId(id) {
      calls.push(`byId:${id}`);
      return rows.byId?.[id] ?? null;
    },
    async byName(name) {
      calls.push(`byName:${name}`);
      return rows.byName?.[name] ?? null;
    },
    async byJournalDay(day) {
      calls.push(`byJournalDay:${day}`);
      return rows.byJournalDay?.[day] ?? null;
    },
  };
}

const FIXED_NOW = () => new Date(2026, 8, 11); // 2026-09-11 (month is 0-indexed)

describe("journalDayForRef", () => {
  it("resolves today/yesterday/tomorrow relative to the injected clock", () => {
    expect(journalDayForRef("today", FIXED_NOW)).toBe(20260911);
    expect(journalDayForRef("yesterday", FIXED_NOW)).toBe(20260910);
    expect(journalDayForRef("tomorrow", FIXED_NOW)).toBe(20260912);
  });

  it("is case-insensitive", () => {
    expect(journalDayForRef("Today", FIXED_NOW)).toBe(20260911);
    expect(journalDayForRef("YESTERDAY", FIXED_NOW)).toBe(20260910);
  });

  it("parses a literal YYYY-MM-DD", () => {
    expect(journalDayForRef("2026-01-05", FIXED_NOW)).toBe(20260105);
  });

  it("returns null for anything else (a plain page name)", () => {
    expect(journalDayForRef("Projects/Aurora", FIXED_NOW)).toBeNull();
  });
});

describe("resolvePageRef", () => {
  it("resolves a 14-char id via byId, without touching byName/byJournalDay", async () => {
    const id = newId();
    const row: ResolvedPageRef = { id, name: "Projects/Aurora", journalDay: null };
    const query = fakeQuery({ byId: { [id]: row } });
    expect(await resolvePageRef(id, query)).toEqual(row);
    expect(query.calls).toEqual([`byId:${id}`]);
  });

  it("falls through to journal-day resolution for 'today'/dates", async () => {
    const row: ResolvedPageRef = { id: "p1", name: "2026-09-11", journalDay: 20260911 };
    const query = fakeQuery({ byJournalDay: { 20260911: row } });
    expect(await resolvePageRef("today", query, FIXED_NOW)).toEqual(row);
  });

  it("falls through to an exact page name when neither an id nor a date matches", async () => {
    const row: ResolvedPageRef = { id: "p2", name: "Projects/Aurora", journalDay: null };
    const query = fakeQuery({ byName: { "Projects/Aurora": row } });
    expect(await resolvePageRef("Projects/Aurora", query)).toEqual(row);
  });

  it("an id-shaped string that isn't a real page still falls through to name lookup", async () => {
    const fakeIdLikeName = newId(); // structurally a valid id, but not registered anywhere
    const row: ResolvedPageRef = { id: "p3", name: fakeIdLikeName, journalDay: null };
    const query = fakeQuery({ byName: { [fakeIdLikeName]: row } });
    expect(await resolvePageRef(fakeIdLikeName, query)).toEqual(row);
    expect(query.calls[0]).toBe(`byId:${fakeIdLikeName}`);
    expect(query.calls).toContain(`byName:${fakeIdLikeName}`);
  });

  it("returns null (never throws) when nothing matches at all", async () => {
    const query = fakeQuery({});
    expect(await resolvePageRef("No Such Page", query)).toBeNull();
  });

  it("returns null for an empty/blank ref without calling the query at all", async () => {
    const query = fakeQuery({});
    expect(await resolvePageRef("   ", query)).toBeNull();
    expect(query.calls).toEqual([]);
  });
});
