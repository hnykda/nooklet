/**
 * B-585: `store.ts#applyOps` must hand a batch to the worker client in the same tick it is called.
 * `refactor-host.tsx#write()` does `flushTyping(); await forceSync()` — the flushed edit has to be
 * posted before the push, and with an `await` in front of the post (B-568's main-thread page
 * planning) the push overtook it: Turn into page made the page from the text minus the last
 * keystrokes (`e2e/tests/remote-rewrite.spec.ts` "Turn into page on the row being edited").
 */
import { makeOp, newId } from "@nooklet/core";
import { describe, expect, it, vi } from "vitest";

const posted: string[] = [];
vi.mock("../db/client.js", () => ({
  applyOps: vi.fn(async () => {
    posted.push("applyOps");
    return { applied: 0, skipped: 0 };
  }),
  forceSync: vi.fn(async () => {
    posted.push("forceSync");
  }),
  // What the old main-thread planning awaited; answered, so a regression fails on ORDER here.
  queryAs: vi.fn(async () => []),
  nextHlc: vi.fn(async () => "0000000000002-0000-dev"),
  getDeviceId: vi.fn(async () => "dev"),
  onChange: vi.fn(() => () => {}),
  onSyncStatus: vi.fn(() => () => {}),
}));

import { forceSync } from "../db/client.js";
import { applyOps } from "./store.js";

describe("store.applyOps (B-585)", () => {
  it("posts the batch before a forceSync called right after it, even when it names a new page", async () => {
    const op = makeOp("0000000000001-0000-dev", "dev", newId(), {
      kind: "block.text",
      content: "see [[A Page Nobody Has Made]] kickoff",
    });
    const write = applyOps([op]);
    const sync = forceSync();
    await Promise.all([write, sync]);
    expect(posted).toEqual(["applyOps", "forceSync"]);
  });
});
