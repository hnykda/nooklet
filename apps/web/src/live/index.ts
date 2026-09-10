/**
 * Public surface of ADR 015's live-UI-control channel client (`apps/web/src/live/`). See
 * `../app/CommandLayer.tsx` for the socket wiring and `../shell/AppShell.tsx` for the badge mount.
 */

export {
  type ActivityEntry,
  type ActivityLog,
  activityLog,
  describeCommandActivity,
} from "./activity-log.js";
export { BADGE_LABEL, type BadgeState, deriveBadgeState } from "./badge-state.js";
export { ConsentBadge } from "./ConsentBadge.js";
export {
  type CommandRunDeps,
  type CommandRunResult,
  runRemoteCommand,
  type WhenResult,
} from "./command-runner.js";
export { liveConnected, setLiveConnected } from "./connection-state.js";
export {
  type ConsentState,
  type ConsentStorageAdapter,
  type ConsentStore,
  createConsentStore,
  liveConsent,
} from "./consent.js";
export {
  type FlashEvent,
  type FlashListener,
  flashRemoteTouch,
  subscribeFlash,
} from "./flash-bus.js";
export { buildHello, handleIncomingFrame, type MessageHandlerDeps } from "./message-handler.js";
export { flashBlockWhenReady, RemoteFlashOverlay } from "./RemoteFlashOverlay.js";
export { connectLiveSocket, type LiveSocketHandle, type LiveSocketOptions } from "./socket.js";
export {
  type BuildUiWindowStateInputs,
  buildUiWindowState,
  type PanelState,
  type UiWindowStateWire,
  type ViewportState,
} from "./state-snapshot.js";
export type {
  CommandRunMessage,
  HelloMessage,
  ServerToClientMessage,
  StateGetMessage,
} from "./types.js";
export { getOrCreateWindowId, type WindowIdStorageAdapter } from "./window-id.js";
