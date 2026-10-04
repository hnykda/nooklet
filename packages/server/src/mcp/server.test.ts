import { beforeEach, describe, expect, it } from "vitest";
import { createToken } from "../auth/tokens.js";
import { CORE_OPS } from "../ops/index.js";
import { type JsonAny, makeTestServer, type TestServer } from "../test-helpers.js";

let s: TestServer;

beforeEach(() => {
  s = makeTestServer();
});

async function rpc(
  app: TestServer["app"],
  token: string,
  method: string,
  params: unknown,
  id = 1,
): Promise<{ status: number; body: JsonAny }> {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      host: "localhost",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
    return {
      status: res.status,
      body: dataLine ? JSON.parse(dataLine.slice("data:".length).trim()) : undefined,
    };
  }
  const body = await res.json().catch(() => undefined);
  return { status: res.status, body };
}

const CORE_TOOL_NAMES = [
  // The original 16 (docs/spec/mcp-tools.md).
  "batch",
  "block_delete",
  "block_insert",
  "block_move",
  "block_read",
  "block_update",
  "changes_since",
  "graph_overview",
  "page_append",
  "page_backlinks",
  "page_create",
  "page_delete",
  "page_list",
  "page_read",
  "page_update",
  "search",
  // ADR 013 (M1.5).
  "batch_undo",
  "asset_upload",
  // M3/ADR 010 embeddings.
  "related_find",
  // Backend health, so a client (or an agent deciding whether semantic search is worth trying)
  // can tell a broken backend from a slow one.
  "system_diagnostics",
  // The page-to-page link graph, behind the graph view. Server-side because `ref` is a
  // server-only derived table (sql-schema.md rule 1), so no client can compute an edge.
  "graph_links",
  // M7 (research/13 §4.2 item 10): "link all unlinked references", one undoable batch.
  "mentions_link",
  // M7 (research/13 §4.2 items 3-4): block/page refactors and graph-wide find & replace.
  "block_to_page",
  "block_move_to_page",
  "page_merge",
  "graph_replace",
  // M7 (research/13 §4.2 item 8, ADR 022): the trash and a page's history, over the audit log.
  "trash_list",
  "trash_restore",
  "page_history",
].sort();

const UI_TOOL_NAMES = ["ui_windows", "ui_state", "ui_run", "ui_navigate", "ui_highlight"].sort();

/** B-655: server administration, listed only for an `admin` token (rule 10 again). */
const ADMIN_TOOL_NAMES = ["pairing_create", "token_list", "token_revoke"].sort();

/**
 * Core ops that are deliberately NOT MCP tools (`expose: { mcp: false }`), so `CORE_OPS.length`
 * stops being the tool count.
 *
 * The three `embeddings.*` ops (settings panel: turn semantic search on, switch model, reindex)
 * are HTTP-only on purpose — see `../ops/embeddings.ts`'s header. Changing someone's embedding
 * provider or re-embedding their whole graph is a setup decision with a real cost, not something
 * an agent should do mid-answer; `system_diagnostics` already tells an agent whether semantic
 * search is worth attempting, which is the only part of this an agent needs.
 */
const HTTP_ONLY_OP_NAMES = [
  "embeddings.status",
  "embeddings.configure",
  "embeddings.reindex",
  // The one tokenless op: its caller is a device with no credential, never an MCP client.
  "pairing.redeem",
  // ADR 030: the in-app Logseq import. An agent has `nooklet import`; base64-ing a whole graph
  // through tool calls is not a path worth offering.
  "import.info",
  "import.begin",
  "import.chunk",
  "import.start",
  "import.status",
  "import.cancel",
];

describe("MCP tools/list", () => {
  it("lists every core op as a tool, with correct annotations, for a write-scoped token", async () => {
    const { status, body } = await rpc(s.app, s.writeToken, "tools/list", {});
    expect(status).toBe(200);
    const tools = body.result.tools as Array<{
      name: string;
      annotations: Record<string, unknown>;
    }>;
    // 30 core ops -> 22 tools here: minus the 5 ui_* ones (a plain write-scoped token has no
    // ui:control, ADR 015 §7 rule 10 — "not even listed for this token") and minus the 3
    // HTTP-only embeddings.* ones.
    expect(tools).toHaveLength(
      CORE_OPS.length - UI_TOOL_NAMES.length - HTTP_ONLY_OP_NAMES.length - ADMIN_TOOL_NAMES.length,
    );
    expect(tools).toHaveLength(CORE_TOOL_NAMES.length);
    expect(CORE_OPS.filter((op) => op.expose?.mcp === false).map((op) => op.name)).toEqual(
      HTTP_ONLY_OP_NAMES,
    );
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(CORE_TOOL_NAMES);
    const graphOverview = tools.find((t) => t.name === "graph_overview");
    expect(graphOverview?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    const pageDelete = tools.find((t) => t.name === "page_delete");
    expect(pageDelete?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
  });

  it("hides write tools from a read-scoped token (rule 10: never listed, not just denied)", async () => {
    const { body } = await rpc(s.app, s.readToken, "tools/list", {});
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).not.toContain("page_create");
    expect(names).not.toContain("block_delete");
    expect(names).toContain("graph_overview");
  });

  it("ADR 015: adds the 5 ui_* tools only for a token with the ui:control capability", async () => {
    const uiToken = createToken(s.serverCtx.driver, {
      label: "agent-ui",
      scope: "read",
      uiControl: true,
    }).token;
    const { body } = await rpc(s.app, uiToken, "tools/list", {});
    const names = body.result.tools.map((t: { name: string }) => t.name).sort();
    for (const uiName of UI_TOOL_NAMES) expect(names).toContain(uiName);
    // Read-only ops the plain "read" scope already grants stay visible too.
    expect(names).toContain("graph_overview");
    // Write ops still require "write", which this ui:control token was not given.
    expect(names).not.toContain("page_create");
  });

  it("B-655: lists the server-administration tools only for an admin token", async () => {
    const admin = await rpc(s.app, s.adminToken, "tools/list", {});
    const adminNames = admin.body.result.tools.map((t: { name: string }) => t.name);
    for (const n of ADMIN_TOOL_NAMES) expect(adminNames).toContain(n);
    expect(adminNames).not.toContain("pairing_redeem");
    const write = await rpc(s.app, s.writeToken, "tools/list", {});
    const writeNames = write.body.result.tools.map((t: { name: string }) => t.name);
    for (const n of ADMIN_TOOL_NAMES) expect(writeNames).not.toContain(n);
  });

  it("ADR 015: ui_run requires ui:control even for an admin (write+read) token", async () => {
    const { body } = await rpc(s.app, s.adminToken, "tools/list", {});
    const names = body.result.tools.map((t: { name: string }) => t.name);
    for (const uiName of UI_TOOL_NAMES) expect(names).not.toContain(uiName);
  });
});

describe("MCP tools/call", () => {
  it("calls page_create end-to-end and returns text + structuredContent", async () => {
    const initId = 1;
    void initId;
    const { status, body } = await rpc(s.app, s.writeToken, "tools/call", {
      name: "page_create",
      arguments: { name: "Via MCP" },
    });
    expect(status).toBe(200);
    expect(body.result.isError).toBeFalsy();
    expect(body.result.structuredContent.page).toBe("Via MCP");
    expect(body.result.content[0].text).toContain("created");
  });

  // B-267: the text is what an agent reads. `page_merge {dry_run: true}` answered "merged Alex into
  // @Alex: … 19 reference(s) rewritten" with only structuredContent.dry_run saying otherwise.
  it("says a dry run wrote nothing, for every write tool, in the text itself", async () => {
    for (const name of ["Merge Dry Source", "Merge Dry Target"]) {
      await rpc(s.app, s.writeToken, "tools/call", {
        name: "page_create",
        arguments: { name, markdown: "- body" },
      });
    }
    const merge = await rpc(s.app, s.writeToken, "tools/call", {
      name: "page_merge",
      arguments: { source: "Merge Dry Source", target: "Merge Dry Target", dry_run: true },
    });
    expect(merge.body.result.isError).toBeFalsy();
    expect(merge.body.result.structuredContent.dry_run).toBe(true);
    expect(merge.body.result.content[0].text).toMatch(/^dry run, nothing written: /);
    // And it really was not written.
    const read = await rpc(s.app, s.writeToken, "tools/call", {
      name: "page_read",
      arguments: { page: "Merge Dry Source" },
    });
    expect(read.body.result.isError).toBeFalsy();

    const create = await rpc(s.app, s.writeToken, "tools/call", {
      name: "page_create",
      arguments: { name: "Dry Created", dry_run: true },
    });
    expect(create.body.result.content[0].text).toMatch(/^dry run, nothing written: /);

    // A real write is not prefixed.
    const real = await rpc(s.app, s.writeToken, "tools/call", {
      name: "page_merge",
      arguments: { source: "Merge Dry Source", target: "Merge Dry Target" },
    });
    expect(real.body.result.content[0].text).toMatch(/^merged /);
  });

  // ADR 024: what an agent links, it can list and read, without creating it first.
  it("a page an agent's block_update links is in page_list and readable with page_read", async () => {
    const created = await rpc(s.app, s.writeToken, "tools/call", {
      name: "page_create",
      arguments: { name: "MCP Notes", markdown: "- a thought" },
    });
    const blockId = created.body.result.structuredContent.created[0] as string;
    const update = await rpc(s.app, s.writeToken, "tools/call", {
      name: "block_update",
      arguments: { id: blockId, content: "a thought about [[Agent Made Page]]" },
    });
    expect(update.body.result.isError).toBeFalsy();

    const list = await rpc(s.app, s.writeToken, "tools/call", {
      name: "page_list",
      arguments: {},
    });
    expect(list.body.result.isError).toBeFalsy();
    const names = (list.body.result.structuredContent.items as Array<{ name: string }>).map(
      (p) => p.name,
    );
    expect(names).toContain("Agent Made Page");
    const read = await rpc(s.app, s.writeToken, "tools/call", {
      name: "page_read",
      arguments: { page: "Agent Made Page" },
    });
    expect(read.body.result.isError).toBeFalsy();
  });

  it("returns isError for a not_found case", async () => {
    const { body } = await rpc(s.app, s.writeToken, "tools/call", {
      name: "page_read",
      arguments: { page: "Never Existed Ever" },
    });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("not_found");
  });
});
