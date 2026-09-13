/**
 * `page.backlinks` says how much there is (B-253): `linked_total` across every page of results,
 * and `unlinked_truncated` when `unlinked_limit` stopped short. Before, unlinked mentions were a
 * silent 50 and a caller could not tell a page with 50 mentions from one with 500.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestServer, post, type TestServer } from "../test-helpers.js";

let s: TestServer;

beforeEach(() => {
  s = makeTestServer();
});

function bullets(n: number, line: (i: number) => string): string {
  return Array.from({ length: n }, (_, i) => `- ${line(i + 1)}`).join("\n");
}

describe("page.backlinks totals", () => {
  beforeEach(async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Totals Target" });
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Totals Linked",
      markdown: bullets(7, (i) => `[[Totals Target]] ${i}`),
    });
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Totals Plain",
      markdown: bullets(60, (i) => `plain Totals Target ${i}`),
    });
  });

  it("counts every linked reference while returning one page of them", async () => {
    const { status, json } = await post(s.app, "/api/v1/page.backlinks", s.writeToken, {
      target: "Totals Target",
      limit: 3,
    });
    expect(status).toBe(200);
    expect(json.linked).toHaveLength(3);
    expect(json.linked_total).toBe(7);
    expect(json.cursor).toBeTypeOf("string");
  });

  it("keeps the default of 50 unlinked mentions, and says there are more", async () => {
    const { json } = await post(s.app, "/api/v1/page.backlinks", s.writeToken, {
      target: "Totals Target",
      include_unlinked: true,
    });
    expect(json.unlinked).toHaveLength(50);
    expect(json.unlinked_truncated).toBe(true);
  });

  it("returns up to unlinked_limit, not truncated when that covers them all", async () => {
    const { json } = await post(s.app, "/api/v1/page.backlinks", s.writeToken, {
      target: "Totals Target",
      include_unlinked: true,
      unlinked_limit: 500,
    });
    expect(json.unlinked).toHaveLength(60);
    expect(json.unlinked_truncated).toBe(false);
  });
});
