/**
 * `/ui/live` wire message shapes (ADR 015 §2.1/§2.3/§2.4), the client's own local copy — mirrors
 * `packages/server/src/live/live.ts`'s `HelloMessage`/`ResultMessage` and
 * `packages/server/src/live/schemas.ts`'s `UiWindowState`, exactly like `../sync/types.ts` keeps
 * its own local copy of the sync protocol rather than importing server types across the
 * client/server boundary.
 */

export interface HelloMessage {
  type: "hello";
  device_id: string;
  window_id: string;
  token: string;
  client: string;
  control_enabled: boolean;
  /** Optional: present on the initial hello and on any later re-hello that has fresh page/focus
   * info to report (ADR 015 §1's "keep it updated"). */
  page?: { id: string; name: string } | null;
  focused?: boolean;
}

export interface StateGetMessage {
  type: "state.get";
  request_id: string;
}

export interface CommandRunMessage {
  type: "command.run";
  request_id: string;
  command_id: string;
  args?: unknown;
  actor: string;
  client?: string;
}

export type ServerToClientMessage = StateGetMessage | CommandRunMessage;
