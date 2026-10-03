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

/**
 * refs-count (owner decision 2026-10-03): the heading counts what Logseq counts — blocks whose own
 * refs name the page — so each linked item says whether it is one, and `linked_direct_total`
 * counts them. Children of a linking block are still linked references (path_ref), just not direct.
 */
describe("page.backlinks direct references", () => {
  beforeEach(async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Direct Target",
      markdown: "- alias:: Direct Alias",
    });
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Direct Source",
      markdown: [
        "- parent links [[Direct Target]]",
        "  - child only inherits",
        "    - grandchild #[[Direct Target]] again",
        "- via the alias [[Direct Alias]]",
        "  - under the alias link",
      ].join("\n"),
    });
  });

  it("marks blocks that link the page themselves, aliases included, and counts them", async () => {
    const { json } = await post(s.app, "/api/v1/page.backlinks", s.writeToken, {
      target: "Direct Target",
    });
    const byText = new Map(
      (json.linked as Array<{ text: string; direct: boolean }>).map((r) => [r.text, r.direct]),
    );
    expect(json.linked_total).toBe(5);
    expect(byText.get("parent links [[Direct Target]]")).toBe(true);
    expect(byText.get("child only inherits")).toBe(false);
    expect(byText.get("grandchild #[[Direct Target]] again")).toBe(true);
    expect(byText.get("via the alias [[Direct Alias]]")).toBe(true);
    expect(byText.get("under the alias link")).toBe(false);
    expect(json.linked_direct_total).toBe(3);
  });

  it("counts direct references for a page that does not exist yet", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Unmade Source",
      markdown: "- see [[Not Made Yet]]\n  - nested under it",
    });
    const { json } = await post(s.app, "/api/v1/page.backlinks", s.writeToken, {
      target: "Not Made Yet",
    });
    expect(json.linked_total).toBe(2);
    expect(json.linked_direct_total).toBe(1);
  });
});
