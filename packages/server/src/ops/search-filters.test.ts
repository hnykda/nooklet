/**
 * `search`'s filters that the web client's Search view exposes (audit §2 #11): `properties` on the
 * reserved task keys, `journals_only`, and `scope`. Its own file rather than more of
 * `ops.http.test.ts`, which many branches edit.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { makeTestServer, post, type TestServer } from "../test-helpers.js";

let s: TestServer;

beforeEach(() => {
  s = makeTestServer();
});

interface Hit {
  kind: string;
  page: string;
  snippet: string;
}

async function search(body: Record<string, unknown>): Promise<Hit[]> {
  const { status, json } = await post(s.app, "/api/v1/search", s.writeToken, {
    mode: "keyword",
    ...body,
  });
  expect(status, JSON.stringify(json)).toBe(200);
  return json.hits as Hit[];
}

describe("search: properties on reserved task keys (B-238)", () => {
  beforeEach(async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Errands",
      markdown: "- TODO buy milk\n- DONE buy bread\n- LATER [#A] buy coffee\n- buy eggs",
    });
  });

  it("marker matches the block's task marker, which lives in a column, not block_prop", async () => {
    // The description promised {"marker":"TODO"}; the filter only ever looked in `block_prop`,
    // where a marker is never stored, so every marker filter returned nothing.
    const todo = await search({ query: "buy", scope: "blocks", properties: { marker: "TODO" } });
    expect(todo.map((h) => h.snippet)).toEqual(["**buy** milk"]);
    const later = await search({ query: "buy", scope: "blocks", properties: { marker: "LATER" } });
    expect(later.map((h) => h.snippet)).toEqual(["**buy** coffee"]);
  });

  it("priority matches the block's priority column", async () => {
    const a = await search({ query: "buy", scope: "blocks", properties: { priority: "A" } });
    expect(a.map((h) => h.snippet)).toEqual(["**buy** coffee"]);
  });

  it("repeat matches the block's repeat column", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Chores",
      markdown: "- TODO buy plant food\n  scheduled:: 2026-09-14\n  repeat:: 1w",
    });
    const hits = await search({ query: "buy", scope: "blocks", properties: { repeat: "1w" } });
    expect(hits.map((h) => h.page)).toEqual(["Chores"]);
  });

  it("an ordinary property still matches block_prop", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Reading",
      markdown: "- buy a book\n  author:: Čapek",
    });
    const hits = await search({ query: "buy", scope: "blocks", properties: { author: "Čapek" } });
    expect(hits.map((h) => h.page)).toEqual(["Reading"]);
  });
});
