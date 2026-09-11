/**
 * The channel a Shift-clicked bullet or page link uses to ask for a spot on the shelf.
 *
 * Same shape and the same reason as `./context-menu.ts`: the Shift+click happens deep inside a
 * `BlockRowView` (pure presentation, per research/04-editor.md §3.2) or inside the token renderer,
 * while the shelf is rendered by the shell, beside the one scroll container. Neither of those can
 * reach the other, and neither should — a module-level signal is the seam between them.
 *
 * What the shelf stores is REFERENCES — a block id, a page name — never a copy of the text. A card
 * re-reads the live graph every time it renders, so it cannot drift into showing what a block used
 * to say, and the persisted form stays a handful of bytes.
 */

import { normalizePageName } from "@nooklet/core";
import { createSignal } from "solid-js";

/**
 * What a caller asks the shelf to hold.
 *
 * A block target carries its page id as well as its own, which `onNavigate`'s `NavigateTarget`
 * does not. The caller always knows it (a `BlockTree` renders exactly one page) and a block never
 * changes page, so recording it here costs nothing and spares every card a `block -> page` lookup
 * of its own — one that would have to be reactive, since a card restored from storage renders
 * before the replica has finished pulling.
 */
export type ShelfTarget =
  | { kind: "page"; name: string }
  | { kind: "block"; id: string; pageId: string };

export type ShelfItem =
  | { key: string; kind: "block"; blockId: string; pageId: string }
  | { key: string; kind: "page"; pageName: string };

interface ShelfState {
  open: boolean;
  items: ShelfItem[];
}

/**
 * `sessionStorage`, not the database and not `localStorage`.
 *
 * Not the database because a shelf is a fact about this browser, not about the graph: syncing it
 * would push one device's scratch context onto every other device and into the markdown mirror,
 * which is supposed to stay a clean lossless copy of the notes (ADR 003).
 *
 * Not `localStorage` because the shelf is the working set for the thing you are doing right now.
 * Coming back a week later to eight cards whose reason you have forgotten is clutter, not context;
 * and per-tab isolation means a second window builds its own context instead of fighting over one.
 * Surviving a reload — which is what `sessionStorage` buys over a plain signal — is the part that
 * actually matters, since a reload is how most of this app's bugs get worked around.
 */
const STORAGE_KEY = "nooklet.shelf.state";

function storage(): Storage | undefined {
  try {
    // Merely touching `sessionStorage` throws in some privacy modes, so this is a probe rather
    // than a feature check (`../live/consent.ts` does the same).
    return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

function readStored(): ShelfState {
  const empty: ShelfState = { open: false, items: [] };
  const store = storage();
  if (!store) return empty;
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<ShelfState>;
    const items = Array.isArray(parsed.items) ? parsed.items.filter(isShelfItem) : [];
    return { open: parsed.open === true && items.length > 0, items };
  } catch {
    // A shelf that cannot be restored is not worth an error: start empty rather than letting one
    // malformed key take the whole shell down at mount.
    return empty;
  }
}

function isShelfItem(v: unknown): v is ShelfItem {
  if (typeof v !== "object" || v === null) return false;
  const item = v as Partial<ShelfItem> & { kind?: string };
  if (typeof item.key !== "string") return false;
  if (item.kind === "block") {
    const block = item as { blockId?: unknown; pageId?: unknown };
    return typeof block.blockId === "string" && typeof block.pageId === "string";
  }
  if (item.kind === "page") return typeof (item as { pageName?: unknown }).pageName === "string";
  return false;
}

const initial = readStored();
const [items, setItems] = createSignal<ShelfItem[]>(initial.items);
const [open, setOpen] = createSignal(initial.open);

function persist(): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify({ open: open(), items: items() }));
  } catch {
    // Quota or a storage-disabled browser. The in-memory shelf still works; only the reload
    // survival is lost, which is not worth interrupting the user over.
  }
}

/** Identity of a shelf entry. Page keys are normalized the same way page identity is everywhere
 * else (ADR 004), so `[[some page]]` and `[[Some Page]]` are one card, not two. */
function keyFor(target: ShelfTarget): string {
  return target.kind === "block" ? `block:${target.id}` : `page:${normalizePageName(target.name)}`;
}

/**
 * Put `target` on the shelf, newest first.
 *
 * Shift-clicking something already on the shelf moves it back to the top rather than doing
 * nothing: the gesture means "I want this in front of me", and a card that silently stays buried
 * under six others reads as the click not having registered at all.
 */
export function openOnShelf(target: ShelfTarget): void {
  const key = keyFor(target);
  // Reuse the existing object when there is one. `<For>` keys on identity, so handing it the same
  // item back MOVES that card rather than tearing it down and rebuilding it — which would throw
  // away its scroll position and restart its page read for no reason.
  const existing = items().find((i) => i.key === key);
  const item: ShelfItem =
    existing ??
    (target.kind === "block"
      ? { key, kind: "block", blockId: target.id, pageId: target.pageId }
      : { key, kind: "page", pageName: target.name });
  setItems((prev) => [item, ...prev.filter((i) => i.key !== key)]);
  setOpen(true);
  persist();
}

export function dismissShelfItem(key: string): void {
  setItems((prev) => prev.filter((i) => i.key !== key));
  persist();
}

export function clearShelf(): void {
  setItems([]);
  persist();
}

export function setShelfOpen(value: boolean): void {
  setOpen(value);
  persist();
}

export const shelfItems = items;
export const shelfOpen = open;
