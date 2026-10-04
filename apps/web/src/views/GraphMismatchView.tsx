/**
 * Shown when this device holds a replica of a different graph than the server at the active
 * entry's address is serving (`data/bootstrap.ts#initBootstrap`'s `graphMismatch`). While it shows,
 * the replica is open with no sync target (B-633), so nothing crosses between the two graphs.
 *
 * Deliberately NOT an automatic wipe. The local replica can hold edits that were never pushed, and
 * discarding those silently would be the worst possible trade. B-714: it used to offer only the
 * discard, and blamed a moved `--data` directory on `location.host` even for a remote server whose
 * graph had been re-imported. Now it names the real address, lists the likely causes, and offers
 * three ways out, each saying what it does to the data:
 *  1. keep this copy as a device-only graph (`keepAsDeviceOnlyCopy`: no data moves; the entry
 *     loses its address), and optionally add the server's graph beside it — recommended when the
 *     copy holds unsynced changes;
 *  2. open another graph without deciding (the screen comes back when this one is opened again);
 *  3. discard this copy and re-sync (B-631: only this graph's replica), never the primary action.
 */

import { createResource, createSignal, For, type JSX, Show } from "solid-js";
import { describeError } from "../data/api-client.js";
import {
  activeGraph,
  type GraphListEntry,
  graphEntryUrl,
  isPlaceholderGraphLabel,
  keepAsDeviceOnlyCopy,
  listGraphs,
  rememberActiveGraphInstanceId,
  resolvedGraphAddress,
  setActiveGraphId,
} from "../data/bootstrap.js";
import { discardActiveReplica } from "../data/discard-replica.js";
import { queryAs } from "../db/client.js";
import "./connect.css";
import "./graph-mismatch.css";

/** host + path, as the switcher shows an address. */
function displayAddress(baseUrl: string | undefined): string {
  const resolved = resolvedGraphAddress(baseUrl);
  if (!resolved) return location.host;
  try {
    const url = new URL(resolved);
    return `${url.host}${url.pathname}`;
  } catch {
    return resolved;
  }
}

function entryName(entry: GraphListEntry): string {
  if (!isPlaceholderGraphLabel(entry.label)) return entry.label;
  return (entry.baseUrl && /\/g\/([a-z0-9-]+)\/?$/.exec(entry.baseUrl)?.[1]) || entry.label;
}

function changes(n: number): string {
  return `${n} ${n === 1 ? "change" : "changes"}`;
}

/** Ops this replica holds that no server has acknowledged. The worker replays any B-247 batch
 * into `pending_op` as it starts, so after `initDb` this is the whole unsynced tail. */
async function unsyncedCount(): Promise<number> {
  const rows = await queryAs<{ n: number }>("SELECT count(*) AS n FROM pending_op");
  return Number(rows[0]?.n ?? 0);
}

export function GraphMismatchView(props: { graphId: string }): JSX.Element {
  const entry = activeGraph();
  const address = displayAddress(entry?.baseUrl);
  const name = entry ? entryName(entry) : "this graph";
  const others = listGraphs().filter((g) => g.id !== entry?.id);

  const [pending] = createResource(unsyncedCount);
  const [busy, setBusy] = createSignal<"keep" | "discard" | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [addServer, setAddServer] = createSignal(true);
  const [picking, setPicking] = createSignal(false);
  const [confirmDiscard, setConfirmDiscard] = createSignal(false);

  /** `undefined` until counted; a failed count reads as "unknown", never as zero. */
  const count = (): number | undefined => (pending.error ? undefined : pending());
  const hasUnsynced = (): boolean => (count() ?? 0) > 0;

  function keepCopy(): void {
    if (!entry) return;
    setBusy("keep");
    setError(null);
    try {
      const { copy, server } = keepAsDeviceOnlyCopy(entry.id, props.graphId, {
        addServerGraph: addServer(),
      });
      location.assign(graphEntryUrl(server ?? copy, location));
    } catch (err) {
      setBusy(null);
      setError(`Could not keep this copy: ${describeError(err)}`);
    }
  }

  function openOther(other: GraphListEntry): void {
    setActiveGraphId(other.id);
    location.assign(graphEntryUrl(other, location));
  }

  async function discard(): Promise<void> {
    if (hasUnsynced() && !confirmDiscard()) {
      setConfirmDiscard(true);
      return;
    }
    setBusy("discard");
    setError(null);
    try {
      // This graph's replica only (B-631). Clearing OPFS wholesale, as this once did, deleted every
      // graph's replica on the device — the pool is shared — local-only notes included.
      await discardActiveReplica();
      rememberActiveGraphInstanceId(props.graphId);
      location.reload();
    } catch (err) {
      setBusy(null);
      // Inline, not `alert()`: the desktop app's webview shows nothing for that (B-491).
      setError(`Could not clear the local copy: ${describeError(err)}`);
    }
  }

  const copyName = (): string => `“${name} (old copy)”`;

  return (
    // Its own scroller: `body` is `overflow: hidden` for the app shell, and this screen is taller
    // than a phone, so without one the discard choice was cut off and unreachable.
    <div class="graph-mismatch-scroll">
      <main class="connect graph-mismatch">
        <h1>The server has a different graph now</h1>
        <p class="connect-lede">
          This device's copy of <strong>{name}</strong> came from another graph than the one{" "}
          <code>{address}</code> serves today. The two can't be combined, so this copy stays off the
          server until you choose what to do with it.
        </p>

        <div class="graph-mismatch-state" aria-live="polite">
          <Show
            when={!pending.loading}
            fallback={<span class="graph-mismatch-count">Counting unsynced changes…</span>}
          >
            <Show
              when={count() !== undefined}
              fallback={
                <span class="graph-mismatch-count">
                  Could not count this copy's unsynced changes. Assume it has some.
                </span>
              }
            >
              <Show
                when={hasUnsynced()}
                fallback={
                  <span class="graph-mismatch-count">
                    This copy has no unsynced changes: everything in it reached the old graph.
                  </span>
                }
              >
                <span class="graph-mismatch-count has-unsynced" data-testid="mismatch-unsynced">
                  This copy has {changes(count() ?? 0)} that never reached a server.
                </span>
              </Show>
            </Show>
          </Show>
        </div>

        <details class="graph-mismatch-causes" open>
          <summary>Why this happens</summary>
          <ul>
            <li>The graph was re-imported or replaced on the server, under the same address.</li>
            <li>
              The server is reading a different data folder (another <code>--data</code>, or the
              desktop app's default moved).
            </li>
            <li>A backup of a different graph was restored at this address.</li>
          </ul>
        </details>

        <section class="graph-mismatch-options" aria-label="What to do with this copy">
          <div class="graph-mismatch-option is-primary" classList={{ recommended: hasUnsynced() }}>
            <div class="graph-mismatch-option-head">
              <h2>Keep this copy as a device-only graph</h2>
              <Show when={hasUnsynced()}>
                <span class="graph-mismatch-badge">Recommended</span>
              </Show>
            </div>
            <p>
              This copy stays on this device as {copyName()}, with all its notes
              <Show when={hasUnsynced()}> and its {changes(count() ?? 0)}</Show>. It never syncs
              with any server again. Nothing is copied or deleted.
            </p>
            <label class="graph-mismatch-check">
              <input
                type="checkbox"
                checked={addServer()}
                onChange={(e) => setAddServer(e.currentTarget.checked)}
              />
              <span>
                Also add the server's graph as a separate graph and open it. It downloads fresh from{" "}
                <code>{address}</code>.
              </span>
            </label>
            <div class="connect-actions">
              <button type="button" disabled={busy() !== null || !entry} onClick={keepCopy}>
                {busy() === "keep" ? "Keeping…" : "Keep as a device-only graph"}
              </button>
            </div>
          </div>

          <div class="graph-mismatch-option">
            <h2>Open another graph</h2>
            <p>
              Nothing changes. This copy stays as it is, and this screen comes back the next time
              you open it.
            </p>
            <Show
              when={others.length > 0}
              fallback={<p class="graph-mismatch-none">There is no other graph on this device.</p>}
            >
              <Show
                when={picking()}
                fallback={
                  <div class="connect-actions">
                    <button
                      type="button"
                      class="connect-skip"
                      disabled={busy() !== null}
                      onClick={() => setPicking(true)}
                    >
                      Choose a graph
                    </button>
                  </div>
                }
              >
                <ul class="graph-mismatch-graphs" aria-label="Other graphs on this device">
                  <For each={others}>
                    {(other) => (
                      <li>
                        <button
                          type="button"
                          disabled={busy() !== null}
                          onClick={() => openOther(other)}
                        >
                          <span class="graph-mismatch-graph-name">{entryName(other)}</span>
                          <span class="graph-mismatch-graph-where">
                            {other.baseUrl ? displayAddress(other.baseUrl) : "This device only"}
                          </span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </Show>
          </div>

          <div class="graph-mismatch-option is-destructive">
            <h2>Discard this copy and re-sync</h2>
            <p>
              Deletes this device's copy of {name}
              <Show when={hasUnsynced()}>, including its {changes(count() ?? 0)}</Show>, and
              downloads the server's graph fresh in its place. Other graphs on this device are not
              touched.
            </p>
            <Show when={confirmDiscard()}>
              <p class="connect-error" role="alert">
                {changes(count() ?? 0)} on this device will be lost for good. Discard anyway?
              </p>
            </Show>
            <div class="connect-actions">
              <button
                type="button"
                class="connect-skip graph-mismatch-discard"
                disabled={busy() !== null}
                onClick={() => void discard()}
              >
                {busy() === "discard"
                  ? "Clearing…"
                  : confirmDiscard()
                    ? "Discard and lose the changes"
                    : "Discard the local copy and re-sync"}
              </button>
            </div>
          </div>
        </section>

        <Show when={error()}>
          {(text) => (
            <p class="connect-error" role="alert">
              {text()}
            </p>
          )}
        </Show>
      </main>
    </div>
  );
}
