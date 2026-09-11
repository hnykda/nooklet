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
 */

import { createSignal, type JSX, Show } from "solid-js";
import { setStoredToken } from "../data/bootstrap.js";
import "./connect.css";

export function ConnectView(props: { reason?: string; onSkip?: () => void }): JSX.Element {
  const [token, setToken] = createSignal("");
  const [error, setError] = createSignal<string | undefined>();
  const [busy, setBusy] = createSignal(false);

  async function connect(e: Event): Promise<void> {
    e.preventDefault();
    const value = token().trim();
    if (!value) return;
    setBusy(true);
    setError(undefined);
    try {
      // Verify before storing, so a typo fails here with a readable message rather than becoming a
      // silent permanent "offline" three screens later — which is exactly how the missing-token
      // bug presented before any of this existed.
      const res = await fetch("/api/v1/graph.overview", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${value}` },
        body: "{}",
      });
      if (res.status === 401 || res.status === 403) {
        setError("That token was rejected. Check it was copied whole, and not revoked.");
        return;
      }
      if (!res.ok) {
        setError(`Server returned ${res.status}. Is this the right address?`);
        return;
      }
      setStoredToken(value);
      // Full reload: the sync worker receives its token once at startup, so restarting the page is
      // the honest way to get every transport onto the new credential.
      location.reload();
    } catch (err) {
      setError(`Could not reach the server: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main class="connect">
      <h1>Connect this device</h1>
      <p class="connect-lede">
        This device needs a token to reach <code>{location.host}</code>. Create one on the machine
        running nooklet:
      </p>
      <pre class="connect-cmd">nooklet token create --label phone --scope write --sync</pre>
      <p class="connect-note">The token is shown once. Paste it here.</p>

      <form onSubmit={(e) => void connect(e)}>
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
          <button type="submit" disabled={busy() || token().trim() === ""}>
            {busy() ? "Checking…" : "Connect"}
          </button>
          <Show when={props.onSkip}>
            <button type="button" class="connect-skip" onClick={props.onSkip}>
              Continue without syncing
            </button>
          </Show>
        </div>
      </form>

      <Show when={props.reason === "non_loopback_host"}>
        <p class="connect-why">
          nooklet only hands out a token automatically to a browser on the same machine as the
          server. Over a network it cannot tell you apart from anyone else who can reach it.
        </p>
      </Show>
      <p class="connect-why">
        Sending a token over plain HTTP exposes it to anyone on the network path. Outside a trusted
        LAN, put the server behind HTTPS or reach it over a tailnet such as Tailscale.
      </p>
    </main>
  );
}
