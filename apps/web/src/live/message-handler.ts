/**
 * `/ui/live`'s wire protocol, client side (ADR 015 §2.3/§2.4): turns one incoming frame into the
 * reply frame to send back, or `null` to ignore it. Pure apart from `deps.buildState`/`deps.
 * runCommand` (both injected), so this is the one place the protocol's logic is tested — `./socket.ts`
 * is deliberately just wiring this function to a real `WebSocket`, mirroring
 * `../sync/http-transport.ts`'s own "thin, untested wiring around tested logic" split.
 */

import { activityLog, describeCommandActivity } from "./activity-log.js";
import type { CommandRunResult } from "./command-runner.js";
import type { UiWindowStateWire } from "./state-snapshot.js";
import type { HelloMessage } from "./types.js";

export interface MessageHandlerDeps {
  /** Read the CURRENT window state fresh on every `state.get` — never cached, since the whole
   * point is answering "what is on screen right now." */
  buildState: () => UiWindowStateWire;
  runCommand: (commandId: string, args: unknown) => Promise<CommandRunResult>;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

/** Parse one raw frame from the server and produce the raw frame to reply with (or `null` to send
 * nothing — an unrecognized `type`, or a frame with no usable `request_id`). Never throws: a
 * malformed frame is ignored, matching `../sync/live.ts`'s server-side tolerance. */
export async function handleIncomingFrame(
  raw: string,
  deps: MessageHandlerDeps,
): Promise<string | null> {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(msg) || typeof msg.request_id !== "string") return null;
  const requestId = msg.request_id;

  if (msg.type === "state.get") {
    activityLog.record("Claude looked at this window");
    return JSON.stringify({
      type: "state.result",
      request_id: requestId,
      state: deps.buildState(),
    });
  }

  if (msg.type === "command.run") {
    const commandId = typeof msg.command_id === "string" ? msg.command_id : "";
    const result = await deps.runCommand(commandId, msg.args);
    activityLog.record(describeCommandActivity(commandId, result.when_result));
    return JSON.stringify({ type: "command.result", request_id: requestId, ...result });
  }

  return null;
}

/** The `hello` frame a window sends on connect, and re-sends (per ADR 015 §1's "keep it updated")
 * whenever its page/focus changes. */
export function buildHello(info: {
  deviceId: string;
  windowId: string;
  token: string;
  client: string;
  controlEnabled: boolean;
  page?: { id: string; name: string } | null;
  focused?: boolean;
}): HelloMessage {
  return {
    type: "hello",
    device_id: info.deviceId,
    window_id: info.windowId,
    token: info.token,
    client: info.client,
    control_enabled: info.controlEnabled,
    page: info.page,
    focused: info.focused,
  };
}
