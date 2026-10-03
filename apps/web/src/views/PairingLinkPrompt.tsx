/**
 * B-603: handles `nooklet://connect?url=…&token=…` pairing links (printed by
 * `nooklet token create --link <public url>`). Before this, `platform.deepLinks.onOpen` had no
 * subscriber anywhere, so such a link only brought the app to the front.
 *
 * Mounted once at the top of `App.tsx`, outside the token gate, so a link works in every state:
 * first launch (no graph yet), a local-only device, or one already syncing with another server.
 * It shows `ConnectView` pre-filled over whatever is on screen and waits for the owner to tap
 * Connect. Never silent: anything that can open a URL on the phone can craft this link.
 *
 * Connecting goes through `connectToGraph`, which ADDS a remote entry to the graph list (or reuses
 * one with the same address) and makes it active (ADR 025). Local-only graphs stay in the list
 * and remain reachable from the graph switcher.
 */
import { createSignal, type JSX, onCleanup, Show } from "solid-js";
import { type PairingLink, parsePairingLink } from "../data/connect-graph.js";
import { platform } from "../platform/index.js";
import { ConnectView } from "./ConnectView.js";
import "./connect.css";

type Pending = { link: PairingLink } | { error: string };

export function PairingLinkPrompt(): JSX.Element {
  const [pending, setPending] = createSignal<Pending | undefined>();
  // A new link replaces the one on screen; remounting ConnectView resets its fields.
  const [generation, setGeneration] = createSignal(0);

  const stop = platform.deepLinks.onOpen((url) => {
    const parsed = parsePairingLink(url);
    if (parsed === undefined) return; // some other nooklet:// link: not ours
    setPending("error" in parsed ? { error: parsed.error } : { link: parsed });
    setGeneration((g) => g + 1);
  });
  onCleanup(stop);

  const dismiss = (): void => setPending(undefined);

  return (
    <Show when={pending()}>
      {(p) => (
        <div class="pairing-overlay" role="dialog" aria-modal="true" aria-label="Pairing link">
          <Show
            when={"link" in p() ? (p() as { link: PairingLink }).link : undefined}
            keyed
            fallback={
              <main class="connect">
                <h1>This pairing link can't be used</h1>
                <p class="connect-error" role="alert">
                  {(p() as { error: string }).error}
                </p>
                <div class="connect-actions">
                  <button type="button" onClick={dismiss}>
                    OK
                  </button>
                </div>
              </main>
            }
          >
            {(link) => (
              <Show when={generation()} keyed>
                <ConnectView prefill={link} onCancel={dismiss} />
              </Show>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}
