/**
 * Shown when this device holds a replica of a different graph than the server is serving.
 *
 * The local replica lives in OPFS keyed by ORIGIN, so pointing the same address at another data
 * directory leaves the browser reusing the copy it already had. The failure is invisible from
 * inside the app: the sidebar lists pages from the old graph while search and backlinks answer
 * from the new one, and every individual part looks like it is working.
 *
 * Deliberately NOT an automatic wipe. The local replica can hold edits that were never pushed —
 * anything typed while the old server was unreachable — and discarding those silently to fix a
 * configuration mistake would be the worst possible trade. So it explains what happened and asks.
 */

import { createSignal, type JSX, Show } from "solid-js";
import { describeError } from "../data/api-client.js";
import { rememberActiveGraphInstanceId } from "../data/bootstrap.js";
import "./connect.css";

export function GraphMismatchView(props: { graphId: string }): JSX.Element {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function resetLocalCopy(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      // Clear OPFS wholesale rather than picking out SQLite's files: the `opfs-sahpool` VFS spreads
      // one database over a pool of opaquely named files, so there is nothing safe to select.
      const root = await navigator.storage.getDirectory();
      for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
        await root.removeEntry(name, { recursive: true }).catch(() => undefined);
      }
      rememberActiveGraphInstanceId(props.graphId);
      location.reload();
    } catch (err) {
      setBusy(false);
      // Inline, not `alert()`: the desktop app's webview shows nothing for that (B-491).
      setError(`Could not clear the local copy: ${describeError(err)}`);
    }
  }

  return (
    <main class="connect">
      <h1>This device holds a different graph</h1>
      <p class="connect-lede">
        The copy stored in this browser came from a different nooklet graph than the server at{" "}
        <code>{location.host}</code> is serving. Until that is resolved, the page list and search
        will disagree with each other, because they are reading from the two different halves.
      </p>
      <p class="connect-note">
        This usually means the server was pointed at another data directory — a different{" "}
        <code>--data</code>, or the desktop app's default moving.
      </p>

      <div class="connect-actions">
        <button type="button" disabled={busy()} onClick={() => void resetLocalCopy()}>
          {busy() ? "Clearing…" : "Discard the local copy and re-sync"}
        </button>
      </div>
      <Show when={error()}>
        {(text) => (
          <p class="connect-error" role="alert">
            {text()}
          </p>
        )}
      </Show>

      <p class="connect-why">
        This deletes this device's local copy and downloads the server's graph fresh. Anything typed
        on this device that was never synced to a server will be lost. If that might matter, point
        the server back at the old data directory first and let it sync.
      </p>
    </main>
  );
}
