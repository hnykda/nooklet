/**
 * Direct unit tests of `registerBeforeWrite`/`runBeforeWrite` (`./before-write.ts`) against a real
 * `serverApplyOps` call — no bundled plugin fixture needed, so these are fast and race-free (see
 * `host.test.ts`'s disposal test for `beforeWrite` exercised through a real activated plugin).
 */
import { makeOp, newId } from "@nooklet/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createServerContext, type ServerContext, serverApplyOps } from "../apply-ops.js";
import { openDb } from "../db.js";
import { registerBeforeWrite } from "./before-write.js";

let ctx: ServerContext;

beforeEach(() => {
  ctx = createServerContext(openDb({ path: ":memory:" }));
});

function pageCreateOp(name: string) {
  return makeOp(ctx.hlc.next(), "test-device", newId(), {
    kind: "page.create",
    name,
    journalDay: null,
    createdAt: Date.now(),
  });
}

describe("beforeWrite", () => {
  it("can transform the pending ops in place before they're applied", () => {
    registerBeforeWrite(ctx, (tx) => {
      for (const op of tx.ops) {
        if (op.payload.kind === "page.create") op.payload.name = `${op.payload.name} (transformed)`;
      }
    });
    const op = pageCreateOp("Original");
    serverApplyOps(ctx, [op], { origin: "user", actor: "test" });

    const row = ctx.driver.get<{ name: string }>("SELECT name FROM page WHERE id = ?", [op.entity]);
    expect(row?.name).toBe("Original (transformed)");
  });

  it("can veto a write by throwing — nothing lands", () => {
    registerBeforeWrite(ctx, () => {
      throw new Error("no pages allowed");
    });
    const op = pageCreateOp("Vetoed");
    expect(() => serverApplyOps(ctx, [op], { origin: "user", actor: "test" })).toThrow(
      "no pages allowed",
    );

    const row = ctx.driver.get<{ n: number }>("SELECT count(*) AS n FROM page WHERE id = ?", [
      op.entity,
    ]);
    expect(row?.n).toBe(0);
  });

  it("is skipped entirely for origin.kind === 'sync' (rule 13) — a throwing handler does not veto", () => {
    registerBeforeWrite(ctx, () => {
      throw new Error("should never run for sync");
    });
    const op = pageCreateOp("From another device");
    expect(() =>
      serverApplyOps(ctx, [op], { origin: "sync", actor: "device-x", deviceId: "device-x" }),
    ).not.toThrow();

    const row = ctx.driver.get<{ name: string }>("SELECT name FROM page WHERE id = ?", [op.entity]);
    expect(row?.name).toBe("From another device");
  });

  it("runs a local user write normally, but the same content via sync converges without the handler", () => {
    let calls = 0;
    registerBeforeWrite(ctx, () => {
      calls++;
    });
    serverApplyOps(ctx, [pageCreateOp("User write")], { origin: "user", actor: "test" });
    expect(calls).toBe(1);
    serverApplyOps(ctx, [pageCreateOp("Sync write")], { origin: "sync", actor: "device-x" });
    expect(calls).toBe(1); // unchanged: sync origin never invokes beforeWrite
  });

  it("disposing the registration stops future invocations", () => {
    let calls = 0;
    const dispose = registerBeforeWrite(ctx, () => {
      calls++;
    });
    serverApplyOps(ctx, [pageCreateOp("First")], { origin: "user", actor: "test" });
    expect(calls).toBe(1);
    dispose();
    serverApplyOps(ctx, [pageCreateOp("Second")], { origin: "user", actor: "test" });
    expect(calls).toBe(1);
  });

  it("runs handlers in priority order (higher first)", () => {
    const order: string[] = [];
    registerBeforeWrite(ctx, () => void order.push("low"), { priority: 0 });
    registerBeforeWrite(ctx, () => void order.push("high"), { priority: 10 });
    serverApplyOps(ctx, [pageCreateOp("X")], { origin: "user", actor: "test" });
    expect(order).toEqual(["high", "low"]);
  });
});
