/**
 * What `block.to_page` names the page when the first line is Markdown rather than plain words
 * (QA finding Q4, docs/bugs-inbox/qafix-views.md B-254). The two first lines below are the real
 * ones from the owner's graph that produced `## Plánování…` and `[[[[Alex]] by chtěl…]]`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { type JsonAny, makeTestServer, post, type TestServer } from "../test-helpers.js";
import { verifyRebuildParity } from "../verify.js";

let s: TestServer;
beforeEach(() => {
  s = makeTestServer();
});

async function tree(page: string): Promise<JsonAny> {
  const r = await post(s.app, "/api/v1/page.read", s.writeToken, { page, format: "json" });
  return r.status === 200 ? r.json.tree : undefined;
}

function shape(nodes: JsonAny[]): unknown[] {
  return nodes.map((n) => [n.content, shape(n.children)]);
}

describe("block.to_page names a page by the first line's text, not its markup", () => {
  it("drops a heading marker, lands on the existing page of that name, and keeps the heading on the block", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Plánování zahradních úprav",
      markdown: "- already here",
    });
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Megapage",
      markdown: "- ## Plánování zahradních úprav\n  - jedna\n  - dva\n  - tři\n- next",
    });
    const id = (await tree("Megapage"))[0].id as string;

    const { status, json } = await post(s.app, "/api/v1/block.to_page", s.writeToken, { id });
    expect(status).toBe(200);
    expect(json).toMatchObject({
      page: "Plánování zahradních úprav",
      page_created: false,
      link: "## [[Plánování zahradních úprav]]",
      moved: 3,
    });
    expect(shape(await tree("Megapage"))).toEqual([
      ["## [[Plánování zahradních úprav]]", []],
      ["next", []],
    ]);
    expect(shape(await tree("Plánování zahradních úprav"))).toEqual([
      ["already here", []],
      ["jedna", []],
      ["dva", []],
      ["tři", []],
    ]);
    expect(verifyRebuildParity(s.serverCtx.driver).divergences).toEqual([]);
  });

  it("reduces inline links to their text instead of nesting brackets", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Links Home",
      markdown:
        "- [[Alex]] by chtěl něco jako:\n  - child\n- [[Real Page|shown label]] notes\n  - c",
    });
    const [first, second] = (await tree("Links Home")) as JsonAny[];

    const a = await post(s.app, "/api/v1/block.to_page", s.writeToken, { id: first.id });
    expect(a.json).toMatchObject({
      page: "Alex by chtěl něco jako:",
      link: "[[Alex by chtěl něco jako:]]",
    });
    const b = await post(s.app, "/api/v1/block.to_page", s.writeToken, { id: second.id });
    expect(b.json).toMatchObject({ page: "shown label notes", link: "[[shown label notes]]" });
  });

  it("a heading whose text is one [[link]] names that page", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Heading Link Home",
      markdown: "- ### [[Linked Target]]\n  - under it",
    });
    const id = (await tree("Heading Link Home"))[0].id as string;
    const { json } = await post(s.app, "/api/v1/block.to_page", s.writeToken, { id });
    expect(json).toMatchObject({ page: "Linked Target", link: "### [[Linked Target]]" });
    expect(shape(await tree("Linked Target"))).toEqual([["under it", []]]);
  });

  it("a first line that is only a heading marker has no name", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Bare Heading",
      markdown: "- ##\n  - child",
    });
    const id = (await tree("Bare Heading"))[0].id as string;
    const { status, json } = await post(s.app, "/api/v1/block.to_page", s.writeToken, { id });
    expect(status).toBe(400);
    expect(json.error.code).toBe("invalid");
  });
});
