/**
 * B-390, through the write path agents use: `page.read` renders an empty block as `- ^id`, and
 * before the fix the parser read that line back as the TEXT `^id` with no id — so markdown an
 * agent read and wrote back (mcp-tools.md rule 6: a `^id` names an existing block to upsert)
 * minted a new block reading `^1k7…` instead. The inbox entry said this was "by reading
 * `outline-bridge.ts`, not run"; this runs it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { type JsonAny, makeTestServer, post, type TestServer } from "../test-helpers.js";

let s: TestServer;

beforeEach(() => {
  s = makeTestServer();
});

async function ok(name: string, body: unknown): Promise<JsonAny> {
  const res = await post(s.app, `/api/v1/${name}`, s.writeToken, body);
  if (res.status !== 200) throw new Error(`${name} -> ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
}

describe("an empty block's `- ^id` line in write markdown names that block (B-390)", () => {
  it("page.append of markdown read from page.read moves the empty block, minting no `^id` text", async () => {
    await ok("page.create", { name: "Empty Ids Source", markdown: "- one\n-\n- TODO\n- three" });
    const read = await ok("page.read", { page: "Empty Ids Source" });
    const lines = (read.text as string).split("\n").filter((l) => l !== "");
    const empty = lines[1] as string;
    const emptyTask = lines[2] as string;
    expect(empty).toMatch(/^- \^[0-9a-z]{14}$/);
    expect(emptyTask).toMatch(/^- TODO \^[0-9a-z]{14}$/);
    const emptyId = empty.slice(3);
    const taskId = emptyTask.slice(8);

    const out = await ok("page.append", {
      page: "Empty Ids Target",
      markdown: `${empty}\n${emptyTask}`,
    });
    // (`page.append` reports `updated: []` even for an upsert; the rows below are the evidence.)
    expect(out.created).toEqual([]);

    const rows = s.serverCtx.driver.all<{ id: string; content: string; marker: string | null }>(
      `SELECT b.id AS id, b.content AS content, b.marker AS marker FROM block b
       JOIN page p ON p.id = b.page_id
       WHERE p.name = 'Empty Ids Target' AND b.deleted_at IS NULL ORDER BY b.order_key`,
    );
    expect(rows).toEqual([
      { id: emptyId, content: "", marker: null },
      { id: taskId, content: "", marker: "TODO" },
    ]);
    const caretText = s.serverCtx.driver.get<{ n: number }>(
      "SELECT count(*) AS n FROM block WHERE content LIKE '^%' AND deleted_at IS NULL",
    );
    expect(caretText?.n).toBe(0);
  });
});
