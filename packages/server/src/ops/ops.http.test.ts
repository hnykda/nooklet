import { beforeEach, describe, expect, it } from "vitest";
import { makeTestServer, post, type TestServer } from "../test-helpers.js";

let s: TestServer;

beforeEach(() => {
  s = makeTestServer();
});

describe("graph.overview", () => {
  it("returns counts and a seq (success)", async () => {
    const { status, json } = await post(s.app, "/api/v1/graph.overview", s.writeToken, {});
    expect(status).toBe(200);
    expect(json.counts).toEqual({ pages: 0, journals: 0, blocks: 0 });
    expect(typeof json.seq).toBe("number");
  });

  it("rejects unknown fields (invalid)", async () => {
    const { status, json } = await post(s.app, "/api/v1/graph.overview", s.writeToken, { bogus: 1 });
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
    const { status, json } = await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Dup", if_exists: "error" });
    expect(status).toBe(409);
    expect(json.error.code).toBe("conflict");
    expect(json.error.details.page_id).toBeDefined();
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
    const read = await post(s.app, "/api/v1/page.read", s.writeToken, { page: "today", format: "json" });
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
    const { status, json } = await post(s.app, "/api/v1/page.read", s.writeToken, { page: "Nope Nope" });
    expect(status).toBe(404);
    expect(json.error.code).toBe("not_found");
  });
});

describe("block.read", () => {
  it("reads one block subtree with breadcrumb (success)", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Tree", markdown: "- top\n  - child" });
    const read = await post(s.app, "/api/v1/page.read", s.writeToken, { page: "Tree", format: "json" });
    const topId = read.json.tree[0].id;
    const childId = read.json.tree[0].children[0].id;
    const { status, json } = await post(s.app, "/api/v1/block.read", s.writeToken, { id: childId });
    expect(status).toBe(200);
    expect(json.breadcrumb).toEqual([{ id: topId, text: "top" }]);
    expect(json.block.content).toBe("child");
  });

  it("is not_found for an unknown block id", async () => {
    const { status, json } = await post(s.app, "/api/v1/block.read", s.writeToken, { id: "1k7f3q9xz2hav4" });
    expect(status).toBe(404);
    expect(json.error.code).toBe("not_found");
  });
});

describe("block.insert", () => {
  it("inserts markdown relative to a block (success)", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Ins", markdown: "- root" });
    const read = await post(s.app, "/api/v1/page.read", s.writeToken, { page: "Ins", format: "json" });
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
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Tasks", markdown: "- TODO buy milk" });
    const read = await post(s.app, "/api/v1/page.read", s.writeToken, { page: "Tasks", format: "json" });
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
    const read = await post(s.app, "/api/v1/page.read", s.writeToken, { page: "Bad", format: "json" });
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
    const read = await post(s.app, "/api/v1/page.read", s.writeToken, { page: "Mv", format: "json" });
    const [a, b] = read.json.tree;
    const { status, json } = await post(s.app, "/api/v1/block.move", s.writeToken, {
      id: b.id,
      ref: a.id,
      position: "child_first",
    });
    expect(status).toBe(200);
    const after = await post(s.app, "/api/v1/page.read", s.writeToken, { page: "Mv", format: "json" });
    expect(after.json.tree).toHaveLength(1);
    expect(after.json.tree[0].children[0].content).toBe("b");
  });

  it("rejects moving a block under its own descendant (invalid, cycle)", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Cyc", markdown: "- a\n  - b" });
    const read = await post(s.app, "/api/v1/page.read", s.writeToken, { page: "Cyc", format: "json" });
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
    const read = await post(s.app, "/api/v1/page.read", s.writeToken, { page: "Del", format: "json" });
    const a = read.json.tree[0];
    const { status, json } = await post(s.app, "/api/v1/block.delete", s.writeToken, { id: a.id });
    expect(status).toBe(200);
    expect(json.deleted_count).toBe(2);
    const after = await post(s.app, "/api/v1/page.read", s.writeToken, { page: "Del", format: "json" });
    expect(after.json.tree).toHaveLength(0);
  });

  it("is not_found for an unknown id", async () => {
    const { status, json } = await post(s.app, "/api/v1/block.delete", s.writeToken, { id: "1k7f3q9xz2hav4" });
    expect(status).toBe(404);
    expect(json.error.code).toBe("not_found");
  });
});

describe("page.update", () => {
  it("renames a page and rewrites [[links]] to it (success)", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Old Name" });
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Linker", markdown: "- see [[Old Name]]" });
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
    const { status, json } = await post(s.app, "/api/v1/page.list", s.writeToken, { namespace: "Projects" });
    expect(status).toBe(200);
    expect(json.items.map((p: { name: string }) => p.name).sort()).toEqual(["Projects/A", "Projects/B"]);
  });

  it("is invalid for a malformed cursor", async () => {
    const { status, json } = await post(s.app, "/api/v1/page.list", s.writeToken, { cursor: "not-base64-offset!" });
    expect(status).toBe(400);
    expect(json.error.code).toBe("invalid");
  });
});

describe("search", () => {
  it("finds a block by keyword (success)", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "SearchMe", markdown: "- vendor pricing detail" });
    const { status, json } = await post(s.app, "/api/v1/search", s.writeToken, { query: "pricing" });
    expect(status).toBe(200);
    expect(json.mode_used).toBe("keyword");
    expect(json.hits.some((h: { page: string }) => h.page === "SearchMe")).toBe(true);
  });

  it("is invalid with more than 20 pages", async () => {
    const pages = Array.from({ length: 21 }, (_, i) => `p${i}`);
    const { status, json } = await post(s.app, "/api/v1/search", s.writeToken, { query: "x", pages });
    expect(status).toBe(400);
    expect(json.error.code).toBe("invalid");
  });
});

describe("page.backlinks", () => {
  it("lists linked references to a page (success)", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Target" });
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Other", markdown: "- mentions [[Target]]" });
    const { status, json } = await post(s.app, "/api/v1/page.backlinks", s.writeToken, { target: "Target" });
    expect(status).toBe(200);
    expect(json.linked).toHaveLength(1);
    expect(json.linked[0].page).toBe("Other");
  });

  it("is not_found for an unresolvable target", async () => {
    const { status, json } = await post(s.app, "/api/v1/page.backlinks", s.writeToken, { target: "1k7f3q9xz2hav4" });
    expect(status).toBe(404);
    expect(json.error.code).toBe("not_found");
  });
});

describe("changes.since", () => {
  it("returns change events after a cursor (success)", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Changed" });
    const { status, json } = await post(s.app, "/api/v1/changes.since", s.writeToken, { cursor: "0" });
    expect(status).toBe(200);
    expect(json.items.length).toBeGreaterThan(0);
    expect(json.items[0].kind).toBe("page.created");
  });

  it("is invalid for a non-numeric cursor", async () => {
    const { status, json } = await post(s.app, "/api/v1/changes.since", s.writeToken, { cursor: "abc" });
    expect(status).toBe(400);
    expect(json.error.code).toBe("invalid");
  });
});

describe("page.delete", () => {
  it("soft-deletes a page and its blocks (success)", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Bye", markdown: "- x" });
    const { status, json } = await post(s.app, "/api/v1/page.delete", s.writeToken, { page: "Bye" });
    expect(status).toBe(200);
    expect(json.deleted_blocks).toBe(1);
    const after = await post(s.app, "/api/v1/page.read", s.writeToken, { page: "Bye" });
    expect(after.status).toBe(404);
  });

  it("is not_found for an unknown page", async () => {
    const { status, json } = await post(s.app, "/api/v1/page.delete", s.writeToken, { page: "Never Existed" });
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
