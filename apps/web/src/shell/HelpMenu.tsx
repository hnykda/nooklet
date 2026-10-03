/**
 * The `?` in the bottom-right corner: keyboard shortcuts, docs, and the two things people
 * actually want when something is wrong — file a bug, request a feature. App destinations
 * (Settings, Graph, Trash, Diagnostics…) live in the top bar's "⋯" (`./MoreMenu.tsx`) instead;
 * this stays the place for help, as Logseq keeps both.
 *
 * It is a corner button rather than a menu-bar item because that is where people already look for
 * it, and because the things in it are wanted at the moment of confusion, not planned for.
 *
 * The shortcut list is generated from the live keymap, not hand-written. A hand-written list is
 * wrong the first time a binding changes, and being confidently wrong about a shortcut is worse
 * than not listing it.
 */

import { Bug, CircleQuestionMark, Keyboard, Lightbulb, ScrollText, X } from "lucide-solid";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { useCommands } from "../commands/index.js";
import { detectPlatformFromEnvironment } from "../commands/keymap/platform.js";
import { claimPopupKeys } from "../commands/popup-keys.js";
import "./help-menu.css";

const REPO = "https://github.com/hnykda/nooklet";

/** Injected at build time (`vite.config.ts`) from the workspace version, so a bug report can say
 * which build it came from without anyone having to remember. */
const APP_VERSION: string = __APP_VERSION__;

/** Module-level, like `openSettings`, so the desktop app's Help → Keyboard Shortcuts menu item
 * (`../platform/desktop-shell.ts`) can raise the same dialog the `?` menu does. */
const [showKeys, setShowKeys] = createSignal(false);
export function openShortcuts(): void {
  setShowKeys(true);
}

interface Shortcut {
  keys: string;
  title: string;
  category: string;
}

export function HelpMenu(): JSX.Element {
  const { registry, bindings } = useCommands();
  const [open, setOpen] = createSignal(false);
  // B-564: a touch-primary device has no keyboard to press any of these with — the whole dialog
  // is dead weight there, not just unhelpful. A plain read: the shell this build runs in cannot
  // change mid-session, same reasoning as `ConnectView.tsx`'s `showServerField`.
  const showKeyboardShortcuts = !detectPlatformFromEnvironment().mobile;

  const shortcuts = createMemo<Shortcut[]>(() => {
    const byCommand = new Map<string, string>();
    // First binding wins: a command can carry several (its own default plus a secondary), and a
    // list showing every alias is noise when you are trying to learn one.
    for (const row of bindings()) {
      if (!byCommand.has(row.command)) byCommand.set(row.command, row.key);
    }
    const out: Shortcut[] = [];
    for (const command of registry.list()) {
      const keys = byCommand.get(command.id);
      if (!keys) continue;
      out.push({ keys, title: command.title, category: command.category ?? "Other" });
    }
    return out.sort(
      (a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title),
    );
  });

  const grouped = createMemo(() => {
    const groups = new Map<string, Shortcut[]>();
    for (const s of shortcuts()) {
      const list = groups.get(s.category);
      if (list) list.push(s);
      else groups.set(s.category, [s]);
    }
    return [...groups.entries()];
  });

  const closeTop = (): boolean => {
    if (showKeys()) setShowKeys(false);
    else if (open()) setOpen(false);
    else return false;
    return true;
  };
  onMount(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") closeTop();
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });
  // While either layer is up, own Escape in the popup registry too, so an editor that still has
  // focus underneath does not read the same key as "leave editing" (B-72).
  createEffect(() => {
    if (!open() && !showKeys()) return;
    const release = claimPopupKeys((key) => key === "Escape" && closeTop());
    onCleanup(release);
  });

  return (
    <>
      <button
        type="button"
        class="help-fab"
        aria-label="Help"
        title="Help"
        onClick={() => setOpen((v) => !v)}
      >
        <CircleQuestionMark size={17} />
      </button>

      <Show when={open()}>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: click-away dismiss; Escape is handled above. */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: see above. */}
        <div class="help-backdrop" onClick={() => setOpen(false)}>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: only stops propagation. */}
          <div class="help-menu" role="menu" onClick={(e) => e.stopPropagation()}>
            {/* No Settings here any more: it moved to the top bar's "⋯" menu (`./MoreMenu.tsx`,
                B-541 follow-up), which is where the owner looked for it. One pointer route, not
                two — the panel is also on Cmd/Ctrl+, and in the palette. */}
            <Show when={showKeyboardShortcuts}>
              <button
                type="button"
                class="help-item"
                onClick={() => {
                  setShowKeys(true);
                  setOpen(false);
                }}
              >
                <Keyboard size={15} /> Keyboard shortcuts
              </button>
            </Show>
            <a class="help-item" href={`${REPO}#readme`} target="_blank" rel="noreferrer">
              <ScrollText size={15} /> Documentation
            </a>
            <div class="help-sep" />
            <a
              class="help-item"
              href={`${REPO}/issues/new?template=bug_report.yml`}
              target="_blank"
              rel="noreferrer"
            >
              <Bug size={15} /> Report a bug
            </a>
            <a
              class="help-item"
              href={`${REPO}/issues/new?template=feature_request.yml`}
              target="_blank"
              rel="noreferrer"
            >
              <Lightbulb size={15} /> Request a feature
            </a>
            <div class="help-sep" />
            <a class="help-item help-item-quiet" href={REPO} target="_blank" rel="noreferrer">
              nooklet {APP_VERSION}
            </a>
          </div>
        </div>
      </Show>

      <Show when={showKeys()}>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: click-away dismiss; Escape is handled above. */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: see above. */}
        <div class="help-backdrop" onClick={() => setShowKeys(false)}>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: only stops propagation. */}
          <div
            class="help-keys"
            role="dialog"
            aria-label="Keyboard shortcuts"
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <h2>Keyboard shortcuts</h2>
              <button
                type="button"
                class="help-close"
                aria-label="Close"
                onClick={() => setShowKeys(false)}
              >
                <X size={16} />
              </button>
            </header>
            <div class="help-keys-body">
              <For each={grouped()}>
                {([category, items]) => (
                  <section>
                    <h3>{category}</h3>
                    <ul>
                      <For each={items}>
                        {(s) => (
                          <li>
                            <span class="help-key-title">{s.title}</span>
                            <kbd>{s.keys}</kbd>
                          </li>
                        )}
                      </For>
                    </ul>
                  </section>
                )}
              </For>
            </div>
          </div>
        </div>
      </Show>
    </>
  );
}
