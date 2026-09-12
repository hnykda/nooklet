import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { newId } from "@nooklet/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { serverApplyOps } from "../apply-ops.js";
import {
  activateModel,
  buildProviderForModel,
  EmbeddingIndexer,
  getActiveModel,
  getEmbeddingSettings,
  registerModel,
  setEmbeddingSettings,
} from "../embeddings/index.js";
import { type JsonAny, makeTestServer, post, type TestServer } from "../test-helpers.js";

let s: TestServer;

beforeEach(() => {
  s = makeTestServer();
});

interface RowCounts {
  page: number;
  block: number;
  block_prop: number;
  op: number;
  changes: number;
  ref: number;
  path_ref: number;
}

/** Row counts across every table a write can touch, for atomicity/no-op assertions below: a
 * dry_run or a rolled-back batch step must leave every single one of these exactly unchanged. */
function rowCounts(server: TestServer): RowCounts {
  const count = (table: string): number =>
    server.serverCtx.driver.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0;
  return {
    page: count("page"),
    block: count("block"),
    block_prop: count("block_prop"),
    op: count("op"),
    changes: count("changes"),
    ref: count("ref"),
    path_ref: count("path_ref"),
  };
}

describe("graph.overview", () => {
  it("returns counts and a seq (success)", async () => {
    const { status, json } = await post(s.app, "/api/v1/graph.overview", s.writeToken, {});
    expect(status).toBe(200);
    expect(json.counts).toEqual({ pages: 0, journals: 0, blocks: 0 });
    expect(typeof json.seq).toBe("number");
  });

  it("rejects unknown fields (invalid)", async () => {
    const { status, json } = await post(s.app, "/api/v1/graph.overview", s.writeToken, {
      bogus: 1,
    });
    expect(status).toBe(400);
    expect(json.error.code).toBe("invalid");
  });
});

describe("page.create", () => {
  it("creates a page with properties and markdown (success)", async () => {
    const { status, json } = await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Projects/Aurora",
      properties: { tags: "aurora, active" },
      markdown: "- Contact: sam@example.com\n- Payment terms: net 30",
    });
    expect(status).toBe(200);
    expect(json.existed).toBe(false);
    expect(json.created).toHaveLength(2);
    expect(json.outline).toContain("Contact: sam@example.com");
  });

  it("conflicts when if_exists is error and the page already exists", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Dup" });
    const { status, json } = await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Dup",
      if_exists: "error",
    });
    expect(status).toBe(409);
    expect(json.error.code).toBe("conflict");
    expect(json.error.details.page_id).toBeDefined();
  });

  it("dry_run on a new page with markdown calls applyOps twice inside one trial, and mutates nothing", async () => {
    // Creating a brand-new page with markdown does TWO separate writes -- ctx.data.pages.create,
    // then ctx.applyOps(res.ops) for the parsed blocks -- both inside the ONE savepoint dry_run
    // opens. This is exactly the case the old clone-per-trial approach existed to work around: a
    // naive raw SAVEPOINT whose scope transaction() doesn't know about breaks the moment a second
    // nested transaction() (here, the second write) tries to BEGIN again.
    const before = rowCounts(s);
    const { status, json } = await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "NeverSaved",
      markdown: "- a\n  - b",
      dry_run: true,
    });
    expect(status).toBe(200);
    expect(json.existed).toBe(false);
    expect(json.created).toHaveLength(2);
    expect(json.dry_run).toBe(true);

    const check = await post(s.app, "/api/v1/page.read", s.writeToken, { page: "NeverSaved" });
    expect(check.status).toBe(404); // never actually written
    expect(rowCounts(s)).toEqual(before);
  });
});

describe("page.append", () => {
  it("parses nested markdown into a block tree, creating the journal page implicitly (success)", async () => {
    const { status, json } = await post(s.app, "/api/v1/page.append", s.writeToken, {
      page: "today",
      markdown: "- a\n  - b\n  - c\n    - d\n- e",
    });
    expect(status).toBe(200);
    expect(json.created).toHaveLength(5);
    // verify the tree via page.read (json format) rather than re-parsing the outline text
    const read = await post(s.app, "/api/v1/page.read", s.writeToken, {
      page: "today",
      format: "json",
    });
    expect(read.status).toBe(200);
    const tree = read.json.tree;
    expect(tree.map((n: { content: string }) => n.content)).toEqual(["a", "e"]);
    expect(tree[0].children.map((n: { content: string }) => n.content)).toEqual(["b", "c"]);
    expect(tree[0].children[1].children.map((n: { content: string }) => n.content)).toEqual(["d"]);
  });

  it("is invalid when create_page is false and the page does not exist", async () => {
    const { status, json } = await post(s.app, "/api/v1/page.append", s.writeToken, {
      page: "Nonexistent Page",
      markdown: "- x",
      create_page: false,
    });
    expect(status).toBe(400);
    expect(json.error.code).toBe("invalid");
  });
});

describe("page.read", () => {
  it("reads a page as outline markdown with ^ids (success)", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Home", markdown: "- hello" });
    const { status, json } = await post(s.app, "/api/v1/page.read", s.writeToken, { page: "Home" });
    expect(status).toBe(200);
    expect(json.text).toMatch(/- hello \^[0-9a-hjkmnp-tv-z]{14}\n/);
  });

  it("is not_found for a missing page", async () => {
    const { status, json } = await post(s.app, "/api/v1/page.read", s.writeToken, {
      page: "Nope Nope",
    });
    expect(status).toBe(404);
    expect(json.error.code).toBe("not_found");
  });
});

describe("block.read", () => {
  it("reads one block subtree with breadcrumb (success)", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Tree",
      markdown: "- top\n  - child",
    });
    const read = await post(s.app, "/api/v1/page.read", s.writeToken, {
      page: "Tree",
      format: "json",
    });
    const topId = read.json.tree[0].id;
    const childId = read.json.tree[0].children[0].id;
    const { status, json } = await post(s.app, "/api/v1/block.read", s.writeToken, { id: childId });
    expect(status).toBe(200);
    expect(json.breadcrumb).toEqual([{ id: topId, text: "top" }]);
    expect(json.block.content).toBe("child");
  });

  it("is not_found for an unknown block id", async () => {
    const { status, json } = await post(s.app, "/api/v1/block.read", s.writeToken, {
      id: "1k7f3q9xz2hav4",
    });
    expect(status).toBe(404);
    expect(json.error.code).toBe("not_found");
  });
});

describe("block.insert", () => {
  it("inserts markdown relative to a block (success)", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Ins", markdown: "- root" });
    const read = await post(s.app, "/api/v1/page.read", s.writeToken, {
      page: "Ins",
      format: "json",
    });
    const rootId = read.json.tree[0].id;
    const { status, json } = await post(s.app, "/api/v1/block.insert", s.writeToken, {
      ref: rootId,
      position: "child_last",
      markdown: "- Decision\n  - detail",
    });
    expect(status).toBe(200);
    expect(json.created).toHaveLength(2);
    expect(json.outline).toContain("Decision");
  });

  it("is not_found for an unknown ref", async () => {
    const { status, json } = await post(s.app, "/api/v1/block.insert", s.writeToken, {
      ref: "1k7f3q9xz2hav4",
      position: "child_last",
      markdown: "- x",
    });
    expect(status).toBe(404);
    expect(json.error.code).toBe("not_found");
  });
});

describe("block.update", () => {
  it("replaces text via old_str/new_str, auto-stamping done:: on -> DONE (success)", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Tasks",
      markdown: "- TODO buy milk",
    });
    const read = await post(s.app, "/api/v1/page.read", s.writeToken, {
      page: "Tasks",
      format: "json",
    });
    const id = read.json.tree[0].id;
    const { status, json } = await post(s.app, "/api/v1/block.update", s.writeToken, {
      id,
      old_str: "TODO buy milk",
      new_str: "DONE buy milk",
    });
    expect(status).toBe(200);
    expect(json.outline).toContain("DONE buy milk");
    expect(json.outline).toContain("done::");
    expect(json.before).toBe("TODO buy milk");
  });

  it("is invalid when both content and old_str are given", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Bad", markdown: "- x" });
    const read = await post(s.app, "/api/v1/page.read", s.writeToken, {
      page: "Bad",
      format: "json",
    });
    const id = read.json.tree[0].id;
    const { status, json } = await post(s.app, "/api/v1/block.update", s.writeToken, {
      id,
      content: "y",
      old_str: "x",
      new_str: "y",
    });
    expect(status).toBe(400);
    expect(json.error.code).toBe("invalid");
  });
});

describe("block.move", () => {
  it("moves a block subtree (success)", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Mv", markdown: "- a\n- b" });
    const read = await post(s.app, "/api/v1/page.read", s.writeToken, {
      page: "Mv",
      format: "json",
    });
    const [a, b] = read.json.tree;
    const { status } = await post(s.app, "/api/v1/block.move", s.writeToken, {
      id: b.id,
      ref: a.id,
      position: "child_first",
    });
    expect(status).toBe(200);
    const after = await post(s.app, "/api/v1/page.read", s.writeToken, {
      page: "Mv",
      format: "json",
    });
    expect(after.json.tree).toHaveLength(1);
    expect(after.json.tree[0].children[0].content).toBe("b");
  });

  it("rejects moving a block under its own descendant (invalid, cycle)", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Cyc", markdown: "- a\n  - b" });
    const read = await post(s.app, "/api/v1/page.read", s.writeToken, {
      page: "Cyc",
      format: "json",
    });
    const a = read.json.tree[0];
    const b = a.children[0];
    const { status, json } = await post(s.app, "/api/v1/block.move", s.writeToken, {
      id: a.id,
      ref: b.id,
      position: "child_first",
    });
    expect(status).toBe(400);
    expect(json.error.code).toBe("invalid");
  });
});

describe("block.delete", () => {
  it("soft-deletes a subtree (success)", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Del", markdown: "- a\n  - b" });
    const read = await post(s.app, "/api/v1/page.read", s.writeToken, {
      page: "Del",
      format: "json",
    });
    const a = read.json.tree[0];
    const { status, json } = await post(s.app, "/api/v1/block.delete", s.writeToken, { id: a.id });
    expect(status).toBe(200);
    expect(json.deleted_count).toBe(2);
    const after = await post(s.app, "/api/v1/page.read", s.writeToken, {
      page: "Del",
      format: "json",
    });
    expect(after.json.tree).toHaveLength(0);
  });

  it("is not_found for an unknown id", async () => {
    const { status, json } = await post(s.app, "/api/v1/block.delete", s.writeToken, {
      id: "1k7f3q9xz2hav4",
    });
    expect(status).toBe(404);
    expect(json.error.code).toBe("not_found");
  });
});

describe("page.update", () => {
  it("renames a page and rewrites [[links]] to it (success)", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Old Name" });
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Linker",
      markdown: "- see [[Old Name]]",
    });
    const { status, json } = await post(s.app, "/api/v1/page.update", s.writeToken, {
      page: "Old Name",
      new_name: "New Name",
    });
    expect(status).toBe(200);
    expect(json.page.name).toBe("New Name");
    expect(json.refs_rewritten).toBe(1);
    const linker = await post(s.app, "/api/v1/page.read", s.writeToken, { page: "Linker" });
    expect(linker.json.text).toContain("[[New Name]]");
  });

  it("is invalid for a journal day", async () => {
    await post(s.app, "/api/v1/page.append", s.writeToken, { page: "today", markdown: "- x" });
    const { status, json } = await post(s.app, "/api/v1/page.update", s.writeToken, {
      page: "today",
      new_name: "Renamed",
    });
    expect(status).toBe(400);
    expect(json.error.code).toBe("invalid");
  });
});

describe("page.list", () => {
  it("lists pages under a namespace (success)", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Projects/A" });
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Projects/B" });
    const { status, json } = await post(s.app, "/api/v1/page.list", s.writeToken, {
      namespace: "Projects",
    });
    expect(status).toBe(200);
    expect(json.items.map((p: { name: string }) => p.name).sort()).toEqual([
      "Projects/A",
      "Projects/B",
    ]);
  });

  it("is invalid for a malformed cursor", async () => {
    const { status, json } = await post(s.app, "/api/v1/page.list", s.writeToken, {
      cursor: "not-base64-offset!",
    });
    expect(status).toBe(400);
    expect(json.error.code).toBe("invalid");
  });
});

describe("search", () => {
  it("finds a block by keyword (success)", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "SearchMe",
      markdown: "- vendor pricing detail",
    });
    const { status, json } = await post(s.app, "/api/v1/search", s.writeToken, {
      query: "pricing",
    });
    expect(status).toBe(200);
    expect(json.mode_used).toBe("keyword");
    expect(json.hits.some((h: { page: string }) => h.page === "SearchMe")).toBe(true);
  });

  it("is invalid with more than 20 pages", async () => {
    const pages = Array.from({ length: 21 }, (_, i) => `p${i}`);
    const { status, json } = await post(s.app, "/api/v1/search", s.writeToken, {
      query: "x",
      pages,
    });
    expect(status).toBe(400);
    expect(json.error.code).toBe("invalid");
  });
});

describe("page.create journal guard", () => {
  // B-23: the guard used a parser that understood only ISO and today/yesterday/tomorrow, so a
  // journal written in any other title format slipped through and became a page with
  // `journal_day = NULL` — named like a journal, looking like one, and invisible to the journal
  // stream forever.
  it.each([["2026-09-08"], ["Tue, 08.09.2026"], ["Sep 8th, 2026"], ["today"]])(
    "refuses %s and names the ISO date to use instead",
    async (name) => {
      const s2 = makeTestServer();
      const { status, json } = await post(s2.app, "/api/v1/page.create", s2.writeToken, { name });
      expect(status).toBe(400);
      expect(json.error.code).toBe("invalid");
      expect(json.error.hint).toMatch(/page_append/);
      expect(json.error.hint).toMatch(/\d{4}-\d{2}-\d{2}/);
    },
  );

  it("still accepts an ordinary page whose name merely contains digits", async () => {
    const s2 = makeTestServer();
    const { status } = await post(s2.app, "/api/v1/page.create", s2.writeToken, {
      name: "97 poets of Revachol",
    });
    expect(status).toBe(200);
  });
});

describe("page.append page resolution", () => {
  it("creates an ordinary page when create_page is on", async () => {
    // `create_page` defaults to true and is documented as doing this, but `resolvePageRef` only
    // ever honoured it for journal days — an agent appending to a page that did not exist yet got
    // "does not exist and create_page is false" while having passed exactly the opposite.
    const s2 = makeTestServer();
    const { status, json } = await post(s2.app, "/api/v1/page.append", s2.writeToken, {
      page: "Brand New Page",
      markdown: "- first thought",
    });
    expect(status).toBe(200);
    expect(json.created).toHaveLength(1);

    const read = await post(s2.app, "/api/v1/page.read", s2.writeToken, { page: "Brand New Page" });
    expect(read.json.text).toContain("first thought");
  });

  it("still refuses when create_page is explicitly off", async () => {
    const s2 = makeTestServer();
    const { status, json } = await post(s2.app, "/api/v1/page.append", s2.writeToken, {
      page: "Nope",
      markdown: "- x",
      create_page: false,
    });
    expect(status).toBe(400);
    expect(json.error.message).toMatch(/create_page is false/);
  });

  it("appends a human-written date to the journal day, not a shadow page", async () => {
    // The B-23 hole through page.append's door: without this, "Sep 8th, 2026" would have created
    // an ordinary page with journal_day NULL, invisible to the journal stream forever.
    const s2 = makeTestServer();
    await post(s2.app, "/api/v1/page.append", s2.writeToken, {
      page: "Sep 8th, 2026",
      markdown: "- written on a human-shaped date",
    });
    const { json } = await post(s2.app, "/api/v1/page.read", s2.writeToken, { page: "2026-09-08" });
    expect(json.page.kind).toBe("journal");
    expect(json.page.name).toBe("2026-09-08");
    expect(json.text).toContain("human-shaped date");
  });

  it("rejects a date-shaped ref that is not a real day instead of minting a page for it", async () => {
    // `2026-13-45` matched the wire-date regex, became journal day 20261345, and page.append
    // created a page under that name — a typo turned into a permanent shadow journal.
    const s2 = makeTestServer();
    for (const bad of ["2026-13-45", "2026-02-30"]) {
      const { status, json } = await post(s2.app, "/api/v1/page.append", s2.writeToken, {
        page: bad,
        markdown: "- x",
      });
      expect(status, bad).toBe(400);
      expect(json.error.code).toBe("invalid");
      expect(json.error.message).toMatch(/not a valid calendar day/);
    }
    const list = await post(s2.app, "/api/v1/page.list", s2.writeToken, { kind: "all" });
    expect(list.json.items).toHaveLength(0);
  });

  it("prefers an existing page over reading its name as a date", async () => {
    // A page named "11.12.2024" cannot be made through `page.create` (B-23 reads any parseable
    // date as a journal), but a graph imported from Logseq can contain one. When it does, the
    // name wins: that is a real page with real content, and the journal day is reachable by ISO.
    const s2 = makeTestServer();
    const id = newId();
    const hlc = s2.serverCtx.hlc.next();
    serverApplyOps(
      s2.serverCtx,
      [
        {
          id: hlc,
          hlc,
          device: "aaaaaaaa",
          entity: id,
          payload: { kind: "page.create", name: "11.12.2024", journalDay: null, createdAt: 1 },
        },
      ],
      { origin: "import", actor: "test" },
    );

    const { json } = await post(s2.app, "/api/v1/page.append", s2.writeToken, {
      page: "11.12.2024",
      markdown: "- belongs to the page, not the day",
    });
    expect(json.page).toBe("11.12.2024");
    const read = await post(s2.app, "/api/v1/page.read", s2.writeToken, { page: "11.12.2024" });
    expect(read.json.page.kind).toBe("page");
  });
});

describe("page.backlinks", () => {
  it("lists linked references to a page (success)", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Target" });
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Other",
      markdown: "- mentions [[Target]]",
    });
    const { status, json } = await post(s.app, "/api/v1/page.backlinks", s.writeToken, {
      target: "Target",
    });
    expect(status).toBe(200);
    expect(json.linked).toHaveLength(1);
    expect(json.linked[0].page).toBe("Other");
  });

  it("returns an empty result for a target nothing points at", async () => {
    // NOT a 404. A page that is referenced but not created yet is a normal, addressable thing in
    // a wiki — `[[Lisbon]]` makes that page meaningful the moment the link is written, and
    // opening it must show what points at it. Since any name can be a page key, the honest answer
    // for an unknown one is "nothing links here", which a caller can act on; 404 made every
    // not-yet-created page render as "Couldn't load references".
    const { status, json } = await post(s.app, "/api/v1/page.backlinks", s.writeToken, {
      target: "1k7f3q9xz2hav4",
    });
    expect(status).toBe(200);
    expect(json.linked).toHaveLength(0);
  });
});

describe("graph.links", () => {
  it("returns pages as nodes and references as weighted edges (success)", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Beta" });
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Alpha",
      markdown: "- see [[Beta]]\n- and [[Beta]] again\n- and a #Gamma tag",
    });
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Gamma" });

    const { status, json } = await post(s.app, "/api/v1/graph.links", s.writeToken, {});
    expect(status).toBe(200);
    expect(json.nodes.map((n: JsonAny) => n.name).sort()).toEqual(["Alpha", "Beta", "Gamma"]);

    const node = (name: string): JsonAny => json.nodes.find((n: JsonAny) => n.name === name);
    const alpha = node("Alpha");
    const beta = node("Beta");
    const gamma = node("Gamma");
    const edge = json.edges.find((e: JsonAny) => e.from === alpha.id && e.to === beta.id);
    // Two blocks link Beta, so the edge is weighted 2 rather than deduplicated to 1.
    expect(edge.count).toBe(2);
    // A #tag is a reference like any other, so it is an edge too.
    expect(json.edges.some((e: JsonAny) => e.from === alpha.id && e.to === gamma.id)).toBe(true);
    // ref_count is the degree (in + out): Alpha writes 3 refs, Beta receives 2.
    expect(alpha.ref_count).toBe(3);
    expect(beta.ref_count).toBe(2);
    expect(json.truncated).toBe(false);
  });

  it("resolves an edge to a page that was created after the link was written", async () => {
    // `ref.dst_page_id` is NULL until rule 18's refresh runs, which is exactly why the handler
    // joins on `page.key` instead. Linking a page that does not exist yet and creating it
    // afterwards is the normal wiki order of events, and the edge must appear.
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Early",
      markdown: "- points at [[Later]]",
    });
    const before = await post(s.app, "/api/v1/graph.links", s.writeToken, {});
    expect(before.json.edges).toHaveLength(0);

    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Later" });
    const after = await post(s.app, "/api/v1/graph.links", s.writeToken, {});
    expect(after.json.edges).toHaveLength(1);
  });

  it("drops an edge whose block was deleted", async () => {
    // Deletes are soft and `ref` is rebuilt from the still-present content of a deleted block, so
    // without a read-time filter the edge would outlive the bullet that created it.
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Kept" });
    const created = await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Deleter",
      markdown: "- links [[Kept]]",
    });
    expect((await post(s.app, "/api/v1/graph.links", s.writeToken, {})).json.edges).toHaveLength(1);

    await post(s.app, "/api/v1/block.delete", s.writeToken, { id: created.json.created[0] });
    const after = await post(s.app, "/api/v1/graph.links", s.writeToken, {});
    expect(after.json.edges).toHaveLength(0);
    // Both pages are still pages, just unconnected ones.
    expect(after.json.nodes).toHaveLength(2);
    expect(after.json.nodes.every((n: JsonAny) => n.ref_count === 0)).toBe(true);
  });

  it("excludes journals by default, along with the references written in them", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Person" });
    await post(s.app, "/api/v1/page.append", s.writeToken, {
      page: "2026-09-11",
      markdown: "- met [[Person]]",
    });

    const excluded = await post(s.app, "/api/v1/graph.links", s.writeToken, {});
    expect(excluded.json.nodes.map((n: JsonAny) => n.name)).toEqual(["Person"]);
    // The edge went with the journal it was written on — the note has to say so, or a sparse
    // graph looks like broken ref extraction.
    expect(excluded.json.edges).toHaveLength(0);
    expect(excluded.json.note).toContain("journal");

    const included = await post(s.app, "/api/v1/graph.links", s.writeToken, {
      include_journals: true,
    });
    expect(included.json.nodes.map((n: JsonAny) => n.name).sort()).toEqual([
      "2026-09-11",
      "Person",
    ]);
    expect(included.json.edges).toHaveLength(1);
  });

  it("caps at limit, keeps the most-connected pages, and says what it dropped", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Hub" });
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Spoke",
      markdown: "- [[Hub]]",
    });
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Orphan" });

    const { json } = await post(s.app, "/api/v1/graph.links", s.writeToken, { limit: 2 });
    expect(json.nodes).toHaveLength(2);
    expect(json.nodes.map((n: JsonAny) => n.name).sort()).toEqual(["Hub", "Spoke"]);
    expect(json.truncated).toBe(true);
    expect(json.total_nodes).toBe(3);
    expect(json.note).toContain("3 pages");
  });
});

describe("changes.since", () => {
  it("returns change events after a cursor (success)", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Changed" });
    const { status, json } = await post(s.app, "/api/v1/changes.since", s.writeToken, {
      cursor: "0",
    });
    expect(status).toBe(200);
    expect(json.items.length).toBeGreaterThan(0);
    expect(json.items[0].kind).toBe("page.created");
  });

  it("is invalid for a non-numeric cursor", async () => {
    const { status, json } = await post(s.app, "/api/v1/changes.since", s.writeToken, {
      cursor: "abc",
    });
    expect(status).toBe(400);
    expect(json.error.code).toBe("invalid");
  });
});

describe("page.delete", () => {
  it("soft-deletes a page and its blocks (success)", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Bye", markdown: "- x" });
    const { status, json } = await post(s.app, "/api/v1/page.delete", s.writeToken, {
      page: "Bye",
    });
    expect(status).toBe(200);
    expect(json.deleted_blocks).toBe(1);
    const after = await post(s.app, "/api/v1/page.read", s.writeToken, { page: "Bye" });
    expect(after.status).toBe(404);
  });

  it("is not_found for an unknown page", async () => {
    const { status, json } = await post(s.app, "/api/v1/page.delete", s.writeToken, {
      page: "Never Existed",
    });
    expect(status).toBe(404);
    expect(json.error.code).toBe("not_found");
  });
});

describe("batch", () => {
  it("chains $n placeholders across page.create -> page.append (success)", async () => {
    const { status, json } = await post(s.app, "/api/v1/batch", s.writeToken, {
      ops: [
        { op: "page.create", name: "Projects/Comet" },
        { op: "page.append", page: "$1", markdown: "- Kickoff\n  - TODO invite" },
      ],
    });
    expect(status).toBe(200);
    expect(json.applied).toBe(true);
    expect(json.results).toHaveLength(2);
    expect(json.results[1].result.page).toBe("Projects/Comet");
    const check = await post(s.app, "/api/v1/page.read", s.writeToken, { page: "Projects/Comet" });
    expect(check.json.text).toContain("Kickoff");
  });

  it("is atomic: a failing op rolls back everything already applied", async () => {
    const { status, json } = await post(s.app, "/api/v1/batch", s.writeToken, {
      ops: [
        { op: "page.create", name: "AtomicX" },
        { op: "page.append", page: "$5", markdown: "- hi" },
      ],
    });
    expect(status).toBe(400);
    expect(json.error.code).toBe("invalid");
    expect(json.error.details.index).toBe(1);
    const check = await post(s.app, "/api/v1/page.read", s.writeToken, { page: "AtomicX" });
    expect(check.status).toBe(404); // page.create from the failed batch did not survive
  });
});

// The `batch`/`dry_run` tests above (and the old clone-based implementation they were written
// against) only ever ran against an EMPTY block table -- easy to pass by accident even with a
// broken savepoint/transaction interaction, since there is nothing pre-existing to corrupt. These
// run every case against a graph that already has real pages/blocks in it, and check exact row
// counts and block content, not just HTTP status codes.
describe("batch/dry_run against a non-empty graph", () => {
  async function seed(): Promise<{ text: string }> {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Existing",
      markdown: "- alpha\n  - beta",
    });
    const read = await post(s.app, "/api/v1/page.read", s.writeToken, { page: "Existing" });
    return { text: read.json.text as string };
  }

  it("dry_run: true on batch mutates nothing -- same row counts and same pre-existing content", async () => {
    const seeded = await seed();
    const before = rowCounts(s);

    const { status, json } = await post(s.app, "/api/v1/batch", s.writeToken, {
      dry_run: true,
      ops: [
        { op: "page.create", name: "NeverCommitted" },
        { op: "page.append", page: "$1", markdown: "- gamma" },
      ],
    });
    expect(status).toBe(200);
    expect(json.applied).toBe(false);
    expect(json.dry_run).toBe(true);
    expect(json.results).toHaveLength(2); // the trial itself did run, and did report results

    expect(rowCounts(s)).toEqual(before);
    const existingAfter = await post(s.app, "/api/v1/page.read", s.writeToken, {
      page: "Existing",
    });
    expect(existingAfter.json.text).toBe(seeded.text);
    const neverCommitted = await post(s.app, "/api/v1/page.read", s.writeToken, {
      page: "NeverCommitted",
    });
    expect(neverCommitted.status).toBe(404);
  });

  it("a failing batch step leaves pre-existing pages/blocks completely untouched", async () => {
    const seeded = await seed();
    const before = rowCounts(s);

    const { status, json } = await post(s.app, "/api/v1/batch", s.writeToken, {
      ops: [
        { op: "page.append", page: "Existing", markdown: "- gamma" }, // would succeed alone
        { op: "page.append", page: "$9", markdown: "- boom" }, // bad placeholder -> fails
      ],
    });
    expect(status).toBe(400);
    expect(json.error.details.index).toBe(1);

    expect(rowCounts(s)).toEqual(before); // step 0's write did not survive step 1's failure
    const existingAfter = await post(s.app, "/api/v1/page.read", s.writeToken, {
      page: "Existing",
    });
    expect(existingAfter.json.text).toBe(seeded.text);
    expect(existingAfter.json.text).not.toContain("gamma");
  });

  it("a successful batch applies exactly once: no duplicated blocks, one changes/op row set", async () => {
    await seed();
    const before = rowCounts(s);

    const { status, json } = await post(s.app, "/api/v1/batch", s.writeToken, {
      ops: [
        { op: "page.create", name: "OnceOnly" },
        { op: "page.append", page: "$1", markdown: "- one\n- two" },
      ],
    });
    expect(status).toBe(200);
    expect(json.applied).toBe(true);

    const after = rowCounts(s);
    // Exactly one new page and two new blocks -- NOT double that, which is what a bug re-running
    // the trial's own steps for real (instead of committing the trial itself) would produce.
    expect(after.page - before.page).toBe(1);
    expect(after.block - before.block).toBe(2);

    const blockContents = s.serverCtx.driver
      .all<{ content: string }>(
        "SELECT content FROM block WHERE page_id = (SELECT id FROM page WHERE key = ?) ORDER BY content",
        ["onceonly"],
      )
      .map((r) => r.content);
    expect(blockContents).toEqual(["one", "two"]); // each exactly once, not duplicated

    // Exactly 3 new op rows (1 page.create + 2 block.create) and 3 new changes rows (one per
    // touched entity, sql-schema.md rule 21) -- not double, which is what re-running the trial's
    // own already-applied steps for real (instead of committing the trial itself) would produce.
    expect(after.op - before.op).toBe(3);
    expect(after.changes - before.changes).toBe(3);
  });
});

// ---------------------------------------------------------------------------------------------
// embeddings.* — the settings panel's way into M3/ADR 010 (`./embeddings.ts`).
// ---------------------------------------------------------------------------------------------

/**
 * A stand-in Ollama over a real socket.
 *
 * These ops exist to turn two network failures into sentences a person can act on ("nothing is
 * listening there", "that model was never pulled"), so the tests have to produce those failures
 * for real. A mocked `fetch` would assert on the shape of the mock, not on what the providers and
 * the probe actually do with an HTTP answer — and the probe's whole job is reading that answer.
 *
 * Deliberately NOT the machine's own Ollama: the dev box running these tests has one on
 * :11434, CI does not, and a suite whose result depends on that is worse than no suite.
 */
interface StubOllama {
  host: string;
  close: () => Promise<void>;
  embedCalls: number;
}

async function startStubOllama(opts: { models: string[]; dims: number }): Promise<StubOllama> {
  const stub: StubOllama = { host: "", embedCalls: 0, close: async () => {} };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString()) as JsonAny) : {};
      const json = (payload: unknown): void => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.url === "/api/tags") {
        json({ models: opts.models.map((name) => ({ name })) });
      } else if (req.url === "/api/show") {
        json({
          model_info: { "general.architecture": "bert", "bert.embedding_length": opts.dims },
        });
      } else if (req.url === "/api/embed") {
        stub.embedCalls++;
        const inputs: string[] = body.input ?? [];
        json({
          model: body.model,
          // Distinct-but-deterministic vectors: identical ones would make any later similarity
          // assertion meaningless, and these rows are real vec0 inserts.
          embeddings: inputs.map((text, i) =>
            Array.from({ length: opts.dims }, (_, d) => ((text.length + i + d) % 7) / 7),
          ),
        });
      } else {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stub.host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return stub;
}

/** Nothing listens here, and a refused connection comes back immediately. */
const DEAD_HOST = "http://127.0.0.1:1";

describe("embeddings.status", () => {
  it("reports the defaults, no active model, and sqlite-vec, without touching the network", async () => {
    const { status, json } = await post(s.app, "/api/v1/embeddings.status", s.readToken, {
      probe: false,
    });
    expect(status).toBe(200);
    // The state every install starts in, and the reason this whole feature was invisible.
    expect(json.active).toBeNull();
    expect(json.switching_to).toBeNull();
    expect(json.configured).toEqual({
      provider: "ollama",
      model: "bge-m3",
      host: "http://127.0.0.1:11434",
    });
    expect(json.sqlite_vec.loaded).toBe(true);
    expect(json.provider.reachable).toBeNull(); // not probed
  });

  it("says the provider is unreachable, with the reason", async () => {
    setEmbeddingSettings(s.serverCtx.driver, { host: DEAD_HOST });
    const { status, json } = await post(s.app, "/api/v1/embeddings.status", s.readToken, {});
    expect(status).toBe(200);
    expect(json.provider.reachable).toBe(false);
    expect(json.provider.error).toBeTruthy();
  });
});

describe("embeddings.configure", () => {
  let stub: StubOllama;

  beforeAll(async () => {
    stub = await startStubOllama({ models: ["stub-embed:latest", "other:latest"], dims: 8 });
  });
  afterAll(async () => {
    await stub.close();
  });

  it("refuses an unreachable host with a message that names it, and stores nothing", async () => {
    const { status, json } = await post(s.app, "/api/v1/embeddings.configure", s.writeToken, {
      provider: "ollama",
      host: DEAD_HOST,
      model: "bge-m3",
    });
    expect(status).toBe(400);
    expect(json.error.code).toBe("invalid");
    expect(json.error.message).toContain("Could not reach");
    expect(json.error.message).toContain(DEAD_HOST);
    expect(json.error.hint).toContain("ollama serve");
    // A configuration it has just proven does not work must not survive the call.
    expect(getEmbeddingSettings(s.serverCtx.driver).host).toBe("http://127.0.0.1:11434");
    expect(getActiveModel(s.serverCtx.driver)).toBeUndefined();
  });

  it("refuses a model the host does not have, and lists the ones it does", async () => {
    const { status, json } = await post(s.app, "/api/v1/embeddings.configure", s.writeToken, {
      provider: "ollama",
      host: stub.host,
      model: "not-pulled",
    });
    expect(status).toBe(400);
    expect(json.error.message).toContain('no model named "not-pulled"');
    expect(json.error.hint).toContain("ollama pull not-pulled");
    expect(json.error.hint).toContain("stub-embed:latest");
    expect(getEmbeddingSettings(s.serverCtx.driver).model).toBe("bge-m3");
  });

  it("accepts a bare model name for a tagged model, discovers dims, and activates on an empty graph", async () => {
    const { status, json } = await post(s.app, "/api/v1/embeddings.configure", s.writeToken, {
      provider: "ollama",
      host: stub.host,
      // Bare name for "stub-embed:latest" -- what people actually type.
      model: "stub-embed",
    });
    expect(status).toBe(200);
    expect(json.dimensions).toBe(8); // read from the provider, never from the caller
    expect(json.queued).toBe(0);
    expect(json.active).toBe(true); // nothing to backfill, so rule 19's flip happens at once

    const after = await post(s.app, "/api/v1/embeddings.status", s.writeToken, { probe: false });
    expect(after.json.active).toMatchObject({
      provider: "ollama",
      model: "stub-embed",
      dimensions: 8,
    });
    expect(after.json.switching_to).toBeNull();
  });

  it("backfills before activating on a graph with content, then activates itself when drained", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Projects/Nooklet",
      markdown: "- sync needs a reconnect backoff\n- oat milk, coffee, bread",
    });

    const { json } = await post(s.app, "/api/v1/embeddings.configure", s.writeToken, {
      provider: "ollama",
      host: stub.host,
      model: "stub-embed",
    });
    expect(json.queued).toBeGreaterThan(0);
    // Rule 19: a model with an outstanding backfill must NOT become the active one -- that is what
    // would swap a working index for an empty one mid-switch.
    expect(json.active).toBe(false);

    const mid = await post(s.app, "/api/v1/embeddings.status", s.writeToken, { probe: false });
    expect(mid.json.active).toBeNull();
    expect(mid.json.switching_to).toMatchObject({ model: "stub-embed" });
    expect(mid.json.queued).toBeGreaterThan(0);

    // What `nooklet serve`'s in-process indexer does on its 3s tick.
    const driver = s.serverCtx.driver;
    await new EmbeddingIndexer({
      driver,
      providerFor: (m) => buildProviderForModel(driver, m),
    }).drainUntilEmpty();
    expect(stub.embedCalls).toBeGreaterThan(0);

    const done = await post(s.app, "/api/v1/embeddings.status", s.writeToken, { probe: false });
    expect(done.json.active).toMatchObject({ model: "stub-embed" });
    expect(done.json.active.indexed).toBeGreaterThan(0);
    expect(done.json.active.pending).toBe(0);
    expect(done.json.switching_to).toBeNull();
  });

  it("requires a write scope (read tokens cannot reconfigure the server)", async () => {
    const { status } = await post(s.app, "/api/v1/embeddings.configure", s.readToken, {
      host: stub.host,
      model: "stub-embed",
    });
    expect(status).toBe(403);
  });
});

describe("embeddings.reindex", () => {
  it("refuses when no model is registered instead of silently queueing nothing", async () => {
    const { status, json } = await post(s.app, "/api/v1/embeddings.reindex", s.writeToken, {});
    expect(status).toBe(400);
    expect(json.error.message).toContain("No embedding model is registered");
  });

  it("queues every page and block once a model exists", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Reindexable",
      markdown: "- one\n- two",
    });
    const driver = s.serverCtx.driver;
    const model = registerModel(driver, { provider: "fake", model: "test-model", dims: 8 });
    activateModel(driver, model.id);

    const { status, json } = await post(s.app, "/api/v1/embeddings.reindex", s.writeToken, {});
    expect(status).toBe(200);
    expect(json.model).toBe("fake:test-model");
    expect(json.queued).toBe(3); // 1 page + 2 blocks
  });
});
