/**
 * B-704 (owner report 2026-10-04): in the desktop app, the set-up screen's way out to ANOTHER server.
 *
 * When the window shows a server's page that this device has no token for (a remote server the
 * shell was pointed at), the app renders `ConnectView` instead of the shell, so the graph menu is
 * out of reach. ConnectView's "Sync with a server" outside Capacitor only takes a token for the
 * page's own origin (`showServerField` is Capacitor-only), so from that window there was no way to
 * add or open a different server, nor to get back to This Mac, short of the native menu's Switch
 * Server…. This adds both, as the same shell requests the graph menu uses (`add-server-graph`,
 * `open-local-graph`, ADR 028 and its B-704 amendment): the shell injects its flag and intercepts
 * the navigation in every document the window loads, whatever its origin (`main.rs#shell_script`,
 * `on_navigation`), so this works on a remote server's page as on the bundled one.
 *
 * Renders nothing outside the desktop shell.
 */
import Laptop from "lucide-solid/icons/laptop";
import Server from "lucide-solid/icons/server";
import { createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { graphBaseUrl, parseServerUrl } from "../data/connect-graph.js";
import {
  DESKTOP_ERROR_EVENT,
  desktopShell,
  onBundledServer,
  shellRequestUrl,
} from "../platform/desktop-shell.js";

export function DesktopServerSwitch(): JSX.Element {
  const shell = desktopShell();
  const [address, setAddress] = createSignal("");
  const [error, setError] = createSignal<string | undefined>();
  const [pending, setPending] = createSignal<string | undefined>();

  onMount(() => {
    const onShellError = (e: Event): void => {
      const detail = (e as CustomEvent<unknown>).detail;
      setPending(undefined);
      setError(typeof detail === "string" && detail ? detail : "nooklet could not do that.");
    };
    window.addEventListener(DESKTOP_ERROR_EVENT, onShellError);
    onCleanup(() => window.removeEventListener(DESKTOP_ERROR_EVENT, onShellError));
  });

  function openServer(e: Event): void {
    e.preventDefault();
    const parsed = parseServerUrl(address());
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    const target = graphBaseUrl(parsed.url);
    if (new URL(target).origin === location.origin) {
      setError(`That is this server (${location.host}): paste its token above.`);
      return;
    }
    setError(undefined);
    setPending(
      `Opening ${new URL(target).host}. nooklet restarts, then that server asks for its token…`,
    );
    location.assign(shellRequestUrl({ kind: "add-server-graph", url: target }));
  }

  function backToThisMac(): void {
    setError(undefined);
    setPending("Opening This Mac. nooklet restarts…");
    location.assign(shellRequestUrl({ kind: "open-local-graph", id: "default" }));
  }

  return (
    <Show when={shell}>
      {(s) => (
        <section class="connect-elsewhere" aria-labelledby="connect-elsewhere-title">
          <h2 id="connect-elsewhere-title">Open a different graph instead</h2>
          <form onSubmit={openServer}>
            <label class="connect-field">
              <span>Another server's address</span>
              <input
                type="text"
                inputmode="url"
                autocomplete="off"
                autocapitalize="none"
                autocorrect="off"
                spellcheck={false}
                placeholder="https://nooklet.example.com/g/work"
                value={address()}
                onInput={(e) => setAddress(e.currentTarget.value)}
              />
            </label>
            <div class="connect-actions">
              <button type="submit" disabled={!address().trim() || pending() !== undefined}>
                <Server size={15} aria-hidden="true" /> Open and restart
              </button>
              <Show when={!onBundledServer(s())}>
                <button
                  type="button"
                  class="connect-skip"
                  disabled={pending() !== undefined}
                  onClick={backToThisMac}
                >
                  <Laptop size={15} aria-hidden="true" /> Back to This Mac
                </button>
              </Show>
            </div>
          </form>
          <Show when={pending()}>
            <p class="connect-note" role="status">
              {pending()}
            </p>
          </Show>
          <Show when={error()}>
            <p class="connect-error" role="alert">
              {error()}
            </p>
          </Show>
        </section>
      )}
    </Show>
  );
}
