/** Shared test scaffolding for `./*.test.ts` (not itself a `*.test.ts` file, so vitest ignores
 * it): a fake `/ui/live` window connection that records every frame the server sends it, so tests
 * can act as "the window" and reply without a real WebSocket/browser (task requirement: "test the
 * tools end-to-end against a fake window connection"). */

import type { SqlDriver } from "@nooklet/core";
import { WSContext } from "hono/ws";
import { resolvePending } from "./registry.js";

export interface FakeWindowConnection {
  ws: WSContext;
  /** Every frame the server sent this window, in order, already `JSON.parse`d. */
  sent: Array<Record<string, unknown>>;
  closed: { code?: number; reason?: string } | undefined;
}

export function fakeWindowConnection(): FakeWindowConnection {
  const conn: FakeWindowConnection = {
    sent: [],
    closed: undefined,
  } as unknown as FakeWindowConnection;
  conn.ws = new WSContext({
    send: (data) => {
      conn.sent.push(JSON.parse(String(data)));
    },
    close: (code, reason) => {
      conn.closed = { code, reason };
    },
    readyState: 1,
  });
  return conn;
}

/** The `request_id` the server minted for the most recent frame sent to `conn`. */
export function lastRequestId(conn: FakeWindowConnection): string {
  const last = conn.sent.at(-1);
  const id = last?.request_id;
  if (typeof id !== "string") throw new Error("no request_id on the most recent frame sent");
  return id;
}

/**
 * A fake window that immediately "answers" every `state.get`/`command.run` frame the server sends
 * it, computed by `respond`, so an op end-to-end test can `await` the op's HTTP call directly
 * rather than manually driving `resolvePending` — this is the "fake window connection" the tools'
 * end-to-end tests run against (no real WebSocket/browser).
 */
export function autoRespondingWindow(
  driver: SqlDriver,
  respond: (frame: Record<string, unknown>) => unknown,
): FakeWindowConnection {
  const conn = fakeWindowConnection();
  const originalSend = conn.ws.send.bind(conn.ws);
  conn.ws.send = ((data: Parameters<typeof conn.ws.send>[0]) => {
    originalSend(data);
    const frame = conn.sent.at(-1) as Record<string, unknown>;
    const requestId = frame.request_id as string;
    resolvePending(driver, conn.ws, requestId, respond(frame));
  }) as typeof conn.ws.send;
  return conn;
}
