/**
 * The fixed app shell (research/08-mobile.md §3.1, ADR 005 "native-feel rules"): a top bar plus
 * exactly one scrollable region (`.page-scroll`, `styles/shell.css`). Routed content
 * (`../routes/*`) renders inside that one scroll container — never add another `overflow: auto`
 * ancestor, or iOS document-scroll breaks the keyboard-inset math (`../platform/keyboard.ts`).
 *
 * This component also starts the keyboard watcher and applies the sync-status indicator; it does
 * NOT know anything about pages/blocks/editing — those are `TODO(views)` seams below.
 */
import { useNavigate } from "@solidjs/router";
import { ChevronLeft, ChevronRight, PanelLeft } from "lucide-solid";
import { type JSX, onCleanup, onMount, Show } from "solid-js";
// ADR 015 §2.6: the persistent live-UI-control consent badge — see ../live/ConsentBadge.tsx.
import { ConsentBadge } from "../live/index.js";
import { platform } from "../platform/index.js";
import { PluginStatusItems } from "../plugins/StatusItems.js";
import { closeDiagnostics, DiagnosticsPanel, diagnosticsOpen } from "../views/DiagnosticsPanel.js";
import { closeSettings, SettingsPanel, settingsOpen } from "../views/SettingsPanel.js";
import { HelpMenu } from "./HelpMenu.js";
import { Shelf } from "./Shelf.js";
import { Sidebar } from "./Sidebar.js";
import { SyncIndicator } from "./SyncIndicator.js";
import "../styles/shell.css";
// Per-device appearance (text size, width, custom CSS) applies itself on load. Import it here,
// where the shell is, rather than leaving that to whoever happens to import SettingsPanel first.
import "../data/appearance.js";

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
          class="app-icon-button"
          aria-label="Toggle sidebar"
          title="Toggle sidebar"
          onClick={() => document.body.classList.toggle("sidebar-open")}
        >
          <PanelLeft size={17} />
        </button>
        <div class="app-history">
          <button
            type="button"
            class="app-icon-button"
            aria-label="Back"
            title="Back"
            onClick={() => navigate(-1)}
          >
            <ChevronLeft size={17} />
          </button>
          <button
            type="button"
            class="app-icon-button"
            aria-label="Forward"
            title="Forward"
            onClick={() => navigate(1)}
          >
            <ChevronRight size={17} />
          </button>
        </div>
        <SyncIndicator />
        <PluginStatusItems />
        <ConsentBadge />
      </div>
      <div class="app-shell-body">
        <Sidebar />
        <div class="page-scroll">
          <div class="page-scroll-inner">{props.children}</div>
        </div>
        {/* Renders nothing at all while empty, so the shelf costs no width until something is on
            it (`./Shelf.tsx`). */}
        <Shelf />
      </div>
      <HelpMenu />
      <Show when={diagnosticsOpen()}>
        <DiagnosticsPanel onClose={closeDiagnostics} />
      </Show>
      {/* Raised by the help menu and by `app.openSettings` (Cmd/Ctrl+,), which used to navigate to
          a route that does not exist — see `../views/SettingsPanel.tsx`. */}
      <Show when={settingsOpen()}>
        <SettingsPanel onClose={closeSettings} />
      </Show>
    </div>
  );
}
