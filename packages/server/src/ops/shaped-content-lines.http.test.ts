/**
 * B-342 / OUT-23a through the real HTTP routes: a block whose TEXT has a line shaped like a
 * property or an org timestamp. The editor keeps a typed `scheduled:: 2026-09-20` line as text
 * (OUT-22a); `page_read` and `block_update`'s `before` used to render it verbatim, so an agent saw a
 * real date, and ANY `old_str` edit of that block — even of another word — parsed the line back as
 * a property and silently gave the task a scheduled date. The text now goes out escaped
 * (`scheduled\:: 2026-09-20`), and the escaped spelling is what an agent copies and edits.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { serverApplyOps } from "../apply-ops.js";
import { type JsonAny, makeTestServer, post, type TestServer } from "../test-helpers.js";
import { verifyRebuildParity } from "../verify.js";

let s: TestServer;
beforeEach(() => {
  s = makeTestServer();
});

async function seed(name: string, markdown: string): Promise<string> {
  const created = await post(s.app, "/api/v1/page.create", s.writeToken, { name, markdown });
  expect(created.status, JSON.stringify(created.json)).toBe(200);
  return created.json.created[0] as string;
}

/** The block's text as the editor writes it: one `block.text` op, no parsing. */
function typeText(id: string, content: string): void {
  const hlc = s.serverCtx.hlc.next();
  serverApplyOps(
    s.serverCtx,
    [{ id: hlc, hlc, device: "aaaaaaaa", entity: id, payload: { kind: "block.text", content } }],
    { origin: "user", actor: "test" },
  );
}

async function readBlock(id: string): Promise<JsonAny> {
  const r = await post(s.app, "/api/v1/block.read", s.writeToken, { id, format: "json" });
  expect(r.status).toBe(200);
  return r.json.block;
}

async function update(body: Record<string, unknown>) {
  return post(s.app, "/api/v1/block.update", s.writeToken, body);
}

describe("text lines shaped like a property or a timestamp (B-342, OUT-23a)", () => {
  it("page_read shows them escaped, and an unrelated old_str edit keeps them text", async () => {
    const id = await seed("B342 Read", "- TODO call mom");
    typeText(id, "call mom\nscheduled:: 2026-09-20\nSCHEDULED: <2026-09-20 Sun>");

    const read = await post(s.app, "/api/v1/page.read", s.writeToken, { page: "B342 Read" });
    expect(read.status).toBe(200);
    expect(read.json.text).toBe(
      `- TODO call mom ^${id}\n  scheduled\\:: 2026-09-20\n  SCHEDULED\\: <2026-09-20 Sun>\n`,
    );

    const { status, json } = await update({ id, old_str: "call mom", new_str: "call dad" });
    expect(status, JSON.stringify(json)).toBe(200);
    expect(json.before).toBe(
      "TODO call mom\nscheduled\\:: 2026-09-20\nSCHEDULED\\: <2026-09-20 Sun>",
    );
    const b = await readBlock(id);
    expect(b.content).toBe("call dad\nscheduled:: 2026-09-20\nSCHEDULED: <2026-09-20 Sun>");
    expect(b.properties?.scheduled).toBeUndefined();
    expect(verifyRebuildParity(s.serverCtx.driver).divergences).toEqual([]);
  });

  it("edits such a line by old_str copied from page_read, and makes it real by dropping the backslash", async () => {
    const id = await seed("B342 Edit", "- TODO call mom");
    typeText(id, "call mom\nscheduled:: 2026-09-20");

    const edit = await update({
      id,
      old_str: "scheduled\\:: 2026-09-20",
      new_str: "scheduled\\:: 2026-09-21",
    });
    expect(edit.status, JSON.stringify(edit.json)).toBe(200);
    expect(edit.json.outline).toBe(`- TODO call mom ^${id}\n  scheduled\\:: 2026-09-21\n`);
    let b = await readBlock(id);
    expect(b.content).toBe("call mom\nscheduled:: 2026-09-21");
    expect(b.properties?.scheduled).toBeUndefined();

    const real = await update({
      id,
      old_str: "scheduled\\:: 2026-09-21",
      new_str: "scheduled:: 2026-09-21",
    });
    expect(real.status, JSON.stringify(real.json)).toBe(200);
    b = await readBlock(id);
    expect(b.content).toBe("call mom");
    expect(b.properties?.scheduled).toBe("2026-09-21");
    expect(verifyRebuildParity(s.serverCtx.driver).divergences).toEqual([]);
  });

  it("writes an escaped line in markdown as text, next to a real property line", async () => {
    const created = await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "B342 Write",
      markdown: "- note\n  real:: yes\n  foo\\:: bar\n  \\:LOGBOOK:\n  kept\n- TODO x\\:: y",
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const [noteId, taskId] = created.json.created as string[];
    const note = await readBlock(noteId as string);
    expect(note.content).toBe("note\nfoo:: bar\n:LOGBOOK:\nkept");
    expect(note.properties).toEqual({ real: "yes" });
    const task = await readBlock(taskId as string);
    expect(task.marker).toBe("TODO");
    expect(task.content).toBe("x:: y");
    expect(created.json.outline).toBe(
      `- note ^${noteId}\n  real:: yes\n  foo\\:: bar\n  \\:LOGBOOK:\n  kept\n- TODO x\\:: y ^${taskId}\n`,
    );
  });

  it("round-trips a block with such text through block_update content copied from page_read", async () => {
    const id = await seed("B342 Content", "- plain");
    typeText(id, "plain\nfoo:: bar\ndeadline:: 2026-10-01");
    const read = await post(s.app, "/api/v1/page.read", s.writeToken, { page: "B342 Content" });
    const text = (read.json.text as string).replace(/^- /, "").replace(` ^${id}`, "");
    const { status, json } = await update({ id, content: text });
    expect(status, JSON.stringify(json)).toBe(200);
    const b = await readBlock(id);
    expect(b.content).toBe("plain\nfoo:: bar\ndeadline:: 2026-10-01");
    expect(b.properties ?? {}).toEqual({});
  });
});
