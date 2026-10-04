/**
 * Settings → Devices (B-655): the devices and agents that hold a token for this graph, Revoke for
 * each, and "Add a device", which shows a one-time pairing QR code.
 *
 * Only for an admin session. Whether this session is one is learned by asking: `token.list` needs
 * `admin`, so a 403 (a phone's `write` token) hides the whole section rather than showing a list
 * it may not read. The loopback web-client token — the desktop app, or a browser on the server's
 * own machine — is `admin` (`packages/server/src/http/app.ts#webClientToken`).
 *
 * The QR encodes `<address>/pair#code=…` (`../data/pairing.ts`). The address is the one the PHONE
 * uses, which is often not this page's: the desktop app talks to its server over 127.0.0.1, which
 * means nothing to a phone. So it is a field, prefilled with this page's own address when that is
 * not loopback, and remembered per graph on this device.
 *
 * The QR library (`uqr`, MIT, zero dependencies) is imported only when a code is shown.
 */

import {
  createEffect,
  createResource,
  createSignal,
  For,
  type JSX,
  onCleanup,
  Show,
} from "solid-js";
import { confirmDialog } from "../app/confirm-dialog.js";
import { ApiError, describeError } from "../data/api-client.js";
import { apiBaseUrl, samePathGraphPrefix } from "../data/bootstrap.js";
import { parseServerUrl } from "../data/connect-graph.js";
import {
  createPairingCode,
  type DeviceToken,
  listDevices,
  type PairingCode,
  pairingPageUrl,
  revokeDevice,
} from "../data/pairing.js";

const LOOPBACK = /^(localhost|127(\.\d+){3}|\[::1\])$/;

/** The address a phone would use, as far as this page can tell. Empty when only the owner knows. */
function guessedAddress(): string {
  const api = apiBaseUrl();
  if (/^https?:\/\//i.test(api)) {
    return LOOPBACK.test(new URL(api).hostname) ? "" : api.replace(/\/+$/, "");
  }
  if (LOOPBACK.test(location.hostname)) return "";
  return `${location.origin}${samePathGraphPrefix() ?? ""}`;
}

function storageKey(): string {
  return `nooklet.pairing-address:${apiBaseUrl() || samePathGraphPrefix() || "/"}`;
}

function rememberedAddress(): string | undefined {
  try {
    return localStorage.getItem(storageKey()) ?? undefined;
  } catch {
    return undefined;
  }
}

function rememberAddress(value: string): void {
  try {
    localStorage.setItem(storageKey(), value);
  } catch {
    // A convenience only.
  }
}

/** The graph address for the QR: what was typed, with `/g/<id>` added when it is a bare origin. */
function graphAddressFrom(typed: string): string | { error: string } {
  const parsed = parseServerUrl(typed);
  if ("error" in parsed) return parsed;
  const url = new URL(parsed.url);
  if (url.pathname === "/" || url.pathname === "") {
    return `${url.origin}${samePathGraphPrefix() ?? graphPathOf(apiBaseUrl()) ?? "/g/default"}`;
  }
  return parsed.url;
}

function graphPathOf(base: string): string | undefined {
  return /\/g\/[a-z0-9-]+$/.exec(base.replace(/\/+$/, ""))?.[0];
}

function when(ms: number | null): string {
  if (ms === null) return "never";
  const d = new Date(ms);
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function scopeText(t: DeviceToken): string {
  return `${t.scope}${t.sync ? " + sync" : ""}${t.ui_control ? " + ui control" : ""}`;
}

export function DevicesSection(): JSX.Element {
  const [devices, { refetch }] = createResource(async () => {
    try {
      return { ok: true as const, list: await listDevices() };
    } catch (err) {
      // Not an admin session (or no server): this section is not for it.
      if (err instanceof ApiError && (err.code === "forbidden" || err.code === "no_sync_target"))
        return { ok: false as const, hidden: true };
      return { ok: false as const, hidden: false, error: describeError(err) };
    }
  });
  const [error, setError] = createSignal<string | null>(null);
  const [adding, setAdding] = createSignal(false);

  const state = () => (devices.error !== undefined ? undefined : devices());

  async function revoke(t: DeviceToken): Promise<void> {
    const ok = await confirmDialog({
      title: `Revoke "${t.label}"?`,
      message: [
        "It loses access to this graph at once: its next sync is refused and its open connection is closed.",
        "Its notes stay on it, and edits it has not synced yet are kept there until it is paired again.",
      ],
      confirmLabel: "Revoke",
      destructive: true,
    });
    if (!ok) return;
    setError(null);
    try {
      await revokeDevice(t.id);
    } catch (err) {
      setError(`Could not revoke "${t.label}": ${describeError(err)}`);
    }
    await refetch();
  }

  return (
    <Show when={state() && !(state()?.ok === false && state()?.hidden)}>
      <section id="set-devices" aria-label="Devices">
        <h3>Devices</h3>
        <Show when={state()?.ok === false && !state()?.hidden}>
          <p class="set-error" role="alert">
            Could not list devices: {(state() as { error?: string }).error}
          </p>
        </Show>
        <For each={state()?.ok ? (state() as { list: DeviceToken[] }).list : []}>
          {(t) => (
            <div class="set-row set-device" data-testid="device-row">
              <span class="set-label">
                {t.label}
                <Show when={t.current}>
                  <span class="set-muted"> · this session</span>
                </Show>
              </span>
              <span class="set-value">
                <span class="set-device-meta">
                  {scopeText(t)} · added {when(t.created_at)} · last used {when(t.last_used_at)}
                </span>
                <Show when={!t.current}>
                  <button
                    type="button"
                    class="set-button set-device-revoke"
                    onClick={() => void revoke(t)}
                  >
                    Revoke
                  </button>
                </Show>
              </span>
            </div>
          )}
        </For>
        <Show when={error()}>
          {(m) => (
            <p class="set-error" role="alert">
              {m()}
            </p>
          )}
        </Show>
        <Show
          when={adding()}
          fallback={
            <button
              type="button"
              class="set-button set-button-primary"
              onClick={() => setAdding(true)}
            >
              Add a device
            </button>
          }
        >
          <AddDevice
            onDone={() => {
              setAdding(false);
              void refetch();
            }}
            onPoll={() => void refetch()}
            known={() => (state()?.ok ? (state() as { list: DeviceToken[] }).list : [])}
          />
        </Show>
        <p class="set-note">
          Each device and agent has its own token. Revoking one never affects the others. From a
          terminal: <code>nooklet pair</code>, <code>nooklet token list</code>,{" "}
          <code>nooklet token revoke &lt;id&gt;</code>.
        </p>
      </section>
    </Show>
  );
}

function AddDevice(props: {
  onDone: () => void;
  onPoll: () => void;
  known: () => DeviceToken[];
}): JSX.Element {
  const [address, setAddress] = createSignal(rememberedAddress() ?? guessedAddress());
  const [code, setCode] = createSignal<PairingCode | null>(null);
  const [qr, setQr] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [now, setNow] = createSignal(Date.now());
  const [paired, setPaired] = createSignal<string | null>(null);
  const startIds = new Set(props.known().map((t) => t.id));

  const tick = setInterval(() => setNow(Date.now()), 1000);
  // While the QR is up, look for the new device every few seconds, so the owner sees it arrive.
  const poll = setInterval(() => {
    if (code() && !paired()) props.onPoll();
  }, 3000);
  onCleanup(() => {
    clearInterval(tick);
    clearInterval(poll);
  });

  createEffect(() => {
    const fresh = props.known().find((t) => !startIds.has(t.id));
    if (fresh && code()) {
      setPaired(fresh.label);
      setCode(null);
      setQr(null);
    }
  });

  const pageUrl = (): string | null => {
    const c = code();
    if (!c) return null;
    const addr = graphAddressFrom(address());
    return typeof addr === "string" ? pairingPageUrl(addr, c.code) : null;
  };

  async function generate(): Promise<void> {
    setError(null);
    setPaired(null);
    const addr = graphAddressFrom(address());
    if (typeof addr !== "string") {
      setError(addr.error);
      return;
    }
    rememberAddress(address().trim());
    try {
      const created = await createPairingCode();
      // Lazy: the QR encoder is only needed here.
      const { renderSVG } = await import("uqr");
      const url = pairingPageUrl(addr, created.code);
      setQr(
        `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderSVG(url, { border: 2 }))}`,
      );
      setCode(created);
    } catch (err) {
      setError(`Could not create a pairing code: ${describeError(err)}`);
    }
  }

  const secondsLeft = (): number => {
    const c = code();
    return c ? Math.max(0, Math.round((c.expires_at - now()) / 1000)) : 0;
  };
  const countdown = (): string => {
    const s = secondsLeft();
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  return (
    <div class="set-pairing" data-testid="pairing-panel">
      <label class="set-field">
        <span>Address your phone uses to reach this server</span>
        <input
          type="text"
          inputmode="url"
          autocomplete="off"
          spellcheck={false}
          placeholder="https://nooklet.example.ts.net"
          value={address()}
          onInput={(e) => setAddress(e.currentTarget.value)}
        />
      </label>
      <Show when={address().trim() === ""}>
        <p class="set-note">
          This page reaches the server on this computer only (127.0.0.1). Enter the address the
          phone uses: a tailnet or LAN name the server listens on.
        </p>
      </Show>
      <Show when={paired()}>
        {(label) => (
          <p class="set-ok" role="status" data-testid="pairing-done">
            Paired: {label()}.
          </p>
        )}
      </Show>
      <Show when={code() && qr()}>
        <div class="set-qr">
          <Show
            when={secondsLeft() > 0}
            fallback={<p class="set-muted">This code has expired. Make a new one.</p>}
          >
            <img class="set-qr-image" src={qr() as string} alt="Pairing QR code" />
            <p class="set-note">
              Scan with the phone's camera, then tap "Open in the nooklet app". Single use; expires
              in <span data-testid="pairing-countdown">{countdown()}</span>.
            </p>
            <code class="set-qr-url" data-testid="pairing-url">
              {pageUrl()}
            </code>
          </Show>
        </div>
      </Show>
      <Show when={error()}>
        {(m) => (
          <p class="set-error" role="alert">
            {m()}
          </p>
        )}
      </Show>
      <div class="set-actions">
        <button
          type="button"
          class="set-button set-button-primary"
          disabled={address().trim() === ""}
          onClick={() => void generate()}
        >
          {code() ? "New code" : "Show pairing code"}
        </button>
        <button type="button" class="set-button" onClick={props.onDone}>
          Done
        </button>
      </div>
    </div>
  );
}
