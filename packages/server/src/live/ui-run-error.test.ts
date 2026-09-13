/**
 * B-148: a command that throws in the window (most often one refusing its args — `ui_run
 * {command_id: "task.setScheduled", args: "banana"}`) answers `command.result` with `error`
 * (`apps/web/src/live/message-handler.ts`), and `ui_run` must hand that reason to the agent as
 * `invalid`. Before, the window sent nothing, the op waited out the RPC timeout, and the agent got
 * 500 "did not respond in time" with a hint to try again — the same input that fails again.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createToken } from "../auth/tokens.js";
import { makeTestServer, post, type TestServer } from "../test-helpers.js";
import { registerWindow } from "./registry.js";
import { autoRespondingWindow } from "./test-helpers.js";

let s: TestServer;

beforeEach(() => {
  s = makeTestServer();
});

function uiControlToken(): string {
  return createToken(s.serverCtx.driver, { label: "agent", scope: "write", uiControl: true }).token;
}

function windowAnswering(reply: Record<string, unknown>): void {
  const conn = autoRespondingWindow(s.serverCtx.driver, () => reply);
  registerWindow(s.serverCtx.driver, conn.ws, {
    deviceId: "dev-a",
    windowId: "win-1",
    controlEnabled: true,
  });
}

const REASON = '"banana" is not a date (try "tomorrow" or "2026-09-14")';

describe("ui_run relays a command's own error (B-148)", () => {
  it("answers invalid with the window's reason, at once, instead of a timeout", async () => {
    windowAnswering({ error: REASON });
    const started = Date.now();
    const { status, json } = await post(s.app, "/api/v1/ui.run", uiControlToken(), {
      command_id: "task.setScheduled",
      args: "banana",
      window_id: "win-1",
    });
    expect(status, JSON.stringify(json)).toBe(400);
    expect(json.error.code).toBe("invalid");
    expect(json.error.message).toBe(`task.setScheduled failed in window "win-1": ${REASON}`);
    expect(json.error.hint).not.toMatch(/try again/);
    expect(json.error.details).toMatchObject({ reason: "command_failed", window_id: "win-1" });
    // The RPC timeout is 2 s; an answer that took that long was the old bug.
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("is the same for the ui_navigate wrapper", async () => {
    windowAnswering({ error: 'no page named "Nowhere"' });
    const { status, json } = await post(s.app, "/api/v1/ui.navigate", uiControlToken(), {
      page: "Nowhere",
      window_id: "win-1",
    });
    expect(status, JSON.stringify(json)).toBe(400);
    expect(json.error.message).toMatch(/nav\.openPage failed .*no page named "Nowhere"/);
  });

  it("still relays an ordinary result when there is no error", async () => {
    windowAnswering({ when_result: "ran" });
    const { status, json } = await post(s.app, "/api/v1/ui.run", uiControlToken(), {
      command_id: "task.setScheduled",
      args: "tomorrow",
      window_id: "win-1",
    });
    expect(status).toBe(200);
    expect(json).toEqual({ window_id: "win-1", when_result: "ran" });
  });
});
