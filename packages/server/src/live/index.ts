/**
 * `/ui/live` (ADR 015): the single entry point `../http/app.ts` calls to mount the socket, plus
 * the five `ui.*` ops `../ops/index.ts` registers into `CORE_OPS`.
 */

import type { Hono } from "hono";
import type { ServerContext } from "../apply-ops.js";
import { registerUiLive } from "./live.js";

export function mountUiLive(app: Hono, serverCtx: ServerContext): void {
  registerUiLive(app, serverCtx);
}

export { uiRun } from "./run-remote-command.js";
export { uiState } from "./ui-get-state.js";
export { uiHighlight } from "./ui-highlight.js";
export { uiWindows } from "./ui-list-windows.js";
export { uiNavigate } from "./ui-navigate.js";
