/**
 * `page.update` on a journal day (B-236): renaming one stays refused — a journal is addressed by
 * its date — but setting properties is not a rename. The handler refused every journal update
 * before looking at what was asked, so an agent could not favourite, lock or give an icon to a day
 * while a person could (the properties panel writes `page.prop` locally).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestServer, post, type TestServer } from "../test-helpers.js";
import { verifyRebuildParity } from "../verify.js";

let s: TestServer;
beforeEach(() => {
  s = makeTestServer();
});

const DAY = "2026-08-17";

async function journalDay(): Promise<void> {
  const r = await post(s.app, "/api/v1/page.append", s.writeToken, {
    page: DAY,
    markdown: "- a note on the day",
  });
  expect(r.status).toBe(200);
}

describe("page.update on a journal day (B-236)", () => {
  it("sets and unsets properties without a new_name", async () => {
    await journalDay();
    const set = await post(s.app, "/api/v1/page.update", s.writeToken, {
      page: DAY,
      properties: { "read-only": "true", favorite: "true" },
    });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    expect(set.json.page.kind).toBe("journal");
    expect(set.json.page.properties).toEqual({ "read-only": "true", favorite: "true" });
    expect(set.json.refs_rewritten).toBe(0);

    const unset = await post(s.app, "/api/v1/page.update", s.writeToken, {
      page: DAY,
      properties: { favorite: null },
    });
    expect(unset.status, JSON.stringify(unset.json)).toBe(200);
    expect(unset.json.page.properties).toEqual({ "read-only": "true" });
    expect(verifyRebuildParity(s.serverCtx.driver).divergences).toEqual([]);
  });

  it("still refuses to rename a journal day, and writes nothing", async () => {
    await journalDay();
    const r = await post(s.app, "/api/v1/page.update", s.writeToken, {
      page: DAY,
      new_name: "Not a day",
      properties: { favorite: "true" },
    });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("invalid");
    expect(r.json.error.message).toBe("cannot rename a journal day");
    const read = await post(s.app, "/api/v1/page.read", s.writeToken, {
      page: DAY,
      format: "json",
    });
    expect(read.json.page.properties ?? {}).toEqual({});
  });

  it("accepts new_name equal to the day's own name as no rename", async () => {
    await journalDay();
    const read = await post(s.app, "/api/v1/page.read", s.writeToken, {
      page: DAY,
      format: "json",
    });
    const r = await post(s.app, "/api/v1/page.update", s.writeToken, {
      page: DAY,
      new_name: read.json.page.name,
      properties: { icon: "sun" },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.page.properties).toEqual({ icon: "sun" });
  });
});
