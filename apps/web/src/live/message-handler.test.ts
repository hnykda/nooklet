import { LIVE_MAX_PAYLOAD_BYTES } from "@nooklet/core";
import { describe, expect, it } from "vitest";
import { buildHello, handleIncomingFrame, type MessageHandlerDeps } from "./message-handler.js";
import type { UiWindowStateWire } from "./state-snapshot.js";

const STATE_STUB: UiWindowStateWire = {
  window_id: "w1",
  device_id: "d1",
  focused: true,
  page: null,
  zoom_root_block_id: null,
  focus: { mode: "none", block_id: null, selected_block_ids: [], cursor: null },
  viewport: { first_visible_block_id: null, last_visible_block_id: null, scroll_top: 0 },
  panels: { sidebar_open: true, active_view: "page", dialog_open: null },
  updated_at: "2026-09-11T00:00:00.000Z",
};

function deps(overrides: Partial<MessageHandlerDeps> = {}): MessageHandlerDeps {
  return {
    buildState: () => STATE_STUB,
    runCommand: async () => ({ when_result: "ran" }),
    ...overrides,
  };
}

describe("handleIncomingFrame", () => {
  it("answers state.get with state.result, echoing request_id and the fresh state", async () => {
    const reply = await handleIncomingFrame(
      JSON.stringify({ type: "state.get", request_id: "r1" }),
      deps(),
    );
    expect(JSON.parse(reply as string)).toEqual({
      type: "state.result",
      request_id: "r1",
      state: STATE_STUB,
    });
  });

  it("answers command.run with command.result, running the command and echoing request_id", async () => {
    let seen: { commandId: string; args: unknown } | undefined;
    const reply = await handleIncomingFrame(
      JSON.stringify({
        type: "command.run",
        request_id: "r2",
        command_id: "nav.openPage",
        args: { page: "X" },
      }),
      deps({
        runCommand: async (commandId, args) => {
          seen = { commandId, args };
          return { when_result: "ran", result: { ok: true } };
        },
      }),
    );
    expect(seen).toEqual({ commandId: "nav.openPage", args: { page: "X" } });
    expect(JSON.parse(reply as string)).toEqual({
      type: "command.result",
      request_id: "r2",
      when_result: "ran",
      result: { ok: true },
    });
  });

  // B-148: a command that rejected its args threw out of `runCommand`, no reply was sent, and the
  // agent got "window did not respond in time" — and was told to retry the same bad input.
  it("answers command.run with command.result carrying the error when the command throws", async () => {
    const reply = await handleIncomingFrame(
      JSON.stringify({
        type: "command.run",
        request_id: "r5",
        command_id: "task.setScheduled",
        args: "banana",
      }),
      deps({
        runCommand: async () => {
          throw new Error('"banana" is not a date (try "tomorrow" or "2026-09-14")');
        },
      }),
    );
    expect(JSON.parse(reply as string)).toEqual({
      type: "command.result",
      request_id: "r5",
      error: '"banana" is not a date (try "tomorrow" or "2026-09-14")',
    });
  });

  it("reports a non-Error throw, and cuts a huge message to a bounded length", async () => {
    const thrownString = await handleIncomingFrame(
      JSON.stringify({ type: "command.run", request_id: "r6", command_id: "x.y" }),
      deps({
        runCommand: () => Promise.reject("plain string"),
      }),
    );
    expect(JSON.parse(thrownString as string).error).toBe("plain string");

    const huge = await handleIncomingFrame(
      JSON.stringify({ type: "command.run", request_id: "r7", command_id: "x.y" }),
      deps({
        runCommand: async () => {
          throw new Error("x".repeat(10_000));
        },
      }),
    );
    expect(JSON.parse(huge as string).error.length).toBeLessThanOrEqual(1000);
  });

  it("returns null for an unrecognized type", async () => {
    const reply = await handleIncomingFrame(
      JSON.stringify({ type: "something.else", request_id: "r3" }),
      deps(),
    );
    expect(reply).toBeNull();
  });

  it("returns null for malformed JSON, without throwing", async () => {
    await expect(handleIncomingFrame("not json", deps())).resolves.toBeNull();
  });

  it("returns null when request_id is missing or not a string", async () => {
    expect(await handleIncomingFrame(JSON.stringify({ type: "state.get" }), deps())).toBeNull();
    expect(
      await handleIncomingFrame(JSON.stringify({ type: "state.get", request_id: 5 }), deps()),
    ).toBeNull();
  });

  it("treats a missing command_id as an empty string rather than throwing", async () => {
    let seenCommandId: string | undefined;
    await handleIncomingFrame(
      JSON.stringify({ type: "command.run", request_id: "r4" }),
      deps({
        runCommand: async (commandId) => {
          seenCommandId = commandId;
          return { when_result: "unknown_command" };
        },
      }),
    );
    expect(seenCommandId).toBe("");
  });
});

describe("buildHello", () => {
  it("shapes the hello frame per ADR 015 §2.1's baseline fields plus the optional keep-updated ones", () => {
    const hello = buildHello({
      deviceId: "d1",
      windowId: "w1",
      token: "nk_abc",
      client: "nooklet-web",
      controlEnabled: true,
      page: { id: "p1", name: "Projects/Aurora" },
      focused: true,
    });
    expect(hello).toEqual({
      type: "hello",
      device_id: "d1",
      window_id: "w1",
      token: "nk_abc",
      client: "nooklet-web",
      control_enabled: true,
      page: { id: "p1", name: "Projects/Aurora" },
      focused: true,
    });
  });
});

describe("state.result under the live socket's frame limit (B-676 H12)", () => {
  const id = (i: number) => i.toString(32).padStart(14, "0");
  const selecting = (n: number): UiWindowStateWire => ({
    ...STATE_STUB,
    focus: {
      mode: "block_selection",
      block_id: id(0),
      selected_block_ids: Array.from({ length: n }, (_, i) => id(i)),
      cursor: null,
    },
  });
  const ask = async (n: number) =>
    JSON.parse(
      (await handleIncomingFrame(
        JSON.stringify({ type: "state.get", request_id: "r1" }),
        deps({ buildState: () => selecting(n) }),
      )) as string,
    );

  it("10,000 selected blocks (a select-all on a very large page) go through whole", async () => {
    const reply = await ask(10_000);
    expect(reply.state.focus.selected_block_ids).toHaveLength(10_000);
    expect(reply.state.focus.selected_block_count).toBeUndefined();
  });

  it("past what fits, the id list is cut and the real count is reported, under the limit", async () => {
    const reply = await ask(50_000);
    expect(new TextEncoder().encode(JSON.stringify(reply)).length).toBeLessThanOrEqual(
      LIVE_MAX_PAYLOAD_BYTES,
    );
    expect(reply.state.focus.selected_block_count).toBe(50_000);
    expect(reply.state.focus.selected_block_ids.length).toBeGreaterThan(25_000);
    expect(reply.state.focus.selected_block_ids.length).toBeLessThan(50_000);
  });
});
