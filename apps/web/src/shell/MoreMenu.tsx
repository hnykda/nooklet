/**
 * The "⋯" at the right end of the top bar (B-541 follow-up, the owner's "three dots at top right
 * with dropdown for these", as in Logseq): the places a first-time user looks for and could not
 * find in the desktop app — Settings, All pages, Graph, Trash, Keyboard shortcuts, Diagnostics.
 *
 * Every item is a registered command run through `exec`, never its own handler: the palette (and,
 * for Settings and Keyboard shortcuts, the desktop app's native menu) reach the same places, and a
 * second copy of "what opening Trash means" is a second thing to drift. The menu lists only items
 * whose command is registered and whose `when` holds — so Graph disappears on Capacitor (B-578,
 * `app/CommandLayer.tsx` leaves `nav.graph` out) and Keyboard shortcuts on a touch device (B-564,
 * `app.showShortcuts`'s `when: "!mobile"`) without this file knowing either rule.
 *
 * Popover shape follows `./CalendarButton.tsx`/`live/ConsentBadge.tsx` (an anchored popover, not a
 * modal), anchored right because the button is the bar's last item.
 */

import Ellipsis from "lucide-solid/icons/ellipsis";
import FileText from "lucide-solid/icons/file-text";
import Keyboard from "lucide-solid/icons/keyboard";
import Network from "lucide-solid/icons/network";
import Settings from "lucide-solid/icons/settings";
import Stethoscope from "lucide-solid/icons/stethoscope";
import Trash2 from "lucide-solid/icons/trash-2";
import { createEffect, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { buildContextBase } from "../app/editor-host.js";
import { createStore } from "../app/hosts.js";
import { detectPlatformFromEnvironment, matchesWhen, useCommands } from "../commands/index.js";
import { claimPopupKeys } from "../commands/popup-keys.js";
import "./more-menu.css";

interface Item {
  command: string;
  label: string;
  icon: (props: { size: number }) => JSX.Element;
  /** A divider above this item. */
  sepBefore?: boolean;
}

const ITEMS: Item[] = [
  { command: "app.openSettings", label: "Settings", icon: Settings },
  { command: "nav.allPages", label: "All pages", icon: FileText, sepBefore: true },
  { command: "nav.graph", label: "Graph", icon: Network },
  { command: "nav.trash", label: "Trash", icon: Trash2 },
  { command: "app.showShortcuts", label: "Keyboard shortcuts", icon: Keyboard, sepBefore: true },
  { command: "app.openDiagnostics", label: "Diagnostics", icon: Stethoscope },
];

export function MoreMenu(): JSX.Element {
  const { registry, bindings, buildContext } = useCommands();
  const { platform, mobile } = detectPlatformFromEnvironment();
  const store = createStore();
  const [open, setOpen] = createSignal(false);
  let wrap: HTMLDivElement | undefined;

  const context = () => buildContextBase(store, platform, mobile);
  // Computed when the menu opens, not once: `when` is evaluated against the context of the moment,
  // the same rule the palette follows.
  const visible = (): Item[] => {
    const ctx = context();
    return ITEMS.filter((item) => {
      const command = registry.get(item.command);
      return command !== undefined && matchesWhen(command.when, ctx);
    });
  };
  const keyFor = (command: string): string | undefined =>
    mobile ? undefined : bindings().find((b) => b.command === command)?.key;

  function choose(command: string): void {
    setOpen(false);
    // On a phone the sidebar drawer may be open over the content; whatever the item opens should
    // not land underneath it (same reason as `./PaletteButton.tsx`).
    document.body.classList.remove("sidebar-open");
    void buildContext(context()).exec(command);
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && open()) setOpen(false);
    };
    // Outside click closes. `pointerdown`, so a press that starts on another top-bar control both
    // closes this and works there; a click inside the wrap (button or popover) is left alone.
    const onDown = (e: PointerEvent): void => {
      if (open() && wrap && !wrap.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    onCleanup(() => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    });
  });
  // While open, own Escape in the popup registry too, so an editor that still has focus underneath
  // does not also read it as "leave editing" (B-72; same as `./HelpMenu.tsx`).
  createEffect(() => {
    if (!open()) return;
    const release = claimPopupKeys((key) => {
      if (key !== "Escape") return false;
      setOpen(false);
      return true;
    });
    onCleanup(release);
  });

  return (
    <div class="more-menu-wrap" ref={wrap}>
      <button
        type="button"
        class="app-icon-button"
        aria-label="More"
        title="More"
        aria-haspopup="menu"
        aria-expanded={open()}
        onClick={() => setOpen((v) => !v)}
      >
        <Ellipsis size={17} />
      </button>
      <Show when={open()}>
        <div class="more-menu" role="menu" aria-label="More">
          <For each={visible()}>
            {(item) => (
              <>
                <Show when={item.sepBefore}>
                  <hr class="more-menu-sep" />
                </Show>
                <button
                  type="button"
                  role="menuitem"
                  class="more-menu-item"
                  onClick={() => choose(item.command)}
                >
                  <item.icon size={15} />
                  <span class="more-menu-label">{item.label}</span>
                  <Show when={keyFor(item.command)}>{(key) => <kbd>{key()}</kbd>}</Show>
                </button>
              </>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
