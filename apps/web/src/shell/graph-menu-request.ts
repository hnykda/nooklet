/**
 * "Open the graph menu" from outside it: the desktop app's native Graphs… item (proposal 005). The
 * menu lives in the sidebar, which is not mounted while it is closed, so a request opens the
 * sidebar and is left pending until the menu mounts (or, if it is already there, runs at once).
 */
import { createSignal } from "solid-js";

const [requests, setRequests] = createSignal(0);
let pending = false;

export function requestGraphMenu(): void {
  document.body.classList.add("sidebar-open");
  pending = true;
  setRequests((n) => n + 1);
}

/** Read in an effect: re-runs on each request. */
export const graphMenuRequests = requests;

/** Whether a request is waiting; reading it consumes it. */
export function takeGraphMenuRequest(): boolean {
  const was = pending;
  pending = false;
  return was;
}
