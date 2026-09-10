import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { resolvePending } from "./registry.js";
import { sendRequest } from "./rpc.js";
import { fakeWindowConnection, lastRequestId } from "./test-helpers.js";

function ctx() {
  return openDb({ path: ":memory:" });
}

describe("/ui/live request/response correlation (ADR 015 §2)", () => {
  it("resolves once the window answers with the matching request_id", async () => {
    const c = ctx();
    const conn = fakeWindowConnection();

    const pending = sendRequest(c, conn.ws, { type: "state.get" });
    // The server should have sent exactly one frame, carrying a fresh request_id.
    expect(conn.sent).toHaveLength(1);
    expect(conn.sent[0]?.type).toBe("state.get");
    const requestId = lastRequestId(conn);

    const resolved = resolvePending(c, requestId, { state: { window_id: "win-1" } });
    expect(resolved).toBe(true);

    const result = await pending;
    expect(result).toEqual({ timedOut: false, data: { state: { window_id: "win-1" } } });
  });

  it("degrades gracefully — never throws — when the window does not answer in time", async () => {
    const c = ctx();
    const conn = fakeWindowConnection();
    const result = await sendRequest(c, conn.ws, { type: "state.get" }, { timeoutMs: 15 });
    expect(result).toEqual({ timedOut: true });
  });

  it("an answer that arrives after its own timeout is a harmless no-op, not a crash", async () => {
    const c = ctx();
    const conn = fakeWindowConnection();
    const result = await sendRequest(c, conn.ws, { type: "state.get" }, { timeoutMs: 10 });
    expect(result).toEqual({ timedOut: true });
    const requestId = lastRequestId(conn);
    // The late reply finds nothing pending (already cleared by the timeout) — resolvePending
    // reports that honestly rather than throwing.
    expect(resolvePending(c, requestId, { state: {} })).toBe(false);
  });

  it("two concurrent requests to the same window resolve independently by request_id", async () => {
    const c = ctx();
    const conn = fakeWindowConnection();
    const p1 = sendRequest(c, conn.ws, { type: "state.get" });
    const p2 = sendRequest(c, conn.ws, { type: "state.get" });
    expect(conn.sent).toHaveLength(2);
    const [id1, id2] = conn.sent.map((f) => f.request_id as string);
    // Resolve out of order to prove they are not matched positionally.
    resolvePending(c, id2 as string, { tag: "second" });
    resolvePending(c, id1 as string, { tag: "first" });
    expect(await p1).toEqual({ timedOut: false, data: { tag: "first" } });
    expect(await p2).toEqual({ timedOut: false, data: { tag: "second" } });
  });

  it("a send() that throws (dead socket) still resolves via the timeout, never rejects", async () => {
    const c = ctx();
    const conn = fakeWindowConnection();
    conn.ws.send = () => {
      throw new Error("socket is closed");
    };
    await expect(
      sendRequest(c, conn.ws, { type: "state.get" }, { timeoutMs: 10 }),
    ).resolves.toEqual({
      timedOut: true,
    });
  });
});
