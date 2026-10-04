/**
 * `/ui/live`'s wire protocol, client side (ADR 015 §2.3/§2.4): turns one incoming frame into the
 * reply frame to send back, or `null` to ignore it. Pure apart from `deps.buildState`/`deps.
 * runCommand` (both injected), so this is the one place the protocol's logic is tested — `./socket.ts`
 * is deliberately just wiring this function to a real `WebSocket`, mirroring
 * `../sync/http-transport.ts`'s own "thin, untested wiring around tested logic" split.
 */

import { LIVE_MAX_PAYLOAD_BYTES } from "@nooklet/core";
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

/** A thrown message is relayed to an agent verbatim; this bounds a pathological one (a stack, a
 * serialized document) to what an error message needs. */
const MAX_ERROR_CHARS = 1000;

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
    return stateResultFrame(requestId, deps.buildState());
  }

  if (msg.type === "command.run") {
    const commandId = typeof msg.command_id === "string" ? msg.command_id : "";
    let result: CommandRunResult;
    try {
      result = await deps.runCommand(commandId, msg.args);
    } catch (e) {
      // A command that throws — most often one refusing its args (`task.setScheduled` given
      // "banana") — still gets an answer. With none, the server waited out its RPC timeout and told
      // the agent the window was busy and to try again: the very input that fails again (B-148).
      // `error` in place of `when_result` is how the server tells the two apart.
      const error = (e instanceof Error ? e.message : String(e)).slice(0, MAX_ERROR_CHARS);
      activityLog.record(`Claude tried ${commandId} (it failed: ${error})`);
      return JSON.stringify({ type: "command.result", request_id: requestId, error });
    }
    activityLog.record(describeCommandActivity(commandId, result.when_result));
    return JSON.stringify({ type: "command.result", request_id: requestId, ...result });
  }

  return null;
}

/** Room left under the server's frame limit for the rest of the frame, generously: everything but
 * the selected ids is ~1 KB (`tools/probes/security/ws-frame-sizes.mjs`). */
const STATE_FRAME_BUDGET = LIVE_MAX_PAYLOAD_BYTES - 16 * 1024;

/**
 * The `state.result` frame, kept under the server's frame limit (B-676 H12). A frame over
 * `LIVE_MAX_PAYLOAD_BYTES` gets this window's socket closed with 1009, so the agent would get no
 * answer at all. The only part that grows is `selected_block_ids` (17 bytes an id; a select-all
 * on a huge page), so that list is cut to fit and `selected_block_count` says how many there
 * really were. Under ~30,000 selected blocks nothing changes.
 */
export function stateResultFrame(requestId: string, state: UiWindowStateWire): string {
  const frame = JSON.stringify({ type: "state.result", request_id: requestId, state });
  // Bytes, not string length: the limit is on UTF-8, and a page name may not be ASCII.
  const bytes = new TextEncoder().encode(frame).length;
  if (bytes <= STATE_FRAME_BUDGET) return frame;
  const ids = state.focus.selected_block_ids;
  // Ids are 14 ASCII chars: 17 bytes each with quotes and comma.
  const keep = Math.max(0, ids.length - Math.ceil((bytes - STATE_FRAME_BUDGET) / 17));
  return JSON.stringify({
    type: "state.result",
    request_id: requestId,
    state: {
      ...state,
      focus: {
        ...state.focus,
        selected_block_ids: ids.slice(0, keep),
        selected_block_count: ids.length,
      },
    },
  });
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
