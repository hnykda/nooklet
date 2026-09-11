/**
 * The fixed app shell (research/08-mobile.md §3.1, ADR 005 "native-feel rules"): a top bar plus
 * exactly one scrollable region (`.page-scroll`, `styles/shell.css`). Routed content
 * (`../routes/*`) renders inside that one scroll container — never add another `overflow: auto`
 * ancestor, or iOS document-scroll breaks the keyboard-inset math (`../platform/keyboard.ts`).
 *
 * This component also starts the keyboard watcher and applies the sync-status indicator; it does
 * NOT know anything about pages/blocks/editing — those are `TODO(views)` seams below.
 */
import { A, useNavigate } from "@solidjs/router";
import { type JSX, onCleanup, onMount, Show } from "solid-js";
import { useSyncStatus } from "../data/store.js";
// ADR 015 §2.6: the persistent live-UI-control consent badge — see ../live/ConsentBadge.tsx.
import { ConsentBadge } from "../live/index.js";
import { platform } from "../platform/index.js";
import {
  closeDiagnostics,
  DiagnosticsPanel,
  diagnosticsOpen,
  openDiagnostics,
} from "../views/DiagnosticsPanel.js";
import { Sidebar } from "./Sidebar.js";
import "../styles/shell.css";

/** The sync state, doubling as the way into Diagnostics — "why does it say that?" is exactly
 * the question this indicator provokes, so the answer lives one click away from it. */
function SyncIndicator() {
  const status = useSyncStatus();
  return (
    <button
      type="button"
      class="app-sync-indicator"
      title="Show diagnostics"
      onClick={() => openDiagnostics()}
    >
      {(() => {
        const s = status();
        if (!s) return "";
        if (s.state === "offline") return "offline";
        if (s.pendingCount > 0) return `syncing (${s.pendingCount})`;
        return "synced";
      })()}
    </button>
  );
}

export function AppShell(props: { children?: JSX.Element }) {
  const navigate = useNavigate();
  onMount(() => {
    const handle = platform.startKeyboardWatcher();
    onCleanup(() => handle.stop());
  });

  return (
    <div class="app-shell">
      <div class="app-topbar">
        <button
          type="button"
          class="app-sidebar-toggle"
          aria-label="Toggle sidebar"
          onClick={() => document.body.classList.toggle("sidebar-open")}
        >
          ☰
        </button>
        <div class="app-history">
          <button type="button" aria-label="Back" title="Back" onClick={() => navigate(-1)}>
            ‹
          </button>
          <button type="button" aria-label="Forward" title="Forward" onClick={() => navigate(1)}>
            ›
          </button>
        </div>
        <nav>
          <A href="/journals" end>
            Journals
          </A>
          {/* TODO(views): page links become real once the page switcher/palette exists. */}
          <A href="/search">Search</A>
        </nav>
        <SyncIndicator />
        <ConsentBadge />
      </div>
      <div class="app-shell-body">
        <Sidebar />
        <div class="page-scroll">
          <div class="page-scroll-inner">{props.children}</div>
        </div>
      </div>
      <Show when={diagnosticsOpen()}>
        <DiagnosticsPanel onClose={closeDiagnostics} />
      </Show>
    </div>
  );
}
