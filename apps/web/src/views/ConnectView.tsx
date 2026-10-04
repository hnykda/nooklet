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
 * B-613: also the re-pair screen (`props.repair`), opened from the sync indicator when the server
 * refuses the token a graph entry already has. Same form, but the address is the entry's own and
 * read-only: typing a different one here would attach this replica's local history to some other
 * graph, which is exactly the merge ADR 025 rules out. The entry keeps its id, so its local copy
 * and its unpushed changes are kept and pushed with the new token after the reload.
 *
 * B-603: a `nooklet://connect?url=…&token=…` pairing link opens this same form pre-filled
 * (`props.prefill`, from `PairingLinkPrompt.tsx`). It never connects by itself: anything that can
 * open a URL on the phone can craft such a link, so the address is shown in plain view and nothing
 * happens until the owner taps Connect. `onCancel` dismisses it.
 *
 * B-655: the link may carry a one-time pairing `code` instead of a token (from the QR pairing page,
 * `../pair/PairLanding.tsx`). The form then asks for this device's name, and Connect first trades
 * the code for a token (`pairing.redeem`, the one op callable without a token). `sameOrigin` is
 * the pairing page opened in a browser: it pairs with this page's own graph.
 *
 * Both at once: `repair` wins. The address stays the entry's own — a pairing link can never move a
 * repaired entry to another server or graph. Its token is used to pre-fill the token field only
 * when the link names that same graph (`sameGraphAddress`); otherwise the link is ignored here.
 */

import { Server, Smartphone } from "lucide-solid";
import { createResource, createSignal, type JSX, Show } from "solid-js";
import {
  connectToGraph,
  graphBaseUrl,
  type PairingLink,
  parseServerUrl,
  type RepairTarget,
} from "../data/connect-graph.js";
import { defaultDeviceLabel, redeemPairingCode } from "../data/pairing.js";
import { platform } from "../platform/index.js";
import "./connect.css";

export function ConnectView(props: {
  reason?: string;
  onSkip?: () => void;
  /** B-613: re-pair an existing entry whose token the server refused (see the header). */
  repair?: RepairTarget & { onCancel: () => void };
  /** From a pairing link (B-603): fills both fields and shows the confirm-this-server wording. */
  prefill?: PairingLink;
  onCancel?: () => void;
}): JSX.Element {
  // Repair wins over a pairing link (see the header): a link for some other graph is dropped
  // here, so nothing below can read its address.
  const prefill = props.prefill && !props.repair ? props.prefill : undefined;
  const repairToken =
    props.repair &&
    props.prefill &&
    sameGraphAddress(props.prefill.serverUrl, props.repair.displayUrl)
      ? props.prefill.token
      : undefined;

  // A plain read, not a signal: the shell this build runs in cannot change mid-session. A pairing
  // link always names a server, so it needs the field wherever it was opened. Never in repair mode,
  // where the address is fixed and shown read-only.
  // B-655: a pairing page opened in this browser pairs with this page's own graph (`sameOrigin`),
  // exactly as the web connect screen does, so there is no address to type or show as editable.
  const showServerField =
    !props.repair &&
    (platform.name === "capacitor" || (prefill !== undefined && !prefill.sameOrigin));
  // B-655: a one-time code instead of a token. The form asks for this device's name instead of a
  // token; Connect trades the code for a token (`pairing.redeem`), then connects with it as usual.
  const pairingCode = prefill?.code;

  // B-613, loopback only: the server hands a browser on its own machine a fresh token on every
  // start and retires the old one, so a tab left open across a `nooklet serve` restart is refused
  // too. There is nothing to paste then; a reload picks up the new token by itself.
  const [freshSessionToken] = createResource(
    () => props.repair,
    async (repair) => {
      try {
        const res = await fetch(`${repair.sessionBase}/api/session`, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) return false;
        const body = (await res.json()) as { token?: string | null };
        return Boolean(body.token);
      } catch {
        return false;
      }
    },
  );

  // No skip path means there is nothing to choose between — go straight to the form, as before
  // B-563. Otherwise start undecided so the choice renders first.
  const [wantsSync, setWantsSync] = createSignal(props.onSkip && !prefill ? undefined : true);

  const [serverUrl, setServerUrl] = createSignal(prefill?.serverUrl ?? "");
  const [token, setToken] = createSignal(repairToken ?? prefill?.token ?? "");
  const [deviceName, setDeviceName] = createSignal(defaultDeviceLabel(navigator.userAgent));
  const [error, setError] = createSignal<string | undefined>();
  const [busy, setBusy] = createSignal(false);

  async function connect(e: Event): Promise<void> {
    e.preventDefault();
    let tokenValue = token().trim();
    if (!tokenValue && !pairingCode) return;

    // Built explicitly from the typed address rather than storing it and reading `apiBaseUrl()`
    // back: a wrong address must fail this fetch, not silently resolve against
    // `capacitor://localhost` because nothing was stored yet.
    let base = "";
    if (props.repair) {
      base = props.repair.connectBase ?? "";
    } else if (showServerField) {
      const parsed = parseServerUrl(serverUrl());
      if ("error" in parsed) {
        setError(parsed.error);
        return;
      }
      base = parsed.url;
    }

    setBusy(true);
    setError(undefined);
    if (pairingCode) {
      const label = deviceName().trim();
      if (!label) {
        setBusy(false);
        return;
      }
      const redeemed = await redeemPairingCode(showServerField ? base : "", pairingCode, label);
      if (!redeemed.ok) {
        setBusy(false);
        setError(redeemed.error);
        return;
      }
      tokenValue = redeemed.token;
    }
    // Verify before storing, so a typo fails here with a readable message rather than becoming a
    // silent permanent "offline" three screens later — which is exactly how the missing-token bug
    // presented before any of this existed.
    const result = await connectToGraph(
      props.repair ? props.repair.connectBase : showServerField ? base : null,
      tokenValue,
    );
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

  if (props.repair) {
    const repair = props.repair;
    return (
      <main class="connect connect-repair" aria-label="Re-enter token">
        <button type="button" class="connect-back" onClick={repair.onCancel}>
          ‹ Back
        </button>
        <h1>The server rejected this device's token</h1>
        <p class="connect-lede">
          <code>{repair.displayUrl}</code> refused the token this device was using, most likely
          because it was revoked. Your notes and any changes not yet synced are kept on this device,
          and are sent once a new token is accepted.
        </p>
        <Show when={freshSessionToken()}>
          <p class="connect-note">
            This browser is on the server's own machine, which issues it a new token each time it
            starts. Reloading is enough.
          </p>
          <div class="connect-actions">
            <button type="button" onClick={() => location.reload()}>
              Reload
            </button>
          </div>
        </Show>
        <p class="connect-lede">Create a new token on the machine running nooklet:</p>
        <pre class="connect-cmd">{`nooklet token create --label device --scope write --sync${
          repair.graphSlug ? ` --graph ${repair.graphSlug}` : ""
        }`}</pre>
        <form onSubmit={(e) => void connect(e)}>
          <label class="connect-field">
            <span>Server address</span>
            {/* Token fields are plain text, not type="password": a token is pasted, not typed, so
                masking hides nothing useful, and iOS ignores autocomplete="off" on password fields and
                offers (or substitutes) a saved password — a valid token then reads as "rejected". */}
            <input type="text" readOnly value={repair.displayUrl} />
          </label>
          <label class="connect-field">
            <span>Device token</span>
            <input
              type="text"
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
          </div>
        </form>
      </main>
    );
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
                  {/* B-612: under Capacitor the choice is remembered as a graph of its own, and a
                      server is added later from the graph switcher, not from this screen. */}
                  <p>
                    {showServerField
                      ? "Nothing to set up. You can add a server later from the graph switcher."
                      : "Nothing to set up. You'll see this screen again if you want to add a server later."}
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
        <Show when={props.onSkip && !prefill}>
          <button type="button" class="connect-back" onClick={() => setWantsSync(undefined)}>
            ‹ Back
          </button>
        </Show>
        <Show when={prefill} fallback={<h1>Connect this device</h1>}>
          {(p) => (
            <>
              <h1>Connect to this server?</h1>
              <p class="connect-lede">
                A pairing link asked to sync this device with the server below. Connect only if it
                is yours.
              </p>
              <p class="connect-pairing-server" data-testid="pairing-server">
                {p().serverUrl}
              </p>
            </>
          )}
        </Show>
        <Show when={!prefill}>
          <Show
            when={showServerField}
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
          <pre class="connect-cmd">nooklet token create --label phone --scope write --sync</pre>
          <p class="connect-note">The token is shown once. Paste it here.</p>
          <p class="connect-note">
            Easier: open a pairing QR code or link from Settings → Devices → Add a device on the
            server's own machine, or from <code>nooklet pair</code>.
          </p>
        </Show>

        <form onSubmit={(e) => void connect(e)}>
          {/* B-699: not for a pairing link. Its address is already shown, read-only, above
              (`pairing-server`) — the one thing to check before tapping Connect — and an editable
              copy under it showed the same address twice and invited editing a link's target.
              `serverUrl()` still holds the link's address for `connect`. */}
          <Show when={showServerField && !prefill}>
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
          <Show
            when={pairingCode}
            fallback={
              <label class="connect-field">
                <span>Device token</span>
                <input
                  type="text"
                  autocomplete="off"
                  autocapitalize="none"
                  autocorrect="off"
                  spellcheck={false}
                  placeholder="nk_…"
                  value={token()}
                  onInput={(e) => setToken(e.currentTarget.value)}
                />
              </label>
            }
          >
            <label class="connect-field">
              <span>Name this device</span>
              <input
                type="text"
                autocomplete="off"
                maxLength={80}
                value={deviceName()}
                onInput={(e) => setDeviceName(e.currentTarget.value)}
              />
            </label>
            <p class="connect-note">
              Shown in Settings → Devices on your other devices, where it can be revoked.
            </p>
          </Show>
          <Show when={error()}>
            <p class="connect-error" role="alert">
              {error()}
            </p>
          </Show>
          <div class="connect-actions">
            <button
              type="submit"
              disabled={
                busy() ||
                (pairingCode ? deviceName().trim() === "" : token().trim() === "") ||
                (showServerField && serverUrl().trim() === "")
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

/** Whether two addresses name the same graph: bare origin and `/g/default` alike, trailing slashes
 * and case of the host ignored. */
function sameGraphAddress(a: string, b: string): boolean {
  const norm = (u: string): string => {
    try {
      const url = new URL(graphBaseUrl(u.trim().replace(/\/+$/, "")));
      return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    } catch {
      return u;
    }
  };
  return norm(a) === norm(b);
}
