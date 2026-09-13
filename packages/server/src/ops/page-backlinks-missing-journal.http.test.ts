/**
 * B-322: `page.backlinks` for a journal day that has no page yet, asked for by a non-ISO title.
 * References are indexed under `refKeyOf` (a date in any journal title format collapses to its ISO
 * key), but the missing-page branch matched them under the raw name — so `Sep 20th, 2026` found no
 * linked references while `2026-09-20` did, and a block linking the day came back as an unlinked
 * mention of it.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { type JsonAny, makeTestServer, post, type TestServer } from "../test-helpers.js";

let s: TestServer;

beforeEach(() => {
  s = makeTestServer();
});

async function backlinks(body: Record<string, unknown>): Promise<JsonAny> {
  const { status, json } = await post(s.app, "/api/v1/page.backlinks", s.writeToken, body);
  expect(status).toBe(200);
  return json;
}

describe("page.backlinks for a journal day with no page yet (B-322)", () => {
  beforeEach(async () => {
    const { status } = await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Plans",
      markdown: [
        "- trip on [[2026-09-20]]",
        "- packing for [[Sep 20th, 2026]]",
        "- Sep 20th, 2026 is a Sunday",
        "- unrelated",
      ].join("\n"),
    });
    expect(status).toBe(200);
  });

  it("finds the same linked references by any journal title as by the ISO name", async () => {
    const iso = await backlinks({ target: "2026-09-20" });
    expect(iso.linked.map((l: { text: string }) => l.text).sort()).toEqual([
      "packing for [[Sep 20th, 2026]]",
      "trip on [[2026-09-20]]",
    ]);
    for (const target of ["Sep 20th, 2026", "20.09.2026"]) {
      const out = await backlinks({ target });
      expect(out.linked_total, target).toBe(2);
      expect(out.linked.map((l: { id: string }) => l.id).sort(), target).toEqual(
        iso.linked.map((l: { id: string }) => l.id).sort(),
      );
    }
  });

  it("does not list a block that links the day as an unlinked mention of it", async () => {
    const out = await backlinks({ target: "Sep 20th, 2026", include_unlinked: true });
    expect(out.unlinked.map((u: { text: string }) => u.text)).toEqual([
      "Sep 20th, 2026 is a Sunday",
    ]);
  });
});
