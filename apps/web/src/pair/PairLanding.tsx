/**
 * The page a pairing QR code opens: `<graph address>/pair#code=<one-time code>` (B-655).
 *
 * The QR holds this https page, not `nooklet://…` directly, because the iOS Camera app is not
 * documented to open custom-scheme URLs and developer reports say it shows them as text or hands
 * them to a browser (`docs/progress/qr-pairing.md`, "Camera"). Every camera opens an https link.
 * From here a TAP on "Open in the nooklet app" opens the custom scheme, which iOS does route to an
 * installed app (with its own "Open in nooklet?" prompt).
 *
 * Rendered by `../main.tsx` before anything else — before the insecure-context check (a phone on
 * a plain-http LAN address must still get the app button) and without booting the replica, the
 * sync worker or the token gate: this page needs none of them, and the full app would pay seconds
 * of OPFS start-up only to show two buttons.
 *
 * The code is in the fragment, so no server ever saw it in a request line or log. It is read once
 * and then removed from the address bar and the history entry.
 */

import { type JSX, Show } from "solid-js";
import { render } from "solid-js/web";
import { pairCodeFromHash, pairingAppLink } from "../data/pairing.js";
import "../styles/shell.css";
import "../views/connect.css";
import "./pair.css";

export interface PairLandingProps {
  /** `https://host[/proxy]/g/<id>`: the graph this code belongs to. */
  graphAddress: string;
  /** Path of the graph's app, same origin (`/g/<id>`), for "use this browser". */
  appPath: string;
  code: string | undefined;
  /** Whether the full app can run in this browser (`../insecure-context.ts`). */
  browserCanRun: boolean;
}

export function PairLanding(props: PairLandingProps): JSX.Element {
  return (
    <main class="connect pair-landing" aria-label="Pair this device">
      <h1>Pair this device with nooklet</h1>
      <Show
        when={props.code}
        fallback={
          <p class="connect-error" role="alert">
            This pairing link has no valid code. Make a new one on the device that showed the QR
            code (Settings → Devices → Add a device).
          </p>
        }
      >
        {(code) => (
          <>
            <p class="connect-lede">This device will sync with:</p>
            <p class="connect-pairing-server" data-testid="pair-server">
              {props.graphAddress}
            </p>
            <a
              class="pair-primary"
              data-testid="pair-open-app"
              href={pairingAppLink(props.graphAddress, code())}
            >
              Open in the nooklet app
            </a>
            <p class="connect-note">
              The app asks you to confirm the server and name this device. If nothing happens, the
              nooklet app is not installed here: install it, then scan the code again. A code works
              once and expires after 10 minutes; make a new one if this one has run out.
            </p>
            <Show
              when={props.browserCanRun}
              fallback={
                <p class="connect-why">
                  nooklet cannot run in this browser at this address (it needs https), so it can
                  only be paired through the app.
                </p>
              }
            >
              <a
                class="pair-secondary"
                data-testid="pair-use-browser"
                href={`${props.appPath}/#pair=${encodeURIComponent(code())}`}
              >
                Use nooklet in this browser instead
              </a>
            </Show>
          </>
        )}
      </Show>
    </main>
  );
}

/** Mounts the landing for this page load and scrubs the code from the address bar. */
export function mountPairLanding(root: HTMLElement, loc: Location, browserCanRun: boolean): void {
  const code = pairCodeFromHash(loc.hash);
  const appPath = loc.pathname.replace(/\/pair\/?$/, "");
  const graphAddress = `${loc.origin}${appPath}`;
  history.replaceState(null, "", loc.pathname);
  render(
    () => (
      <PairLanding
        graphAddress={graphAddress}
        appPath={appPath}
        code={code}
        browserCanRun={browserCanRun}
      />
    ),
    root,
  );
}
