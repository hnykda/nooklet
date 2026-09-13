/**
 * What the launcher page says, given what the app knows about its server (B-430).
 *
 * `status` is `server_status`'s answer (`../src-tauri/src/main.rs`, shape pinned by
 * `../test/server-status.json`), or `null` when there is nobody to ask — the page opened outside
 * the app, or an app too old to answer. Pure, so `../test/launcher-status.test.mjs` can hold every
 * wording without a webview.
 *
 * The rule the wording follows: "start a server" is advice only when the app spawned nothing. When
 * its own bundled server failed, the page says why in words, and shows the server's last output
 * verbatim underneath, because that is the thing a bug report needs and nobody launching from
 * Finder can otherwise see.
 *
 * @typedef {{ state: "external" } | { state: "starting" } | { state: "ready" }
 *   | { state: "spawn_failed", error: string }
 *   | { state: "exited", code: number | null, reason: "schema_too_new" | "port_in_use" | "other", stderr: string }
 *   | { state: "timed_out", stderr: string }} ServerStatus
 *
 * @typedef {{
 *   kind: "starting" | "problem" | "no-server",
 *   title: string,
 *   message: string,
 *   detail?: string,
 *   suggestServe: boolean,
 * }} LauncherView
 */

/** The port the app's bundled server listens on (`PORT` in main.rs). */
export const APP_PORT = 6100;

/**
 * @param {ServerStatus | null | undefined} status
 * @returns {LauncherView}
 */
export function describeStatus(status) {
  switch (status?.state) {
    case "starting":
    case "ready":
      // `ready` still reads as starting: the page redirects on its own /healthz check, which may
      // be a poll behind the app's.
      return {
        kind: "starting",
        title: "Starting nooklet…",
        message: "",
        suggestServe: false,
      };
    case "timed_out":
      return {
        kind: "problem",
        title: "nooklet is taking unusually long to start",
        message:
          "Its server is still running but has not answered yet. This page will open nooklet as " +
          "soon as it does. If it never does, quit the app and open it again.",
        detail: status.stderr || undefined,
        suggestServe: false,
      };
    case "spawn_failed":
      return {
        kind: "problem",
        title: "nooklet's server couldn't be started",
        message:
          "The server that comes with the app could not be launched, which usually means the app " +
          "is damaged. Reinstalling nooklet should fix it.",
        detail: status.error || undefined,
        suggestServe: false,
      };
    case "exited":
      return describeExit(status);
    case "external":
      return {
        kind: "no-server",
        title: "Couldn't reach the nooklet server",
        message:
          "nooklet was using a server that was already running on this computer, and it is not " +
          "answering any more. Start it again, then retry:",
        suggestServe: true,
      };
    default:
      return {
        kind: "no-server",
        title: "Couldn't reach the nooklet server",
        message: "Start it, then try again:",
        suggestServe: true,
      };
  }
}

/** @param {Extract<ServerStatus, { state: "exited" }>} status */
function describeExit(status) {
  const detail = status.stderr || undefined;
  switch (status.reason) {
    case "schema_too_new":
      return {
        kind: "problem",
        title: "This graph needs a newer version of nooklet",
        message:
          "Your graph was last opened by a newer nooklet than this one, so this copy of the app " +
          "can't read it. Update the app, then open it again.",
        detail,
        suggestServe: false,
      };
    case "port_in_use":
      return {
        kind: "problem",
        title: "nooklet's port is taken",
        message:
          `Another program is already using port ${APP_PORT}, which nooklet's server needs. ` +
          "Quit that program, then open nooklet again.",
        detail,
        suggestServe: false,
      };
    default: {
      const how = status.code === null ? "was stopped" : `exited with code ${status.code}`;
      return {
        kind: "problem",
        title: "nooklet's server stopped while starting",
        message: `The server that comes with the app ${how} before it was ready.${
          detail ? " Its last output is below." : ""
        }`,
        detail,
        suggestServe: false,
      };
    }
  }
}
