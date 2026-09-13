/**
 * The page title row's own controls (B-220, B-221, B-222): a favourite star and a "…" menu with
 * Copy as markdown, Export as markdown and Print. Every control runs a registered command
 * (`../commands/registrations/page-actions.ts`) through the same `exec` the palette uses, with the
 * page named in `args` — a new surface for the palette's behaviour, never a second
 * implementation, the rule `../app/BlockContextMenu.tsx` follows.
 *
 * The star is always visible, filled when the page is a favourite. It is NOT hidden until hover
 * like the History link: the whole complaint (audit §1.7) was that nothing on a page says it can
 * be favourited, and a phone has no hover to reveal it with.
 *
 * The menu also carries the title row's two hover-revealed controls, History and the empty icon
 * slot (B-225). A phone has no hover, so `page-actions.css` takes both out of the row on a coarse
 * pointer — invisible, they were still tap targets eating a third of the title's width — and this
 * menu is where a touch reaches them. They are here on a desktop too, where the row keeps its
 * hover reveal. Neither is a palette command: History is a link, as it is in the row, and
 * "Add icon" opens the row's own editor (`./page-icon-request.ts`).
 */

import { A } from "@solidjs/router";
import { Copy, Ellipsis, FileDown, History, Printer, SmilePlus, Star } from "lucide-solid";
import { createEffect, createSignal, type JSX, onCleanup, Show } from "solid-js";
import { buildContextBase } from "../app/editor-host.js";
import { createStore } from "../app/hosts.js";
import { pageActionNotice } from "../app/page-actions.js";
import { detectPlatformFromEnvironment, useCommands } from "../commands/index.js";
import { claimPopupKeys } from "../commands/popup-keys.js";
import { pageNameToPath } from "./navigateTarget.js";
import { requestPageIconEdit } from "./page-icon-request.js";
import "./page-actions.css";

export function PageActions(props: {
  pageId: string;
  pageName: string;
  favorite: boolean;
  /** The page's `icon` property, when it has one: the menu offers "Add icon" only without. */
  icon: string | undefined;
}): JSX.Element {
  const { buildContext } = useCommands();
  const { platform, mobile } = detectPlatformFromEnvironment();
  const store = createStore();
  const [menuOpen, setMenuOpen] = createSignal(false);
  let menuEl: HTMLDivElement | undefined;
  let triggerEl: HTMLButtonElement | undefined;

  // Not awaited and not `async`: the command must reach the clipboard in this click's own tick
  // (WebKit's gesture rule, `../app/page-actions.ts`).
  function run(commandId: string): void {
    setMenuOpen(false);
    void buildContext(buildContextBase(store, platform, mobile)).exec(commandId, {
      page: props.pageName,
    });
  }

  // Dismiss the menu on anything that means "done here" — same recipe as the block menu.
  createEffect(() => {
    if (!menuOpen()) return;
    const dismiss = (e: Event): void => {
      const target = e.target as Node;
      if (menuEl?.contains(target) || triggerEl?.contains(target)) return;
      setMenuOpen(false);
    };
    const release = claimPopupKeys((key) => {
      if (key !== "Escape") return false;
      setMenuOpen(false);
      triggerEl?.focus();
      return true;
    });
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setMenuOpen(false);
      triggerEl?.focus();
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      release();
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", onKey, true);
    });
  });

  return (
    <div class="page-actions">
      <Show when={pageActionNotice()} keyed>
        {(n) => (
          <span
            class="page-actions-notice"
            classList={{ "page-actions-notice-error": n.error }}
            role="status"
          >
            {n.text}
          </span>
        )}
      </Show>
      <button
        type="button"
        class="page-actions-button page-favorite-button"
        classList={{ "page-favorite-on": props.favorite }}
        aria-pressed={props.favorite}
        aria-label={props.favorite ? "Remove from favourites" : "Add to favourites"}
        title={props.favorite ? "Remove from favourites" : "Add to favourites"}
        onClick={() => run("app.toggleFavorite")}
      >
        <Star size={17} fill={props.favorite ? "currentColor" : "none"} />
      </button>
      <div class="page-actions-menu-anchor">
        <button
          ref={triggerEl}
          type="button"
          class="page-actions-button"
          aria-label="Page actions"
          title="Page actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen()}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <Ellipsis size={17} />
        </button>
        <Show when={menuOpen()}>
          <div ref={menuEl} class="page-actions-menu" role="menu" aria-label="Page actions">
            <button
              type="button"
              role="menuitem"
              class="page-actions-item"
              ref={(el) => queueMicrotask(() => el.focus())}
              onClick={() => run("app.copyPageMarkdown")}
            >
              <Copy size={15} /> Copy as markdown
            </button>
            <button
              type="button"
              role="menuitem"
              class="page-actions-item"
              onClick={() => run("app.exportPageMarkdown")}
            >
              <FileDown size={15} /> Export as markdown (.md)
            </button>
            <button
              type="button"
              role="menuitem"
              class="page-actions-item"
              onClick={() => run("app.printPage")}
            >
              <Printer size={15} /> Print / Save as PDF
            </button>
            <A
              role="menuitem"
              class="page-actions-item"
              href={`/history/${pageNameToPath(props.pageName)}`}
              onClick={() => setMenuOpen(false)}
            >
              <History size={15} /> Page history
            </A>
            <Show when={!props.icon}>
              <button
                type="button"
                role="menuitem"
                class="page-actions-item"
                onClick={() => {
                  setMenuOpen(false);
                  requestPageIconEdit(props.pageId);
                }}
              >
                <SmilePlus size={15} /> Add icon
              </button>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}
