/**
 * Image asset sizes, for reserving an image's box before it loads (B-703).
 *
 * An image renders `loading="lazy"` with no size of its own until its bytes arrive, so it is 0×0
 * until scrolled near — and then everything below it jumps by the picture's height. The server
 * records each image asset's pixel size (`asset.sizes`); this asks for the sizes of the images on
 * screen and hands them to the renderer, which sizes the box from them.
 *
 * Same shape as `./block-ref-cache.ts`: rendering is synchronous, so a lookup answers from what is
 * known and queues a fetch on a miss; the per-id signal re-renders the image once the size arrives.
 * Lookups made in one tick go out as one request.
 *
 * A size never changes — an asset id names fixed bytes (content-addressed, ADR 013) — so answers are
 * kept for good: in memory, and in `localStorage` so a reload or a later session has every size it
 * has seen before the first paint, offline included. That copy is a convenience; losing it (private
 * window, cleared storage) only means asking again.
 */

import { createSignal, type Signal } from "solid-js";
import { callOp } from "./api-client.js";

export interface AssetSize {
  width: number;
  height: number;
}

const STORAGE_KEY = "nooklet.assetSizes.v1";
/** Kept in storage at most; the oldest are dropped first. ~40 bytes each. */
const MAX_STORED = 5000;
/** The server's per-call cap (`asset.sizes`). */
const CHUNK = 500;

interface Entry {
  size: Signal<AssetSize | null | undefined>;
  asked: boolean;
}

const entries = new Map<string, Entry>();
const queued = new Set<string>();
let flushQueued = false;
let stored: Record<string, [number, number]> | undefined;

function storedSizes(): Record<string, [number, number]> {
  if (stored) return stored;
  stored = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) stored = JSON.parse(raw) as Record<string, [number, number]>;
  } catch {
    // No storage, or someone else's bytes under the key: start empty.
  }
  return stored;
}

function persist(): void {
  const all = storedSizes();
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_STORED))) delete all[k];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Full or unavailable: the in-memory answers still hold for this session.
  }
}

function entryFor(id: string): Entry {
  let entry = entries.get(id);
  if (!entry) {
    const known = storedSizes()[id];
    entry = {
      size: createSignal<AssetSize | null | undefined>(
        known ? { width: known[0], height: known[1] } : undefined,
      ),
      asked: known !== undefined,
    };
    entries.set(id, entry);
  }
  return entry;
}

function flush(): void {
  flushQueued = false;
  const ids = [...queued];
  queued.clear();
  for (let i = 0; i < ids.length; i += CHUNK) void fetchChunk(ids.slice(i, i + CHUNK));
}

async function fetchChunk(ids: string[]): Promise<void> {
  let answer: { assets: Array<{ id: string; width: number | null; height: number | null }> };
  try {
    answer = await callOp("asset.sizes", { ids });
  } catch {
    // Offline, no server, or an older server without the op: the image just lays out when it
    // loads, as it always did. Ask again on the next lookup after a reload, not in a loop now.
    return;
  }
  const found = new Map(answer.assets.map((a) => [a.id, a]));
  const all = storedSizes();
  for (const id of ids) {
    const a = found.get(id);
    const size = a && a.width && a.height ? { width: a.width, height: a.height } : null;
    entries.get(id)?.size[1](size);
    if (size) all[id] = [size.width, size.height];
  }
  persist();
}

/**
 * The displayed pixel size of asset `id`, or `undefined` while unknown (not asked yet, asking, the
 * server could not say). Inside a tracking scope it subscribes, so the caller re-renders when the
 * size arrives.
 */
export function lookupAssetSize(id: string): AssetSize | undefined {
  const entry = entryFor(id);
  if (!entry.asked) {
    entry.asked = true;
    queued.add(id);
    if (!flushQueued) {
      flushQueued = true;
      queueMicrotask(flush);
    }
  }
  return entry.size[0]() ?? undefined;
}

/** Tests only: forget everything, in memory and in storage. */
export function resetAssetSizesForTest(): void {
  entries.clear();
  queued.clear();
  stored = undefined;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}
