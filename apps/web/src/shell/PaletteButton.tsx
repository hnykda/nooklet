/**
 * The sidebar's way into the command palette by pointer (B-352).
 *
 * Until this, only Cmd/Ctrl+K opened the palette. A phone has no such key, so every command that
 * lives only in the palette — Open a random page, Collapse all / Expand all, Open this page on
 * shelf, and whatever comes next — could not be reached from one at all. The button runs
 * `palette.open` through the same `exec` the keymap uses, so it behaves exactly like the key.
 *
 * In the sidebar (the drawer, on a phone) rather than the top bar: on a 390px phone the top bar is
 * already full once a plugin's word count and the "Agents can see this window" badge show. One more
 * icon there shrank every icon button to its glyph and pushed the badge to a third line taller than
 * the bar — measured on the owner's graph — and any fix for that was pixel-tuning against text that
 * changes with the badge's state and the device's font. The sidebar has the room, is where a phone
 * user goes to get anywhere, and gives desktop the "Search ⌘K" entry sidebars usually carry.
 */

import { Command } from "lucide-solid";
import { type JSX, Show } from "solid-js";
import { buildContextBase } from "../app/editor-host.js";
import { createStore } from "../app/hosts.js";
import { detectPlatformFromEnvironment, useCommands } from "../commands/index.js";
import "./palette-button.css";

/** The width below which the sidebar is a drawer over the content (`./sidebar.css`). */
const DRAWER_QUERY = "(max-width: 44rem)";

export function PaletteButton(): JSX.Element {
  const { buildContext, bindings } = useCommands();
  const { platform, mobile } = detectPlatformFromEnvironment();
  const store = createStore();
  const shortcut = () => bindings().find((b) => b.command === "palette.open")?.key;

  function open(): void {
    // A drawer left open would sit over whatever the command does next — the page a random jump
    // lands on, the outline Collapse all folds — so it gets out of the way first. A sidebar beside
    // the content (desktop) stays.
    if (window.matchMedia(DRAWER_QUERY).matches) document.body.classList.remove("sidebar-open");
    void buildContext(buildContextBase(store, platform, mobile)).exec("palette.open");
  }

  return (
    <button type="button" class="sidebar-palette-button" onClick={open}>
      <Command size={15} />
      <span class="sidebar-palette-label">Command palette</span>
      <Show when={!mobile && shortcut()}>{(key) => <kbd>{key()}</kbd>}</Show>
    </button>
  );
}
