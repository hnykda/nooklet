/**
 * The fixed app shell (research/08-mobile.md §3.1, ADR 005 "native-feel rules"): a top bar plus
 * exactly one scrollable region (`.page-scroll`, `styles/shell.css`). Routed content
 * (`../routes/*`) renders inside that one scroll container — never add another `overflow: auto`
 * ancestor, or iOS document-scroll breaks the keyboard-inset math (`../platform/keyboard.ts`).
 *
 * This component also starts the keyboard watcher and applies the sync-status indicator; it does
 * NOT know anything about pages/blocks/editing — those are `TODO(views)` seams below.
 */
import { A } from "@solidjs/router";
import { type JSX, onCleanup, onMount } from "solid-js";
import { useSyncStatus } from "../data/store.js";
// ADR 015 §2.6: the persistent live-UI-control consent badge — see ../live/ConsentBadge.tsx.
import { ConsentBadge } from "../live/index.js";
import { platform } from "../platform/index.js";
import "../styles/shell.css";

function SyncIndicator() {
  const status = useSyncStatus();
  return (
    <span class="app-sync-indicator">
      {(() => {
        const s = status();
        if (!s) return "";
        if (s.state === "offline") return "offline";
        if (s.pendingCount > 0) return `syncing (${s.pendingCount})`;
        return "synced";
      })()}
    </span>
  );
}

export function AppShell(props: { children?: JSX.Element }) {
  onMount(() => {
    const handle = platform.startKeyboardWatcher();
    onCleanup(() => handle.stop());
  });

  return (
    <div class="app-shell">
      <div class="app-topbar">
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
      <div class="page-scroll">
        <div class="page-scroll-inner">{props.children}</div>
      </div>
    </div>
  );
}
