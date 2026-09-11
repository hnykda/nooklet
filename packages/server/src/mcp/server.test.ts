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
].sort();

const UI_TOOL_NAMES = ["ui_windows", "ui_state", "ui_run", "ui_navigate", "ui_highlight"].sort();

describe("MCP tools/list", () => {
  it("lists every core op as a tool, with correct annotations, for a write-scoped token", async () => {
    const { status, body } = await rpc(s.app, s.writeToken, "tools/list", {});
    expect(status).toBe(200);
    const tools = body.result.tools as Array<{
      name: string;
      annotations: Record<string, unknown>;
    }>;
    // A plain write-scoped token has no ui:control (ADR 015 §7), so it must not see the 5 ui_*
    // tools at all (rule 10: "not even listed for this token") — CORE_OPS.length (24) minus those
    // i.e. every core op except the UI-control ones.
    expect(tools).toHaveLength(CORE_OPS.length - UI_TOOL_NAMES.length);
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

  it("returns isError for a not_found case", async () => {
    const { body } = await rpc(s.app, s.writeToken, "tools/call", {
      name: "page_read",
      arguments: { page: "Never Existed Ever" },
    });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("not_found");
  });
});
