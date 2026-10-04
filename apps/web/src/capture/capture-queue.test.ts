/**
 * ADR 033's drain against an in-memory queue and a fake write: ordering, idempotence (a crash
 * between write and delete, a second drain racing the first), partial failure, malformed files.
 */
import { isId } from "@nooklet/core";
import { describe, expect, it } from "vitest";
import {
  type CaptureQueueDeps,
  captureBlockId,
  drainCaptureQueue,
  parseQueuedCapture,
} from "./capture-queue.js";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const U3 = "33333333-3333-4333-8333-333333333333";

interface Fake {
  deps: CaptureQueueDeps;
  files: Map<string, string>;
  blocks: Map<string, { text: string; at: number }>;
  writes: string[];
}

function fake(files: Record<string, unknown>, overrides: Partial<CaptureQueueDeps> = {}): Fake {
  const map = new Map(
    Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
  );
  const blocks = new Map<string, { text: string; at: number }>();
  const writes: string[] = [];
  const deps: CaptureQueueDeps = {
    list: async () => [...map.keys()],
    read: async (id) => {
      const v = map.get(id);
      if (v === undefined) throw new Error("gone");
      return v;
    },
    remove: async (id) => {
      map.delete(id);
    },
    blockExists: async (id) => blocks.has(id),
    write: async (text, { at, blockId }) => {
      // A slow write, so a second drain started meanwhile really overlaps the first.
      await new Promise((r) => setTimeout(r, 5));
      blocks.set(blockId, { text, at });
      writes.push(text);
      return { rejected: 0 };
    },
    ...overrides,
  };
  return { deps, files: map, blocks, writes };
}

describe("captureBlockId", () => {
  it("is a valid nooklet id, the same every time for the same capture", () => {
    const at = Date.parse("2026-10-04T08:15:30.123Z");
    const a = captureBlockId(U1, at);
    expect(isId(a)).toBe(true);
    expect(captureBlockId(U1, at)).toBe(a);
    expect(captureBlockId(U2, at)).not.toBe(a);
    expect(captureBlockId(U1, at + 1)).not.toBe(a);
  });
});

describe("parseQueuedCapture", () => {
  it("reads what the Swift writer writes", () => {
    expect(
      parseQueuedCapture(U1, '{"created_at":"2026-10-04T08:15:30.123Z","text":"hello"}'),
    ).toEqual({ id: U1, text: "hello", created_at: "2026-10-04T08:15:30.123Z" });
  });

  it("reads a file exactly as CaptureQueue.swift wrote it (tools/probes/phone-capture)", () => {
    // Verbatim from `capture-queue-probe.swift`'s "sample file" line, 2026-10-04.
    const fromSwift =
      '{"created_at":"2026-10-04T07:46:40.123Z","text":"Plánování zahradních úprav\\nřádek dva"}';
    expect(parseQueuedCapture("bbbbbbbb-1111-4111-8111-111111111111", fromSwift)).toEqual({
      id: "bbbbbbbb-1111-4111-8111-111111111111",
      text: "Plánování zahradních úprav\nřádek dva",
      created_at: "2026-10-04T07:46:40.123Z",
    });
  });

  it("rejects bad JSON, a missing or bad created_at, wrong field types and non-uuid names", () => {
    expect(parseQueuedCapture(U1, "{not json")).toBeUndefined();
    expect(parseQueuedCapture(U1, '{"text":"x"}')).toBeUndefined();
    expect(parseQueuedCapture(U1, '{"text":"x","created_at":"yesterday"}')).toBeUndefined();
    expect(
      parseQueuedCapture(U1, '{"text":5,"created_at":"2026-10-04T08:00:00Z"}'),
    ).toBeUndefined();
    expect(parseQueuedCapture(U1, "[]")).toBeUndefined();
    expect(parseQueuedCapture("../etc", '{"created_at":"2026-10-04T08:00:00Z"}')).toBeUndefined();
  });
});

describe("drainCaptureQueue", () => {
  it("writes captures oldest first, whatever order the folder lists them in, then deletes them", async () => {
    const f = fake({
      [U3]: { text: "third", created_at: "2026-10-04T10:00:00.000Z" },
      [U1]: { text: "first", created_at: "2026-10-04T08:00:00.000Z" },
      [U2]: { text: "second", created_at: "2026-10-04T09:00:00.000Z" },
    });
    const report = await drainCaptureQueue(f.deps);
    expect(f.writes).toEqual(["first", "second", "third"]);
    expect(report.written).toEqual([U1, U2, U3]);
    expect(f.files.size).toBe(0);
  });

  it("writes each with its own time and the deterministic block id", async () => {
    const created = "2026-10-03T22:30:00.000Z";
    const f = fake({ [U1]: { text: "late night", created_at: created } });
    await drainCaptureQueue(f.deps);
    const id = captureBlockId(U1, Date.parse(created));
    expect(f.blocks.get(id)).toEqual({ text: "late night", at: Date.parse(created) });
  });

  it("formats links the same way the capture screen does", async () => {
    const f = fake({
      [U1]: {
        url: "https://example.com/a",
        title: "An article",
        created_at: "2026-10-04T08:00:00Z",
      },
    });
    await drainCaptureQueue(f.deps);
    expect(f.writes).toEqual(["[An article](https://example.com/a)"]);
  });

  it("is idempotent: a capture whose block already landed is only deleted (crash before delete)", async () => {
    const created = "2026-10-04T08:00:00.000Z";
    const f = fake({ [U1]: { text: "once", created_at: created } });
    f.blocks.set(captureBlockId(U1, Date.parse(created)), { text: "once", at: 0 });
    const report = await drainCaptureQueue(f.deps);
    expect(f.writes).toEqual([]);
    expect(report.alreadyThere).toEqual([U1]);
    expect(f.files.size).toBe(0);
  });

  it("a capture whose delete failed is not written twice by the next drain", async () => {
    let failDelete = true;
    const f = fake(
      { [U1]: { text: "once", created_at: "2026-10-04T08:00:00Z" } },
      {
        remove: async (id) => {
          if (failDelete) throw new Error("disk full");
          f.files.delete(id);
        },
      },
    );
    const first = await drainCaptureQueue(f.deps);
    expect(first.failed).toEqual([U1]);
    expect(f.files.size).toBe(1);
    failDelete = false;
    const second = await drainCaptureQueue(f.deps);
    expect(second.alreadyThere).toEqual([U1]);
    expect(f.writes).toEqual(["once"]);
    expect(f.files.size).toBe(0);
  });

  it("two drains at once (launch and resume) write each capture exactly once", async () => {
    const f = fake({
      [U1]: { text: "a", created_at: "2026-10-04T08:00:00Z" },
      [U2]: { text: "b", created_at: "2026-10-04T08:00:01Z" },
    });
    const [r1, r2] = await Promise.all([drainCaptureQueue(f.deps), drainCaptureQueue(f.deps)]);
    expect(f.writes).toEqual(["a", "b"]);
    expect(r1.written).toEqual([U1, U2]);
    expect(r2.written).toEqual([]);
    expect(f.files.size).toBe(0);
  });

  it("a drain asked for mid-drain still picks up a file that arrived after the listing", async () => {
    const f = fake({ [U1]: { text: "a", created_at: "2026-10-04T08:00:00Z" } });
    const first = drainCaptureQueue(f.deps);
    f.files.set(U2, JSON.stringify({ text: "b", created_at: "2026-10-04T08:00:01Z" }));
    const second = drainCaptureQueue(f.deps);
    await Promise.all([first, second]);
    expect(f.writes).toEqual(["a", "b"]);
  });

  it("partial failure: a failed write stays queued, the ones after it still land", async () => {
    let calls = 0;
    const f = fake({
      [U1]: { text: "ok 1", created_at: "2026-10-04T08:00:00Z" },
      [U2]: { text: "boom", created_at: "2026-10-04T08:00:01Z" },
      [U3]: { text: "ok 2", created_at: "2026-10-04T08:00:02Z" },
    });
    const base = f.deps.write;
    f.deps.write = async (text, opts) => {
      calls++;
      if (text === "boom") throw new Error("worker gone");
      return base(text, opts);
    };
    const report = await drainCaptureQueue(f.deps);
    expect(calls).toBe(3);
    expect(f.writes).toEqual(["ok 1", "ok 2"]);
    expect(report.failed).toEqual([U2]);
    expect([...f.files.keys()]).toEqual([U2]);
  });

  it("a rejected write is not deleted", async () => {
    const f = fake(
      { [U1]: { text: "x", created_at: "2026-10-04T08:00:00Z" } },
      { write: async () => ({ rejected: 1 }) },
    );
    const report = await drainCaptureQueue(f.deps);
    expect(report.failed).toEqual([U1]);
    expect(f.files.size).toBe(1);
  });

  it("a malformed file is skipped and kept, and does not stop the rest", async () => {
    const f = fake({
      [U1]: "{half a fi",
      [U2]: { text: "fine", created_at: "2026-10-04T08:00:00Z" },
      "not-a-uuid": { text: "stray", created_at: "2026-10-04T08:00:00Z" },
    });
    const report = await drainCaptureQueue(f.deps);
    expect(f.writes).toEqual(["fine"]);
    expect(report.malformed.sort()).toEqual([U1, "not-a-uuid"].sort());
    expect([...f.files.keys()].sort()).toEqual([U1, "not-a-uuid"].sort());
  });

  it("a blank capture is removed without writing", async () => {
    const f = fake({ [U1]: { text: "   ", created_at: "2026-10-04T08:00:00Z" } });
    const report = await drainCaptureQueue(f.deps);
    expect(f.writes).toEqual([]);
    expect(report.empty).toEqual([U1]);
    expect(f.files.size).toBe(0);
  });

  it("a listing failure rejects, leaving every file for next time", async () => {
    const f = fake(
      { [U1]: { text: "x", created_at: "2026-10-04T08:00:00Z" } },
      {
        list: async () => {
          throw new Error("plugin missing");
        },
      },
    );
    await expect(drainCaptureQueue(f.deps)).rejects.toThrow("plugin missing");
    expect(f.files.size).toBe(1);
  });
});
