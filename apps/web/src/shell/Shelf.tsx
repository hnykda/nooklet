/**
 * Right-hand shelf: the stack of blocks and pages you Shift-clicked to keep beside whatever you
 * are actually reading.
 *
 * The point of it is holding context from several places at once — the task you are working from,
 * the page it refers to, the meeting note that started it — without losing your place in the main
 * view. So: newest card on top (the thing you just reached for is the thing you want to see),
 * every card dismissible on its own, and a clear-all for when the working set has turned over.
 *
 * Cards hold a REFERENCE, never a copy (`../app/shelf.ts`): each one reads the live page through
 * the normal reactive seam (`../data/store.ts`), so editing a block in the main view updates its
 * card, and deleting it makes the card say so rather than showing a ghost.
 *
 * A page card has two modes (M7, research/13 §4.2 item 7): its content, as before, or its
 * OUTLINE — the headings and top-level blocks as a table of contents whose entries scroll the main
 * view to the block. Two TOC plugins with ~60k downloads exist because a long page in a 20rem
 * column is a wall; the outline is the map of it.
 *
 * Mirrors `./Sidebar.tsx` in structure and `./sidebar.css` in conventions — including the
 * independent scroll region, which is the one documented exception to research/08 §3.1's
 * single-scroll-container rule that the left sidebar already takes.
 */

import { classifyBlockContent } from "@nooklet/core";
import { useNavigate } from "@solidjs/router";
import {
  FileText,
  ListTree,
  PanelRight,
  PanelRightClose,
  TableOfContents,
  Trash2,
  X,
} from "lucide-solid";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import {
  clearShelf,
  dismissShelfItem,
  type ShelfItem,
  setShelfOpen,
  shelfItems,
  shelfOpen,
} from "../app/shelf.js";
import { lookupBlockText } from "../data/block-ref-cache.js";
import { displayPageName, displayRefName } from "../data/page-title.js";
import { usePageByName, usePageTree } from "../data/store.js";
import type { BlockTreeNode, NavigateTarget } from "../data/types.js";
import { MARKER_GLYPH } from "../editor/BlockRowView.js";
import { BlockContentView } from "../editor/render/tokens.js";
import { goToTarget, pageRoutePath } from "../views/navigateTarget.js";
import "./shelf.css";
import { outlineEntries, type TocEntry } from "./shelfOutline.js";

type Navigate = (t: NavigateTarget) => void;

/** Find `id` anywhere in a page's nested block tree. Depth-first over the whole page because a
 * shelved block is just as likely to be three levels down as at the root. */
function findNode(nodes: readonly BlockTreeNode[], id: string): BlockTreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const hit = findNode(node.children, id);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * A block and, indented beneath it, its children — rendered through the same contract the outliner
 * uses (`../editor/render/tokens.tsx`), so a card looks like the page it came from rather than a
 * second, subtly different rendering of the same text.
 *
 * Children are included because a bullet's meaning usually lives in what hangs off it; a card
 * showing only the parent line is a breadcrumb, not context. A collapsed block stays collapsed —
 * that collapse was a deliberate statement that the detail is not wanted.
 */
function ShelfOutline(props: {
  nodes: readonly BlockTreeNode[];
  onNavigate: Navigate;
}): JSX.Element {
  return (
    <ul class="shelf-outline">
      <For each={props.nodes}>
        {(node) => (
          <li class="shelf-outline-item">
            <span class="shelf-bullet" aria-hidden="true" />
            <div class="shelf-outline-body">
              <div class="shelf-block">
                <Show when={node.marker}>
                  {(marker) => (
                    <span class={`shelf-marker vr-marker-${marker()}`} title={marker()}>
                      {MARKER_GLYPH[marker()] ?? "☐"}
                    </span>
                  )}
                </Show>
                <div class="shelf-block-text">
                  <BlockContentView
                    content={classifyBlockContent(node.content)}
                    ctx={{
                      source: node.content,
                      onNavigate: props.onNavigate,
                      // Same miss-triggered cache the outliner reads `((id))` through, so a block
                      // reference on the shelf shows text rather than an opaque id.
                      resolveBlockRef: (id) => {
                        const content = lookupBlockText(id);
                        return content === undefined ? undefined : { content };
                      },
                    }}
                  />
                </div>
              </div>
              <Show when={!node.collapsed && node.children.length > 0}>
                <ShelfOutline nodes={node.children} onNavigate={props.onNavigate} />
              </Show>
            </div>
          </li>
        )}
      </For>
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------
// Page outline (table of contents)
// ---------------------------------------------------------------------------------------------

const REVEAL_CLASS = "shelf-reveal-target";
const REVEAL_MS = 1400;
const POLL_INTERVAL_MS = 100;
const POLL_ATTEMPTS = 15; // ~1.5s, enough for a route change to render

/**
 * Scroll the main view to `blockId` on `pageName`, navigating there first if a different page is
 * showing. Not `nav.revealBlock` (`../app/hosts.ts`), whose flash carries an "Agent" tag by design
 * (ADR 015 §2.6) — this is the human's own click. Same poll-until-mounted loop as
 * `../live/RemoteFlashOverlay.tsx`, since the page's rows may still be mounting after a navigate;
 * gives up quietly if the block never appears, as that one does.
 */
function revealOnPage(navigate: (path: string) => void, pageName: string, blockId: string): void {
  const target = pageRoutePath(pageName);
  if (decodeURIComponent(window.location.pathname) !== decodeURIComponent(target)) {
    navigate(target);
  }
  let attempts = 0;
  const tryNow = (): void => {
    const el = document.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(blockId)}"]`);
    if (el) {
      el.scrollIntoView({ block: "start", behavior: "smooth" });
      el.classList.add(REVEAL_CLASS);
      setTimeout(() => el.classList.remove(REVEAL_CLASS), REVEAL_MS);
      return;
    }
    attempts++;
    if (attempts < POLL_ATTEMPTS) setTimeout(tryNow, POLL_INTERVAL_MS);
  };
  tryNow();
}

function PageToc(props: { entries: TocEntry[]; onReveal: (id: string) => void }): JSX.Element {
  return (
    <ol class="shelf-toc">
      <For each={props.entries}>
        {(entry) => (
          <li
            class="shelf-toc-item"
            classList={{ "shelf-toc-heading": entry.level !== undefined }}
            style={{ "--toc-depth": entry.depth }}
            data-level={entry.level}
          >
            <button type="button" class="shelf-toc-link" onClick={() => props.onReveal(entry.id)}>
              {entry.text}
            </button>
          </li>
        )}
      </For>
    </ol>
  );
}

// ---------------------------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------------------------

function ShelfCardFrame(props: {
  title: string;
  itemKey: string;
  onOpenTitle: () => void;
  /** Extra controls between the crumb and the dismiss button (the page card's mode toggle). */
  tools?: JSX.Element;
  children: JSX.Element;
}): JSX.Element {
  return (
    <article class="shelf-card" data-shelf-key={props.itemKey}>
      <header class="shelf-card-head">
        <button type="button" class="shelf-crumb" onClick={props.onOpenTitle}>
          <FileText size={12} /> {props.title}
        </button>
        {props.tools}
        <button
          type="button"
          class="app-icon-button shelf-dismiss"
          aria-label={`Remove ${props.title} from the shelf`}
          title="Remove from shelf"
          onClick={() => dismissShelfItem(props.itemKey)}
        >
          <X size={14} />
        </button>
      </header>
      <div class="shelf-card-body">{props.children}</div>
    </article>
  );
}

function BlockCard(props: {
  item: Extract<ShelfItem, { kind: "block" }>;
  onNavigate: Navigate;
}): JSX.Element {
  // The page id was recorded when the block was shelved, so this is the whole lookup: one reactive
  // page read that refetches whenever that page's blocks change.
  const tree = usePageTree(() => props.item.pageId);
  const node = createMemo(() => findNode(tree()?.blocks ?? [], props.item.blockId));
  const pageName = createMemo(() => {
    const page = tree()?.page;
    return page ? displayPageName(page) : "";
  });

  return (
    <ShelfCardFrame
      title={pageName() || "…"}
      itemKey={props.item.key}
      onOpenTitle={() => props.onNavigate({ kind: "block", id: props.item.blockId })}
    >
      <Show
        when={node()}
        fallback={
          // Distinguish "still loading" from "gone": a card whose block was deleted elsewhere
          // should say so, not sit on a spinner that never resolves.
          <p class="shelf-empty">{tree() === undefined ? "Loading…" : "This block is gone."}</p>
        }
      >
        {(n) => <ShelfOutline nodes={[n()]} onNavigate={props.onNavigate} />}
      </Show>
    </ShelfCardFrame>
  );
}

function PageCard(props: {
  item: Extract<ShelfItem, { kind: "page" }>;
  onNavigate: Navigate;
  navigate: (path: string) => void;
}): JSX.Element {
  const page = usePageByName(() => props.item.pageName);
  const tree = usePageTree(() => page()?.id);
  // Per card, for as long as it is on the shelf: re-shelving keeps the same item object, so the
  // card (and its mode) survives; dismissing it forgets the mode, which is the right default —
  // the next time this page is shelved is a new question.
  const [mode, setMode] = createSignal<"content" | "outline">("content");
  const entries = createMemo(() => outlineEntries(tree()?.blocks ?? []));
  const storedName = createMemo(() => page()?.name ?? props.item.pageName);

  return (
    <ShelfCardFrame
      title={(() => {
        const p = page();
        return p ? displayPageName(p) : displayRefName(props.item.pageName);
      })()}
      itemKey={props.item.key}
      onOpenTitle={() => props.onNavigate({ kind: "page", name: props.item.pageName })}
      tools={
        <Show when={page() !== null}>
          <button
            type="button"
            class="app-icon-button shelf-mode"
            aria-pressed={mode() === "outline"}
            aria-label={mode() === "outline" ? "Show page content" : "Show page outline"}
            title={mode() === "outline" ? "Content" : "Outline"}
            onClick={() => setMode((m) => (m === "outline" ? "content" : "outline"))}
          >
            <Show when={mode() === "outline"} fallback={<TableOfContents size={14} />}>
              <ListTree size={14} />
            </Show>
          </button>
        </Show>
      }
    >
      <Show
        when={page() !== null}
        fallback={<p class="shelf-empty">This page doesn't exist yet.</p>}
      >
        <Show
          when={(tree()?.blocks.length ?? 0) > 0}
          fallback={<p class="shelf-empty">{tree() === undefined ? "Loading…" : "Empty page."}</p>}
        >
          <Show
            when={mode() === "outline"}
            fallback={<ShelfOutline nodes={tree()?.blocks ?? []} onNavigate={props.onNavigate} />}
          >
            <PageToc
              entries={entries()}
              onReveal={(id) => revealOnPage(props.navigate, storedName(), id)}
            />
          </Show>
        </Show>
      </Show>
    </ShelfCardFrame>
  );
}

export function Shelf(): JSX.Element {
  const navigate = useNavigate();
  const onNavigate: Navigate = (t) => void goToTarget(navigate, t);
  const items = shelfItems;

  return (
    <Show when={items().length > 0}>
      <Show
        when={shelfOpen()}
        fallback={
          // Closed but not empty: a thin rail rather than nothing at all, because a shelf you
          // cannot see is a shelf you forget you filled. Empty is the case that takes no space.
          <div class="shelf-rail">
            <button
              type="button"
              class="app-icon-button shelf-reopen"
              aria-label="Open shelf"
              title={`Open shelf (${items().length})`}
              onClick={() => setShelfOpen(true)}
            >
              <PanelRight size={17} />
              <span class="shelf-count">{items().length}</span>
            </button>
          </div>
        }
      >
        <aside class="app-shelf" aria-label="Shelf">
          <header class="shelf-head">
            <h2>
              <PanelRight size={12} /> Shelf
              <span class="shelf-count">{items().length}</span>
            </h2>
            <button
              type="button"
              class="app-icon-button"
              aria-label="Clear shelf"
              title="Clear shelf"
              onClick={() => clearShelf()}
            >
              <Trash2 size={14} />
            </button>
            <button
              type="button"
              class="app-icon-button"
              aria-label="Close shelf"
              title="Close shelf"
              onClick={() => setShelfOpen(false)}
            >
              <PanelRightClose size={16} />
            </button>
          </header>

          {/* Keyed by `item.key`, which is stable per block/page — re-shelving something already
              here moves its existing card to the top instead of rebuilding it. */}
          <For each={items()}>
            {(item) =>
              item.kind === "block" ? (
                <BlockCard item={item} onNavigate={onNavigate} />
              ) : (
                <PageCard item={item} onNavigate={onNavigate} navigate={navigate} />
              )
            }
          </For>
        </aside>
      </Show>
    </Show>
  );
}
