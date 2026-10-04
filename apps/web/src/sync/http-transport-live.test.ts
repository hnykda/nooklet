/**
 * B-676 H4: `connectLive`'s reconnect timing against a fake `WebSocket`, for each close code the
 * server can now send. The policy itself is `live-backoff.test.ts`; this checks the transport
 * actually follows it (before, `open` reset the delay to 1 s, so a server refusing every socket
 * for capacity got a reconnect a second).
 */

import { LIVE_CLOSE } from "@nooklet/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpTransport } from "./http-transport.js";

class FakeSocket extends EventTarget {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  constructor(readonly url: string) {
    super();
    FakeSocket.all.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
  /** The server accepts the TCP/WS handshake. */
  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  /** The server closes with `code`. */
  serverClose(code: number): void {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code }));
  }
}

describe("http-transport connectLive reconnects by close code (B-676 H4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5); // no jitter
    FakeSocket.all = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("self", { location: { href: "http://127.0.0.1:6525/" } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** Advance until a new socket is constructed; how long that took. */
  async function nextAttemptAfter(): Promise<number> {
    const before = FakeSocket.all.length;
    let waited = 0;
    while (FakeSocket.all.length === before && waited < 10 * 60_000) {
      await vi.advanceTimersByTimeAsync(100);
      waited += 100;
    }
    return waited;
  }

  function latest(): FakeSocket {
    const s = FakeSocket.all.at(-1);
    if (!s) throw new Error("no socket");
    return s;
  }

  it("a capacity refusal right after open waits 30 s, then 60 s — not 1 s", async () => {
    const closes: number[] = [];
    const stop = createHttpTransport({ getToken: () => "nk_x" }).connectLive("dev", {
      onPoke: () => {},
      onOpen: () => {},
      onClose: (c) => closes.push(c),
    });
    latest().open();
    expect(JSON.parse(latest().sent[0] as string)).toMatchObject({ type: "hello" });
    latest().serverClose(LIVE_CLOSE.overCapacity);
    expect(await nextAttemptAfter()).toBe(30_000);
    latest().open();
    latest().serverClose(LIVE_CLOSE.overCapacity);
    expect(await nextAttemptAfter()).toBe(60_000);
    expect(closes).toEqual([4429, 4429]);
    stop();
  });

  it("a token refusal stops; a network drop retries after 1 s", async () => {
    const t = createHttpTransport();
    const handlers = { onPoke: () => {}, onOpen: () => {} };
    const stop1 = t.connectLive("dev", handlers);
    latest().open();
    latest().serverClose(LIVE_CLOSE.forbidden);
    const count = FakeSocket.all.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(FakeSocket.all.length).toBe(count);
    stop1();

    const stop2 = t.connectLive("dev", handlers);
    latest().open();
    latest().serverClose(1006);
    expect(await nextAttemptAfter()).toBe(1000);
    stop2();
  });
});
