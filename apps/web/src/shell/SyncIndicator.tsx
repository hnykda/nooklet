/**
 * The sync state as a muted cloud with a small status dot (B-540, after Logseq's): green when
 * synced, amber only once changes have waited more than ~2 s, red-grey offline or on an error, a
 * hollow ring when this tab keeps no local copy. The words live in the tooltip and the accessible
 * name — it used to be text that changed on every push and pull ("syncing (3)" → "synced"), which
 * made routine sync the most animated thing on screen.
 *
 * Doubles as the way into Diagnostics: "why does it look like that?" is exactly the question the
 * dot provokes, so the answer is one click away from it.
 *
 * The timing rule is `./sync-indicator-state.ts`; this file only wires it to the signals.
 *
 * B-613: a refused token is the one state the reader has to act on, so it alone gets words on
 * screen ("Token rejected") next to the cloud, and both open the re-pair screen rather than
 * Diagnostics.
 */

// One file per icon, not the `lucide-solid` barrel (B-140).
import Cloud from "lucide-solid/icons/cloud";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { activeGraph, hasSyncTarget } from "../data/bootstrap.js";
import { repairTargetFor } from "../data/connect-graph.js";
import { rememberPendingCount } from "../data/pending-memo.js";
import { useSyncStatus } from "../data/store.js";
import { storageInfo } from "../db/client.js";
import { ConnectView } from "../views/ConnectView.js";
import { openDiagnostics } from "../views/DiagnosticsPanel.js";
import {
  createQuietView,
  deriveSyncView,
  type SyncView,
  syncLabel,
} from "./sync-indicator-state.js";
import "./sync-indicator.css";

export function SyncIndicator() {
  const status = useSyncStatus();
  // A plain read, not a signal: whether this device has a sync target cannot change mid-session
  // (same reasoning as `ConnectView.tsx`'s `showServerField`).
  const target = hasSyncTarget();
  const view = createMemo(() => deriveSyncView(storageInfo()?.storage, status(), target));
  const [shown, setShown] = createSignal<SyncView>("starting");
  const quiet = createQuietView(setShown);
  createEffect(() => quiet.update(view()));
  onCleanup(() => quiet.dispose());
  // The label is the TRUE state, not the delayed one: it is only seen on hover or read by a screen
  // reader, neither of which blinks, and it is what an e2e test waits on for "nothing left to push".
  const label = () => syncLabel(view(), status()?.pendingCount ?? 0, status()?.liveNote);
  // B-712: remembered per graph, so removing this graph later (from another graph, when this one
  // is not loaded) can say how many unsynced changes it would lose. Only a status the engine
  // actually reported is recorded — never a guessed zero.
  createEffect(() => {
    const s = status();
    const entry = activeGraph();
    if (s && entry) rememberPendingCount(entry.id, s.pendingCount);
  });
  const [repairing, setRepairing] = createSignal(false);
  const rejected = () => view() === "unauthorized";

  return (
    <>
      <button
        type="button"
        class="app-icon-button app-sync-indicator"
        data-state={shown()}
        aria-label={label()}
        title={label()}
        onClick={() => (rejected() ? setRepairing(true) : openDiagnostics())}
      >
        <Cloud size={17} />
        {/* Always rendered, coloured by `data-state`: the button never changes size or content. */}
        <span class="app-sync-dot" aria-hidden="true" />
      </button>
      <Show when={rejected()}>
        <button
          type="button"
          class="app-sync-repair"
          title="Enter a new token for this graph"
          onClick={() => setRepairing(true)}
        >
          Token rejected
        </button>
      </Show>
      <Show when={repairing()}>
        <Portal>
          <div class="app-sync-repair-overlay">
            <ConnectView
              repair={{
                ...repairTargetFor(activeGraph()?.baseUrl, location.origin),
                onCancel: () => setRepairing(false),
              }}
            />
          </div>
        </Portal>
      </Show>
    </>
  );
}
