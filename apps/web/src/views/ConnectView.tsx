/**
 * Shown when this device has no token for the server it just loaded from.
 *
 * The server injects a token only for a loopback caller (`server/src/http/app.ts`) — over a LAN,
 * a tailnet or the internet it would otherwise hand a write credential to anyone who opens the
 * page. So every *remote* device (the phone this is mostly for) arrives with `token: null`, and
 * this is where it gets one.
 *
 * Deliberately a paste-a-token screen rather than a login: nooklet is single-user and self-hosted,
 * there are no accounts, and tokens already exist as the unit of access with scopes and
 * revocation (`nooklet token create/list/revoke`). A pairing code or QR is a nicer front-end for
 * this same exchange and is worth doing later; it is not a different security model.
 *
 * Under Capacitor (`platform.name === "capacitor"`) an extra "server address" field appears first.
 * A browser tab already has a server address — the origin `location.host` names, which is why the
 * web/PWA path below still works exactly as before. A Capacitor build's WKWebView has no address
 * bar: its origin is the fixed `capacitor://localhost` scheme, never the user's actual self-hosted
 * server, so there is nothing for a relative `fetch("/api/v1/...")` to reach until this screen asks
 * for the real address. See `data/bootstrap.ts`'s `setConnectedGraphToken`/`apiBaseUrl` doc comments.
 *
 * B-563: when a skip path exists at all (`props.onSkip`), the form below is preceded by an
 * explicit "just this device" vs "sync with a server" choice, rather than showing two required-
 * looking fields with the opt-out demoted to a same-row second button — a real user read that as
 * "syncing is mandatory" (owner feedback). Only picking the sync option reveals the form.
 *
 * B-603: a `nooklet://connect?url=…&token=…` pairing link opens this same form pre-filled
 * (`props.prefill`, from `PairingLinkPrompt.tsx`). It never connects by itself: anything that can
 * open a URL on the phone can craft such a link, so the address is shown in plain view and nothing
 * happens until the owner taps Connect. `onCancel` dismisses it.
 */

import { Server, Smartphone } from "lucide-solid";
import { createSignal, type JSX, Show } from "solid-js";
import { connectToGraph, type PairingLink, parseServerUrl } from "../data/connect-graph.js";
import { platform } from "../platform/index.js";
import "./connect.css";

export function ConnectView(props: {
  reason?: string;
  onSkip?: () => void;
  /** From a pairing link (B-603): fills both fields and shows the confirm-this-server wording. */
  prefill?: PairingLink;
  onCancel?: () => void;
}): JSX.Element {
  // A plain read, not a signal: the shell this build runs in cannot change mid-session. A pairing
  // link always names a server, so it needs the field wherever it was opened.
  const showServerField = platform.name === "capacitor" || props.prefill !== undefined;

  // No skip path means there is nothing to choose between — go straight to the form, as before
  // B-563. Otherwise start undecided so the choice renders first.
  const [wantsSync, setWantsSync] = createSignal(props.onSkip && !props.prefill ? undefined : true);

  const [serverUrl, setServerUrl] = createSignal(props.prefill?.serverUrl ?? "");
  const [token, setToken] = createSignal(props.prefill?.token ?? "");
  const [error, setError] = createSignal<string | undefined>();
  const [busy, setBusy] = createSignal(false);

  async function connect(e: Event): Promise<void> {
    e.preventDefault();
    const tokenValue = token().trim();
    if (!tokenValue) return;

    // Built explicitly from the typed address rather than storing it and reading `apiBaseUrl()`
    // back: a wrong address must fail this fetch, not silently resolve against
    // `capacitor://localhost` because nothing was stored yet.
    let base = "";
    if (showServerField) {
      const parsed = parseServerUrl(serverUrl());
      if ("error" in parsed) {
        setError(parsed.error);
        return;
      }
      base = parsed.url;
    }

    setBusy(true);
    setError(undefined);
    // Verify before storing, so a typo fails here with a readable message rather than becoming a
    // silent permanent "offline" three screens later — which is exactly how the missing-token bug
    // presented before any of this existed.
    const result = await connectToGraph(showServerField ? base : null, tokenValue);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // Full reload: the sync worker receives its token once at startup, so restarting the page is
    // the honest way to get every transport onto the new credential (and, under Capacitor, the
    // new server address).
    location.reload();
  }

  return (
    <main class="connect">
      <Show
        when={wantsSync()}
        fallback={
          <>
            <h1>Set up this device</h1>
            <p class="connect-lede">
              Notes always work on this device by itself. Add a server only if you want them to
              reach your other devices too.
            </p>
            <div class="connect-choice">
              <button type="button" class="connect-choice-option" onClick={props.onSkip}>
                <span class="connect-choice-icon">
                  <Smartphone size={22} />
                </span>
                <span class="connect-choice-text">
                  <h2>Just this device</h2>
                  <p>
                    Nothing to set up. You'll see this screen again if you want to add a server
                    later.
                  </p>
                </span>
              </button>
              <button
                type="button"
                class="connect-choice-option"
                onClick={() => setWantsSync(true)}
              >
                <span class="connect-choice-icon">
                  <Server size={22} />
                </span>
                <span class="connect-choice-text">
                  <h2>Sync with a server</h2>
                  <p>Connect to a nooklet server you already run, to keep every device in sync.</p>
                </span>
              </button>
            </div>
          </>
        }
      >
        <Show when={props.onSkip && !props.prefill}>
          <button type="button" class="connect-back" onClick={() => setWantsSync(undefined)}>
            ‹ Back
          </button>
        </Show>
        <Show when={props.prefill} fallback={<h1>Connect this device</h1>}>
          {(prefill) => (
            <>
              <h1>Connect to this server?</h1>
              <p class="connect-lede">
                A pairing link asked to sync this device with the server below. Connect only if it
                is yours.
              </p>
              <p class="connect-pairing-server" data-testid="pairing-server">
                {prefill().serverUrl}
              </p>
            </>
          )}
        </Show>
        <Show
          when={showServerField && !props.prefill}
          fallback={
            <p class="connect-lede">
              This device needs a token to reach <code>{location.host}</code>. Create one on the
              machine running nooklet:
            </p>
          }
        >
          <p class="connect-lede">
            This device needs your nooklet server's address and a token. Create the token on the
            machine running nooklet:
          </p>
        </Show>
        <Show when={!props.prefill}>
          <pre class="connect-cmd">nooklet token create --label phone --scope write --sync</pre>
          <p class="connect-note">The token is shown once. Paste it here.</p>
        </Show>

        <form onSubmit={(e) => void connect(e)}>
          <Show when={showServerField}>
            <label class="connect-field">
              <span>Server address</span>
              <input
                type="text"
                inputmode="url"
                autocomplete="off"
                autocapitalize="none"
                autocorrect="off"
                spellcheck={false}
                placeholder="https://nooklet.example.com"
                value={serverUrl()}
                onInput={(e) => setServerUrl(e.currentTarget.value)}
              />
            </label>
          </Show>
          <label class="connect-field">
            <span>Device token</span>
            <input
              type="password"
              autocomplete="off"
              autocapitalize="none"
              autocorrect="off"
              spellcheck={false}
              placeholder="nk_…"
              value={token()}
              onInput={(e) => setToken(e.currentTarget.value)}
            />
          </label>
          <Show when={error()}>
            <p class="connect-error" role="alert">
              {error()}
            </p>
          </Show>
          <div class="connect-actions">
            <button
              type="submit"
              disabled={
                busy() || token().trim() === "" || (showServerField && serverUrl().trim() === "")
              }
            >
              {busy() ? "Checking…" : "Connect"}
            </button>
            <Show when={props.onCancel}>
              <button type="button" class="connect-skip" onClick={() => props.onCancel?.()}>
                Cancel
              </button>
            </Show>
          </div>
        </form>

        <Show when={props.reason === "loopback_token_disabled"}>
          <p class="connect-why">
            This server was started with --no-loopback-token, so it hands no token out
            automatically, not even to a browser on its own machine.
          </p>
        </Show>
        <Show when={props.reason === "non_loopback_host"}>
          <p class="connect-why">
            nooklet only hands out a token automatically to a browser on the same machine as the
            server. Over a network it cannot tell you apart from anyone else who can reach it.
          </p>
        </Show>
        <p class="connect-why">
          Sending a token over plain HTTP exposes it to anyone on the network path. Outside a
          trusted LAN, put the server behind HTTPS or reach it over a tailnet such as Tailscale.
        </p>
      </Show>
    </main>
  );
}
