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

  // B-260: the sweep chose pages by `updated_at`, which only `block.text` moves. Everything below
  // reached the database and never the file.
  it("follows a rename: the new file appears and the old one goes", () => {
    const mirror = startLiveMirror(ctx, dataDir, { debounceMs: 10_000, log: () => {} });
    try {
      const pageId = newId();
      write([
        op(pageId, { kind: "page.create", name: "Mirror Old", journalDay: null, createdAt: 1 }),
        op(newId(), {
          kind: "block.create",
          place: { pageId, parentId: null, order: "a0" },
          content: "body",
          createdAt: 1,
        }),
      ]);
      mirror.flush();
      const oldFile = join(dataDir, "pages", "Mirror Old.md");
      expect(existsSync(oldFile)).toBe(true);

      write([op(pageId, { kind: "page.rename", name: "Mirror New" })]);
      mirror.flush();
      expect(existsSync(join(dataDir, "pages", "Mirror New.md"))).toBe(true);
      expect(existsSync(oldFile)).toBe(false);
    } finally {
      mirror.stop();
    }
  });

  it("follows page and block properties, markers and indentation", () => {
    const mirror = startLiveMirror(ctx, dataDir, { debounceMs: 10_000, log: () => {} });
    try {
      const pageId = newId();
      const one = newId();
      const two = newId();
      const three = newId();
      write([
        op(pageId, { kind: "page.create", name: "Mirror Fields", journalDay: null, createdAt: 1 }),
        op(one, {
          kind: "block.create",
          place: { pageId, parentId: null, order: "a0" },
          content: "one",
          createdAt: 1,
        }),
        op(two, {
          kind: "block.create",
          place: { pageId, parentId: null, order: "a1" },
          content: "two",
          createdAt: 1,
        }),
        op(three, {
          kind: "block.create",
          place: { pageId, parentId: null, order: "a2" },
          content: "three",
          createdAt: 1,
        }),
      ]);
      mirror.flush();
      const file = join(dataDir, "pages", "Mirror Fields.md");
      expect(readFileSync(file, "utf8")).toMatch(/^- two /m);

      write([op(pageId, { kind: "page.prop", key: "qaprop", value: "hello" })]);
      mirror.flush();
      expect(readFileSync(file, "utf8")).toContain("qaprop:: hello");

      write([op(one, { kind: "block.prop", key: "status", value: "x" })]);
      mirror.flush();
      expect(readFileSync(file, "utf8")).toContain("status:: x");

      write([op(three, { kind: "block.prop", key: "marker", value: "LATER" })]);
      mirror.flush();
      expect(readFileSync(file, "utf8")).toMatch(/^- LATER three /m);

      write([op(two, { kind: "block.place", place: { pageId, parentId: one, order: "a0" } })]);
      mirror.flush();
      expect(readFileSync(file, "utf8")).toMatch(/^ {2}- two /m);
    } finally {
      mirror.stop();
    }
  });

  it("follows a block moved to another page: gone from the first file, present in the second", () => {
    const mirror = startLiveMirror(ctx, dataDir, { debounceMs: 10_000, log: () => {} });
    try {
      const from = newId();
      const to = newId();
      const moving = newId();
      write([
        op(from, { kind: "page.create", name: "Mirror From", journalDay: null, createdAt: 1 }),
        op(to, { kind: "page.create", name: "Mirror To", journalDay: null, createdAt: 1 }),
        op(newId(), {
          kind: "block.create",
          place: { pageId: from, parentId: null, order: "a0" },
          content: "stays",
          createdAt: 1,
        }),
        op(moving, {
          kind: "block.create",
          place: { pageId: from, parentId: null, order: "a1" },
          content: "travels",
          createdAt: 1,
        }),
        op(newId(), {
          kind: "block.create",
          place: { pageId: to, parentId: null, order: "a0" },
          content: "already here",
          createdAt: 1,
        }),
      ]);
      mirror.flush();
      const fromFile = join(dataDir, "pages", "Mirror From.md");
      const toFile = join(dataDir, "pages", "Mirror To.md");
      expect(readFileSync(fromFile, "utf8")).toContain("travels");

      write([
        op(moving, { kind: "block.place", place: { pageId: to, parentId: null, order: "a1" } }),
      ]);
      mirror.flush();
      expect(readFileSync(fromFile, "utf8")).not.toContain("travels");
      expect(readFileSync(toFile, "utf8")).toContain("travels");
    } finally {
      mirror.stop();
    }
  });

  it("recreates, on start, a file deleted while the server was down (B-262)", () => {
    const first = startLiveMirror(ctx, dataDir, { debounceMs: 10_000, log: () => {} });
    const pageId = newId();
    write([
      op(pageId, { kind: "page.create", name: "Mirror Deleted", journalDay: null, createdAt: 1 }),
      op(newId(), {
        kind: "block.create",
        place: { pageId, parentId: null, order: "a0" },
        content: "keep me",
        createdAt: 1,
      }),
    ]);
    first.flush();
    first.stop();
    const file = join(dataDir, "pages", "Mirror Deleted.md");
    rmSync(file);

    const second = startLiveMirror(ctx, dataDir, { debounceMs: 10_000, log: () => {} });
    try {
      second.flush();
      expect(readFileSync(file, "utf8")).toContain("keep me");
    } finally {
      second.stop();
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
