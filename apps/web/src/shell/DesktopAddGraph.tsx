/**
 * "Add a graph" in the desktop app (proposal 005, ADR 032): one form, two ways.
 *
 * - **Create on this Mac**: a name. The shell makes the graph on its bundled server and opens it.
 * - **Connect to a server**: the address, and a device token or a pairing link (ADR 029), one
 *   button. The shell checks it from Rust — from this page it would be a cross-origin request
 *   that the server's CORS allowlist refuses (B-704) — stores the token in the keychain, adds the
 *   graph and opens it. Whatever goes wrong (unreachable, a refused token, a wrong token shape) is
 *   said here, on this form: the shape is checked on this page before anything is sent (B-706,
 *   `data/token-input.ts`); the rest comes back from the shell (`shellRequest`).
 *
 * This replaced the in-app "Sync with a server" (address only, then a restart, then the server's
 * own set-up screen asking "Just this device / Sync with a server" again and only then a token:
 * B-782), and the launcher's own "Add a server".
 */
import Laptop from "lucide-solid/icons/laptop";
import Server from "lucide-solid/icons/server";
import { createSignal, type JSX, Show } from "solid-js";
import { generateGraphName } from "../data/graph-names.js";
import { defaultDeviceLabel } from "../data/pairing.js";
import { type DesktopShell, shellRequest } from "../platform/desktop-shell.js";
import { readAddress, readCredential } from "./desktop-graphs.js";
import "./desktop-graphs.css";

export function DesktopAddGraph(props: {
  shell: DesktopShell;
  /** Pre-filled: the graph this page is (the first open of a server graph with no token yet). */
  address?: string;
  token?: string;
  /** Only the "Connect to a server" half: a page that needs its own token. */
  connectOnly?: boolean;
  /** Why the form is asking, shown above the server fields. */
  note?: string;
}): JSX.Element {
  const [name, setName] = createSignal(generateGraphName(props.shell.graphs.map((g) => g.label)));
  const [macError, setMacError] = createSignal<string | undefined>();
  const [address, setAddress] = createSignal(props.address ?? "");
  const [credential, setCredential] = createSignal(props.token ?? "");
  const [device, setDevice] = createSignal(defaultDeviceLabel(navigator.userAgent));
  const [serverError, setServerError] = createSignal<string | undefined>();
  const [busy, setBusy] = createSignal<"mac" | "server" | undefined>();

  /** A pairing code needs this Mac's name for the token it becomes (ADR 029). */
  const isCode = (): boolean => readCredential(credential()).kind === "code";

  function onCredentialInput(value: string): void {
    setCredential(value);
    setServerError(undefined);
    // A pasted pairing link names its server: that is the address it is for.
    const read = readCredential(value);
    if (read.kind === "code" && read.address) setAddress(read.address);
  }

  async function create(e: Event): Promise<void> {
    e.preventDefault();
    const label = name().trim();
    if (!label) return;
    setMacError(undefined);
    setBusy("mac");
    const reply = await shellRequest(props.shell, { kind: "new-local-graph", label });
    // Reached only when it failed: when it worked, the shell opened the new graph in its place.
    setBusy(undefined);
    setMacError(reply.error ?? "nooklet could not create that graph.");
  }

  async function connect(e: Event): Promise<void> {
    e.preventDefault();
    setServerError(undefined);
    const read = readCredential(credential());
    if (read.kind === "error") {
      setServerError(read.error);
      return;
    }
    const where = readAddress(read.kind === "code" && read.address ? read.address : address());
    if ("error" in where) {
      setServerError(where.error);
      return;
    }
    if (read.kind === "token") setCredential(read.token); // shows what is sent (B-706)
    setBusy("server");
    const reply = await shellRequest(
      props.shell,
      read.kind === "token"
        ? { kind: "connect-server", address: where.address, token: read.token }
        : {
            kind: "connect-server",
            address: where.address,
            code: read.code,
            device: device().trim() || "Mac",
          },
    );
    setBusy(undefined);
    setServerError(reply.error ?? "nooklet could not connect to that server.");
  }

  return (
    <div class="desktop-add">
      <Show when={!props.connectOnly}>
        <section class="desktop-add-way" aria-labelledby="desktop-add-mac">
          <h3 id="desktop-add-mac">
            <Laptop size={15} aria-hidden="true" /> Create on this Mac
          </h3>
          <p class="desktop-add-hint">Kept in nooklet's folder on this Mac. Works offline.</p>
          <form onSubmit={(e) => void create(e)}>
            <label class="desktop-add-field">
              <span>Name</span>
              <input
                type="text"
                autocomplete="off"
                maxLength={80}
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
              />
            </label>
            <Show when={macError()}>
              <p class="desktop-add-error" role="alert">
                {macError()}
              </p>
            </Show>
            <button type="submit" disabled={busy() !== undefined || !name().trim()}>
              {busy() === "mac" ? "Creating…" : "Create"}
            </button>
          </form>
        </section>
      </Show>

      <section class="desktop-add-way" aria-labelledby="desktop-add-server">
        <h3 id="desktop-add-server">
          <Server size={15} aria-hidden="true" /> Connect to a server
        </h3>
        <Show when={props.note}>
          <p class="desktop-add-hint">{props.note}</p>
        </Show>
        <form onSubmit={(e) => void connect(e)}>
          <label class="desktop-add-field">
            <span>Server address</span>
            <input
              type="text"
              inputmode="url"
              autocomplete="off"
              autocapitalize="none"
              autocorrect="off"
              spellcheck={false}
              placeholder="https://nooklet.example.com/g/work"
              value={address()}
              onInput={(e) => {
                setAddress(e.currentTarget.value);
                setServerError(undefined);
              }}
            />
          </label>
          <label class="desktop-add-field">
            <span>Device token or pairing link</span>
            {/* Plain text, not a password field: a token is pasted, and macOS would offer saved
                passwords for it (`ConnectView.tsx` has the same reasoning). */}
            <input
              type="text"
              autocomplete="off"
              autocapitalize="none"
              autocorrect="off"
              spellcheck={false}
              placeholder="nk_… or a pairing link"
              value={credential()}
              onInput={(e) => onCredentialInput(e.currentTarget.value)}
            />
          </label>
          <Show when={isCode()}>
            <label class="desktop-add-field">
              <span>Name this Mac</span>
              <input
                type="text"
                autocomplete="off"
                maxLength={80}
                value={device()}
                onInput={(e) => setDevice(e.currentTarget.value)}
              />
            </label>
          </Show>
          <p class="desktop-add-hint">
            On the server's machine: <code>nooklet token create --scope write --sync</code> (add{" "}
            <code>--graph &lt;id&gt;</code> for a graph other than its default), or Settings →
            Devices → Add a device for a pairing link.
          </p>
          <Show when={serverError()}>
            <p class="desktop-add-error" role="alert">
              {serverError()}
            </p>
          </Show>
          <button
            type="submit"
            disabled={busy() !== undefined || !address().trim() || !credential().trim()}
          >
            {busy() === "server" ? "Connecting…" : "Connect"}
          </button>
        </form>
      </section>
    </div>
  );
}
