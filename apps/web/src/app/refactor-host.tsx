/**
 * The real `RefactorHost` (`../commands/registrations/refactor.ts`): the M7 refactors as the
 * command system sees them. Each write is a server op (ADR 020 §1) called through
 * `../data/refactor-api.ts`, bracketed by `forceSync()` — a push first, so the server sees the
 * text just typed into the block being turned into a page, and a pull after, so the local
 * replica (and every view on it, through the change bus) shows the result at once rather than on
 * the next poke.
 *
 * The page picker is rendered on demand into its own root under `document.body` and resolves a
 * promise, because a command's `run()` is imperative and the picker has no place in the routed
 * tree. It reuses the palette's markup and styles (`.cmd-*`, `../commands/styles.css`) and the
 * page switcher's matching (`../views/pageSearch.ts`), so it looks and ranks like the thing next
 * to it.
 */

import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { render } from "solid-js/web";
import { rememberFocus } from "../commands/focus-return.js";
import { claimPopupKeys } from "../commands/popup-keys.js";
import type { RefactorHost } from "../commands/registrations/refactor.js";
import { describeError } from "../data/api-client.js";
import { appRelativePathname } from "../data/bootstrap.js";
import { refactorApi } from "../data/refactor-api.js";
import { useAllPages } from "../data/store.js";
import { forceSync } from "../db/client.js";
import { flushTyping } from "../editor/outline-registry.js";
import { pageRoutePath, pathToPageName } from "../routes/page-path.js";
import { fuzzyFindPages } from "../views/pageSearch.js";

/** `/page/Projects/Aurora` (optionally `/g/<slug>/page/Projects/Aurora`, ADR 025 — every caller
 * here passes the RAW `window.location.pathname`) -> `Projects/Aurora`; anything else -> `null`. */
export function currentPageNameFromPath(pathname: string): string | null {
  const appRelative = appRelativePathname(pathname);
  if (!appRelative.startsWith("/page/")) return null;
  const rest = appRelative.slice("/page/".length);
  return rest === "" ? null : pathToPageName(rest);
}

interface PickerRow {
  kind: "page" | "create";
  name: string;
  title: string;
}

function PagePicker(props: {
  title: string;
  allowCreate: boolean;
  onDone: (name: string | null) => void;
}) {
  const pages = useAllPages();
  const [query, setQuery] = createSignal("");
  const [highlight, setHighlight] = createSignal(0);

  const rows = createMemo<PickerRow[]>(() => {
    const q = query().trim();
    const list: PickerRow[] = fuzzyFindPages(pages(), query(), 30).map((m) => ({
      kind: "page",
      name: m.page.name,
      title: m.title,
    }));
    const exists = list.some((r) => r.title.toLowerCase() === q.toLowerCase());
    if (props.allowCreate && q !== "" && !exists) {
      list.push({ kind: "create", name: q, title: `Create page "${q}"` });
    }
    return list;
  });

  function choose(row: PickerRow | undefined): void {
    if (row) props.onDone(row.name);
  }

  onMount(() => {
    // Escape must reach us, not the editor's keymap (which would drop the block into selection
    // mode, B-72) — same claim the palette makes. Enter/arrows are handled on the input, which
    // has focus; the claim returns false for them so nothing else swallows them either.
    const release = claimPopupKeys((key) => {
      if (key !== "Escape") return false;
      props.onDone(null);
      return true;
    });
    onCleanup(release);
  });

  function onKeyDown(e: KeyboardEvent): void {
    const list = rows();
    if (e.key === "Escape") {
      e.preventDefault();
      props.onDone(null);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, Math.max(list.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(list[highlight()]);
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop click-to-dismiss, as the palette does; keyboard users dismiss with Escape on the input.
    // biome-ignore lint/a11y/useKeyWithClickEvents: see above.
    <div class="cmd-overlay page-picker-overlay" onClick={() => props.onDone(null)}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: no keyboard action here, it only stops the backdrop's click-to-dismiss for clicks inside. */}
      <div
        class="cmd-palette page-picker"
        role="dialog"
        aria-label={props.title}
        onClick={(e) => e.stopPropagation()}
      >
        <div class="cmd-empty page-picker-title">{props.title}</div>
        <input
          ref={(el) => queueMicrotask(() => el.focus())}
          class="cmd-input"
          value={query()}
          placeholder="Type a page name…"
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            setHighlight(0);
          }}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded="true"
          aria-controls="page-picker-listbox"
          aria-label={props.title}
        />
        <div id="page-picker-listbox" class="cmd-list" role="listbox">
          <For each={rows()}>
            {(row, i) => (
              // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection is on the input (Up/Down/Enter).
              <div
                role="option"
                tabIndex={-1}
                aria-selected={i() === highlight()}
                classList={{ "cmd-row": true, "cmd-row--active": i() === highlight() }}
                onMouseEnter={() => setHighlight(i())}
                onClick={() => choose(row)}
              >
                <span>{row.title}</span>
              </div>
            )}
          </For>
          <Show when={rows().length === 0}>
            <div class="cmd-empty">No matching pages</div>
          </Show>
        </div>
      </div>
    </div>
  );
}

/** Open the picker and resolve with the chosen page name, or `null` on dismiss. */
export function pickPage(opts: { title: string; allowCreate: boolean }): Promise<string | null> {
  return new Promise((resolve) => {
    document.querySelector(".page-picker-overlay")?.remove(); // never two at once
    const root = document.createElement("div");
    // Before the picker's input takes focus: whatever had it (the editor, when "Move to page…" ran
    // on the block being edited) gets it back as the picker closes. Without this, moving a block
    // onto its own page left its row holding the editor with focus on <body> (B-195).
    const giveFocusBack = rememberFocus(() => root);
    document.body.appendChild(root);
    let settled = false;
    let dispose = (): void => {};
    const done = (name: string | null): void => {
      if (settled) return;
      settled = true;
      dispose();
      root.remove();
      giveFocusBack();
      resolve(name);
    };
    dispose = render(
      () => <PagePicker title={opts.title} allowCreate={opts.allowCreate} onDone={done} />,
      root,
    );
  });
}

export function createRefactorHost(deps: {
  navigate: (path: string) => void;
  /** The palette awaits a command before closing (`CommandPalette#selectRow`), so a command that
   * opens the picker would leave the palette standing underneath it. Called as the picker opens. */
  closePalette?: () => void;
}): RefactorHost {
  /** Push what is pending, run the op, pull the result. A failure is shown, not swallowed: a
   * merge that did not happen must not look like one that did. */
  async function write(label: string, fn: () => Promise<void>): Promise<void> {
    try {
      // The last keystrokes are not in the replica until the editor's write debounce ends, and the
      // push below would go without them (B-192).
      flushTyping();
      await forceSync();
      await fn();
      await forceSync();
    } catch (err) {
      console.error(`${label} failed`, err);
      window.alert(`${label} failed: ${describeError(err)}`);
    }
  }
  return {
    turnBlockIntoPage(blockId) {
      return write("Turn into page", async () => {
        await refactorApi.blockToPage(blockId);
      });
    },
    moveBlockToPage(blockId, page) {
      return write("Move to page", async () => {
        await refactorApi.moveBlockToPage(blockId, page);
      });
    },
    mergePageInto(source, target) {
      return write("Merge page", async () => {
        const result = await refactorApi.mergePage(source, target);
        // The source is gone; its URL would now resolve (through the alias) to the target
        // anyway, but say so in the address bar.
        deps.navigate(pageRoutePath(result.target));
      });
    },
    pickPage(opts) {
      deps.closePalette?.();
      return pickPage(opts);
    },
    currentPageName() {
      return currentPageNameFromPath(window.location.pathname);
    },
    openFindReplace() {
      deps.navigate("/replace");
    },
  };
}
