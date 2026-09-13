/**
 * Block-reference text, resolved for rendering.
 *
 * `((block-id))` is meant to render as the referenced block's own content — that is the whole
 * point of a block reference, and without it a reference is an opaque id nobody can read. The
 * renderer (`editor/render/tokens.tsx`) has a `resolveBlockRef` seam; `BlockRowView`, the shelf and
 * the query fence plug this into it.
 *
 * The awkward part is that rendering is synchronous while the block lives in the worker. So this
 * is a cache with a miss-triggered fetch: `lookupBlockText` answers immediately from what it has,
 * queues a read when it does not, and stores the answer in a per-id signal — which makes whatever
 * read the miss re-render once the text arrives.
 *
 * Stale-while-revalidate, and why (B-500). The change bus says which TABLES changed, not which
 * blocks (`db/worker-api.ts`'s `ChangeEvent`), so every write to any block has to be treated as
 * possibly changing every referenced block. This used to be done by emptying the cache, which put
 * every `((ref))` on screen back to its `((id))` placeholder until the re-read answered — on every
 * sync pull and every keystroke flush, all day. Now a change only marks the texts stale and
 * re-reads them; what is on screen stays until an answer says otherwise.
 *
 * Three more things the old shape got wrong, each measured on a 150-row page with 50 refs
 * (`tools/probes/refresh-render-count.mjs`):
 *  - one signal held every id's text, so each of the 50 answers re-ran all 50 labels: 2,550
 *    resolver calls per refresh. A signal per id re-runs only the labels showing that block, and
 *    only when its text actually differs (a signal compares with `===`).
 *  - one query per id. Reads queued in the same tick go out as one `IN (…)` query.
 *  - ids ever looked up were all re-read on a change. Only ids some live computation is showing
 *    (`watchers`) are; anything else is re-read when it is next looked up, shown stale meanwhile.
 */

import { batch, createSignal, getListener, onCleanup, type Signal } from "solid-js";
import { queryAs } from "../db/client.js";

interface Entry {
  /** `undefined` until a read finds the block, and again once one does not (deleted, another
   * graph). Whether it was read at all is `readAt`'s business, so a miss that stays a miss does
   * not notify anything. */
  text: Signal<string | undefined>;
  /** The `generation` the shown text was read at; -1 before the first answer. */
  readAt: number;
  /** The `generation` of the latest read sent for it; -1 when none was. */
  askedAt: number;
  /** Tracking computations whose last run looked this id up (a label on screen). */
  watchers: number;
}

/** Bumped by every change that could have altered a block's text. */
let generation = 0;
const entries = new Map<string, Entry>();
const queued = new Set<string>();
let flushQueued = false;

/** Well under SQLite's bound-parameter limit (32,766 since 3.32; the WASM build is newer). */
const READ_CHUNK = 500;
/** Entries nobody is watching are dropped past this many, so a long session does not keep the text
 * of every block it ever showed a reference to. */
const MAX_UNWATCHED = 2000;

function entryFor(id: string): Entry {
  let entry = entries.get(id);
  if (!entry) {
    entry = {
      text: createSignal<string | undefined>(undefined),
      readAt: -1,
      askedAt: -1,
      watchers: 0,
    };
    entries.set(id, entry);
  }
  return entry;
}

function queueRead(id: string, entry: Entry): void {
  if (entry.askedAt === generation) return;
  entry.askedAt = generation;
  queued.add(id);
  if (flushQueued) return;
  flushQueued = true;
  // A microtask, so every label rendered in this tick asks in one query.
  queueMicrotask(flush);
}

function flush(): void {
  flushQueued = false;
  const ids = [...queued];
  queued.clear();
  // Every read here was sent after the change events that bumped `generation` this far had been
  // delivered, and the worker runs messages in order, so its answer is at least that fresh.
  const at = generation;
  for (let i = 0; i < ids.length; i += READ_CHUNK) readChunk(ids.slice(i, i + READ_CHUNK), at);
  pruneUnwatched();
}

function readChunk(ids: string[], at: number): void {
  void queryAs<{ id: string; content: string }>(
    `SELECT id, content FROM block WHERE id IN (${ids.map(() => "?").join(",")}) AND deleted_at IS NULL`,
    ids,
  ).then(
    (rows) => {
      const found = new Map(rows.map((r) => [r.id, r.content]));
      settle(ids, at, (id) => found.get(id));
    },
    // Keep whatever is on screen. Marked as read all the same, or every lookup would ask again.
    () => settle(ids, at, (_id, shown) => shown),
  );
}

function settle(
  ids: string[],
  at: number,
  answer: (id: string, shown: string | undefined) => string | undefined,
): void {
  batch(() => {
    for (const id of ids) {
      const entry = entries.get(id);
      // A read sent after a later change may have answered first; never let an older one win.
      if (!entry || entry.readAt > at) continue;
      entry.readAt = at;
      const [text, setText] = entry.text;
      setText(answer(id, text()));
    }
  });
}

function pruneUnwatched(): void {
  if (entries.size <= MAX_UNWATCHED) return;
  for (const [id, entry] of entries) {
    if (entries.size <= MAX_UNWATCHED) break;
    if (entry.watchers === 0 && !queued.has(id)) entries.delete(id);
  }
}

/**
 * The referenced block's content, or `undefined` while it is still being looked up for the first
 * time or does not exist (the renderer falls back to a muted placeholder). Called inside a
 * tracking scope it subscribes to that one block's text; once resolved, a label keeps its text
 * through every later re-read and changes only when the block's text does.
 */
export function lookupBlockText(id: string): string | undefined {
  const entry = entryFor(id);
  if (getListener()) {
    entry.watchers++;
    onCleanup(() => {
      entry.watchers--;
    });
  }
  const shown = entry.text[0]();
  if (entry.readAt < generation) queueRead(id, entry);
  return shown;
}

/** `lookupBlockText` in the shape `RenderCtx.resolveBlockRef` (`editor/render/tokens.tsx`) takes. */
export function resolveBlockRef(id: string): { content: string } | undefined {
  const content = lookupBlockText(id);
  return content === undefined ? undefined : { content };
}

/**
 * Some block changed (the change bus names tables, not ids): re-read the texts that are on
 * screen, keeping them shown until the answers land. Everything else is only marked stale.
 */
export function invalidateBlockRefs(): void {
  generation++;
  for (const [id, entry] of entries) if (entry.watchers > 0) queueRead(id, entry);
}
