import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { registerWindow, resolvePending, unregisterWindow } from "./registry.js";
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

    const resolved = resolvePending(c, conn.ws, requestId, { state: { window_id: "win-1" } });
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
    expect(resolvePending(c, conn.ws, requestId, { state: {} })).toBe(false);
  });

  it("two concurrent requests to the same window resolve independently by request_id", async () => {
    const c = ctx();
    const conn = fakeWindowConnection();
    const p1 = sendRequest(c, conn.ws, { type: "state.get" });
    const p2 = sendRequest(c, conn.ws, { type: "state.get" });
    expect(conn.sent).toHaveLength(2);
    const [id1, id2] = conn.sent.map((f) => f.request_id as string);
    // Resolve out of order to prove they are not matched positionally.
    resolvePending(c, conn.ws, id2 as string, { tag: "second" });
    resolvePending(c, conn.ws, id1 as string, { tag: "first" });
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

  it("only the socket a request was sent to can answer it (B-60)", async () => {
    const c = ctx();
    const asked = fakeWindowConnection();
    const other = fakeWindowConnection(); // e.g. a connection that never completed `hello`
    const pending = sendRequest(c, asked.ws, { type: "state.get" }, { timeoutMs: 30 });
    const requestId = lastRequestId(asked);
    expect(resolvePending(c, other.ws, requestId, { state: { forged: true } })).toBe(false);
    expect(resolvePending(c, asked.ws, requestId, { state: { ok: true } })).toBe(true);
    expect(await pending).toEqual({ timedOut: false, data: { state: { ok: true } } });
  });

  it("closing the window fails its in-flight requests at once instead of after the timeout (B-60)", async () => {
    const c = ctx();
    const conn = fakeWindowConnection();
    registerWindow(c, conn.ws, { deviceId: "d1", windowId: "w1", controlEnabled: true });
    const started = Date.now();
    const pending = sendRequest(c, conn.ws, { type: "command.run" }, { timeoutMs: 2000 });
    unregisterWindow(c, conn.ws);
    expect(await pending).toEqual({ timedOut: true });
    expect(Date.now() - started).toBeLessThan(500);
  });
});
