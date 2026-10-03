/**
 * B-615: the page shown instead of the app when this browser will not give it what it needs.
 *
 * The client keeps its replica in OPFS, elects a writer tab with `navigator.locks`, and mints ids
 * with `crypto.randomUUID`. Browsers expose all three only in a *secure context*: HTTPS, or a
 * loopback origin (`localhost`, `127.0.0.1`). Over plain http on a LAN or tailnet IP they are simply
 * absent (B-27), and the app used to accept a token and then render a blank white page, with only
 * `crypto.randomUUID is not a function` in a console nobody on a phone can open.
 *
 * Checked in `./entry.ts` before `./main.tsx` is even loaded, because its imports are what fail:
 * module-level code in `live/window-id.ts` and friends runs at import time, before any check in
 * `main.tsx`'s body could.
 *
 * The capability check, not only `isSecureContext`, decides: what breaks is the missing APIs, and a
 * shell that is secure but somehow lacks them should land here too, not on a blank page. The iOS
 * Capacitor shell (`capacitor://localhost`) passes: it reported `isSecureContext=true` on the iOS
 * Simulator (`tools/probes/capacitor-network/`, recorded in `docs/progress/real-device-test.md`),
 * and the real app boots there, which it cannot do without `crypto.randomUUID`/`navigator.locks`.
 * The desktop app pointed at a plain-http remote lands here, as a browser tab does.
 */

import "./styles/shell.css";
import "./views/connect.css";

export interface InsecureContextFacts {
  isSecureContext: boolean | undefined;
  hasRandomUUID: boolean;
  hasLocks: boolean;
}

export function currentContextFacts(): InsecureContextFacts {
  return {
    isSecureContext: typeof window === "undefined" ? undefined : window.isSecureContext,
    hasRandomUUID: typeof crypto !== "undefined" && typeof crypto.randomUUID === "function",
    hasLocks: typeof navigator !== "undefined" && "locks" in navigator && Boolean(navigator.locks),
  };
}

/** True when the app cannot run here. */
export function cannotRunHere(facts: InsecureContextFacts): boolean {
  return facts.isSecureContext === false || !facts.hasRandomUUID || !facts.hasLocks;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: { class?: string } = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs.class) node.className = attrs.class;
  node.append(...children);
  return node;
}

/** Plain DOM, no Solid: the point is to depend on as little of the app as possible. */
export function renderInsecureContextPage(root: HTMLElement, loc: Location): void {
  const port = loc.port ? `:${loc.port}` : "";
  const path = `${loc.pathname}${loc.search}`;
  root.replaceChildren(
    el(
      "main",
      { class: "connect connect-insecure" },
      el("h1", {}, "nooklet needs a secure connection"),
      el(
        "p",
        { class: "connect-lede" },
        "This page was opened over plain HTTP at ",
        el("code", {}, loc.origin),
        ". Browsers only give a page the storage nooklet keeps your notes in, and the tools it uses " +
          "to keep two tabs from writing at once, when the connection is HTTPS or the page is on " +
          "this same machine. Here they are switched off, so the app cannot start.",
      ),
      el("p", { class: "connect-lede" }, "Any one of these fixes it:"),
      el(
        "ul",
        { class: "connect-fixes" },
        el(
          "li",
          {},
          el("strong", {}, "Tailscale: "),
          "on the machine running nooklet, run ",
          el("code", {}, `tailscale serve --bg ${loc.port || "6100"}`),
          ", then open the ",
          el("code", {}, "https://….ts.net"),
          " address it prints. A tailnet IP over plain http is not enough.",
        ),
        el(
          "li",
          {},
          el("strong", {}, "HTTPS: "),
          "put nooklet behind a reverse proxy with a certificate (Caddy, nginx), and open ",
          el("code", {}, `https://${loc.hostname}${path}`),
          " instead.",
        ),
        el(
          "li",
          {},
          el("strong", {}, "This machine: "),
          "on the computer running nooklet, open ",
          el("code", {}, `http://localhost${port}${path}`),
          ". From another computer, an SSH tunnel does the same: ",
          el("code", {}, `ssh -L ${loc.port || "6100"}:localhost:${loc.port || "6100"} <server>`),
          ".",
        ),
      ),
      el(
        "p",
        { class: "connect-why" },
        "Nothing was stored or sent. A device token entered here would also cross the network " +
          "unencrypted, which HTTPS fixes as well.",
      ),
    ),
  );
}
