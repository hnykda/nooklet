/**
 * B-95: the mirror must follow commits while the server runs — not only when someone remembers
 * `nooklet export`.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type Op } from "@nooklet/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServerContext, type ServerContext, serverApplyOps } from "../apply-ops.js";
import { openDb } from "../db.js";
import { startLiveMirror } from "./live.js";

let ctx: ServerContext;
let dataDir: string;

beforeEach(() => {
  ctx = createServerContext(openDb({ path: ":memory:" }));
  dataDir = mkdtempSync(join(tmpdir(), "nooklet-live-mirror-"));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function op(entity: string, payload: Op["payload"]): Op {
  const hlc = ctx.hlc.next();
  return { id: hlc, hlc, device: "aaaaaaaa", entity, payload };
}

function write(ops: Op[]): void {
  serverApplyOps(ctx, ops, { origin: "user", actor: "test" });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("startLiveMirror", () => {
  it("writes a page's file shortly after it is created, and updates it after an edit", async () => {
    const mirror = startLiveMirror(ctx, dataDir, { debounceMs: 20, log: () => {} });
    try {
      const pageId = newId();
      const blockId = newId();
      write([
        op(pageId, { kind: "page.create", name: "Mirror Live", journalDay: null, createdAt: 1 }),
        op(blockId, {
          kind: "block.create",
          place: { pageId, parentId: null, order: "a0" },
          content: "first words",
          createdAt: 1,
        }),
      ]);
      const file = join(dataDir, "pages", "Mirror Live.md");
      await wait(80);
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, "utf8")).toContain("first words");

      write([op(blockId, { kind: "block.text", content: "second words" })]);
      await wait(80);
      expect(readFileSync(file, "utf8")).toContain("second words");
    } finally {
      mirror.stop();
    }
  });

  it("coalesces a burst of commits into one write, and removes the file of a deleted page", async () => {
    const mirror = startLiveMirror(ctx, dataDir, { debounceMs: 40, log: () => {} });
    try {
      const pageId = newId();
      const blockId = newId();
      write([
        op(pageId, { kind: "page.create", name: "Mirror Burst", journalDay: null, createdAt: 1 }),
        op(blockId, {
          kind: "block.create",
          place: { pageId, parentId: null, order: "a0" },
          content: "a",
          createdAt: 1,
        }),
      ]);
      for (const text of ["ab", "abc", "abcd"]) {
        write([op(blockId, { kind: "block.text", content: text })]);
        await wait(5);
      }
      const file = join(dataDir, "pages", "Mirror Burst.md");
      // Nothing yet: every commit pushed the quiet period out.
      expect(existsSync(file)).toBe(false);
      await wait(100);
      expect(readFileSync(file, "utf8")).toContain("abcd");

      write([op(pageId, { kind: "page.delete", deletedAt: 2 })]);
      await wait(100);
      expect(existsSync(file)).toBe(false);
    } finally {
      mirror.stop();
    }
  });

  it("stops listening once stopped", async () => {
    const mirror = startLiveMirror(ctx, dataDir, { debounceMs: 10, log: () => {} });
    mirror.stop();
    const pageId = newId();
    write([
      op(pageId, { kind: "page.create", name: "Mirror Stopped", journalDay: null, createdAt: 1 }),
    ]);
    await wait(50);
    expect(existsSync(join(dataDir, "pages", "Mirror Stopped.md"))).toBe(false);
  });
});
