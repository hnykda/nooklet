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
 */

// One file per icon, not the `lucide-solid` barrel (B-140).
import Cloud from "lucide-solid/icons/cloud";
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { useSyncStatus } from "../data/store.js";
import { storageInfo } from "../db/client.js";
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
  const view = createMemo(() => deriveSyncView(storageInfo()?.storage, status()));
  const [shown, setShown] = createSignal<SyncView>("starting");
  const quiet = createQuietView(setShown);
  createEffect(() => quiet.update(view()));
  onCleanup(() => quiet.dispose());
  // The label is the TRUE state, not the delayed one: it is only seen on hover or read by a screen
  // reader, neither of which blinks, and it is what an e2e test waits on for "nothing left to push".
  const label = () => syncLabel(view(), status()?.pendingCount ?? 0);

  return (
    <button
      type="button"
      class="app-icon-button app-sync-indicator"
      data-state={shown()}
      aria-label={label()}
      title={label()}
      onClick={() => openDiagnostics()}
    >
      <Cloud size={17} />
      {/* Always rendered, coloured by `data-state`: the button never changes size or content. */}
      <span class="app-sync-dot" aria-hidden="true" />
    </button>
  );
}
