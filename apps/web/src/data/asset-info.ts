/**
 * What the client needs to SHOW an asset a block names (`assets/<id>.<ext>`): its URL key and, for
 * a picture, its pixel size. Both come from the server's `asset.info` (B-737/ADR 036, B-703).
 *
 * **The key.** `GET /assets/:id` needs no token (an `<img>` cannot send one) and serves only with
 * the asset's own secret, `?k=<key>`. The key is not in the block text — that stays
 * `assets/<id>.<ext>`, for the Markdown mirror and Logseq — and not in the client's replica (assets
 * are not synced, ADR 003), so `../editor/render/asset-url.ts` asks here for every asset it builds a
 * URL for.
 *
 * **The size** reserves an image's box before its lazily loaded bytes arrive, so the rows below it
 * do not jump when they do (B-703).
 *
 * Same shape as `./block-ref-cache.ts`: rendering is synchronous, so a lookup answers from what is
 * known and queues a fetch on a miss; the per-id signal re-renders the image once the answer
 * arrives. Lookups made in one tick go out as ONE request, so a page of pictures costs one round
 * trip, and a picture already known costs none.
 *
 * Answers are kept for good: in memory, and in `localStorage` so a reload or a later session has
 * every key it has seen before the first paint — which is what lets a picture already seen show
 * offline, from the service worker's cache (or, on the phone, WKWebView's HTTP cache), under the
 * same URL as before. Storing keys there adds nothing an attacker with this origin's storage does
 * not already have: the device token is in the same place, and it can ask `asset.info` itself.
 * Losing the copy (private window, cleared storage) only means asking again.
 *
 * A key can change (`nooklet asset rotate-key`, when a link was shared). A device that kept the old
 * one sees its picture fail to load; `assetLoadFailed` then asks again, once per asset per session.
 */

import { createSignal, type Signal } from "solid-js";
import { callOp } from "./api-client.js";

export interface AssetSize {
  width: number;
  height: number;
}

export interface AssetInfo {
  key: string;
  size: AssetSize | null;
}

/** v2 holds keys; B-703's sizes-only `v1` is dropped (every entry would lack its key anyway). */
const STORAGE_KEY = "nooklet.assetInfo.v2";
const OLD_STORAGE_KEYS = ["nooklet.assetSizes.v1"];
/** Kept in storage at most; the oldest are dropped first. ~50 bytes each. */
const MAX_STORED = 10_000;
/** The server's per-call cap (`asset.info`). */
const CHUNK = 500;

/** `[key, width, height]`; 0 for "no size" (not a picture, or one the server cannot measure). */
type Stored = [string, number, number];

interface Entry {
  /** `undefined`: not known yet. `null`: the server has no such asset. */
  info: Signal<AssetInfo | null | undefined>;
  /** A request for it is out, or its answer is in: do not ask again. */
  asked: boolean;
  /** Asked again after a failed load (`assetLoadFailed`): never twice. */
  retried: boolean;
}

const entries = new Map<string, Entry>();
const queued = new Set<string>();
let flushQueued = false;
let stored: Record<string, Stored> | undefined;
let retryWhenOnline = false;

function storedInfo(): Record<string, Stored> {
  if (stored) return stored;
  stored = {};
  try {
    for (const old of OLD_STORAGE_KEYS) localStorage.removeItem(old);
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) stored = JSON.parse(raw) as Record<string, Stored>;
  } catch {
    // No storage, or someone else's bytes under the key: start empty.
  }
  return stored;
}

function persist(): void {
  const all = storedInfo();
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_STORED))) delete all[k];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Full or unavailable: the in-memory answers still hold for this session.
  }
}

function fromStored(s: Stored | undefined): AssetInfo | undefined {
  if (!s || typeof s[0] !== "string" || s[0] === "") return undefined;
  return { key: s[0], size: s[1] > 0 && s[2] > 0 ? { width: s[1], height: s[2] } : null };
}

function entryFor(id: string): Entry {
  let entry = entries.get(id);
  if (!entry) {
    const known = fromStored(storedInfo()[id]);
    entry = {
      info: createSignal<AssetInfo | null | undefined>(known),
      asked: known !== undefined,
      retried: false,
    };
    entries.set(id, entry);
  }
  return entry;
}

function ask(id: string): void {
  queued.add(id);
  if (!flushQueued) {
    flushQueued = true;
    queueMicrotask(flush);
  }
}

function flush(): void {
  flushQueued = false;
  const ids = [...queued];
  queued.clear();
  for (let i = 0; i < ids.length; i += CHUNK) void fetchChunk(ids.slice(i, i + CHUNK));
}

interface Answer {
  assets: Array<{ id: string; key: string; width: number | null; height: number | null }>;
}

async function fetchChunk(ids: string[]): Promise<void> {
  let answer: Answer;
  try {
    answer = await callOp<Answer>("asset.info", { ids });
  } catch {
    // Offline, or no server reachable. A picture with no key cannot be fetched at all, so these
    // are asked again — by the next lookup of them (the page shown again), or when the browser
    // says it is back online — rather than never, and not in a loop now.
    for (const id of ids) {
      const entry = entries.get(id);
      if (entry && entry.info[0]() === undefined) entry.asked = false;
    }
    if (!retryWhenOnline && typeof window !== "undefined") {
      retryWhenOnline = true;
      window.addEventListener(
        "online",
        () => {
          retryWhenOnline = false;
          for (const [id, entry] of entries) {
            if (!entry.asked && entry.info[0]() === undefined) {
              entry.asked = true;
              ask(id);
            }
          }
        },
        { once: true },
      );
    }
    return;
  }
  const found = new Map(answer.assets.map((a) => [a.id, a]));
  const all = storedInfo();
  for (const id of ids) {
    const a = found.get(id);
    const entry = entries.get(id);
    if (!a?.key) {
      entry?.info[1](null);
      delete all[id]; // deleted since this device kept it
      continue;
    }
    const size = a.width && a.height ? { width: a.width, height: a.height } : null;
    const prev = entry?.info[0]();
    // Unchanged: leave the signal alone, so nothing re-renders (a retry that found the same key).
    if (
      !prev ||
      prev.key !== a.key ||
      prev.size?.width !== size?.width ||
      prev.size?.height !== size?.height
    ) {
      entry?.info[1]({ key: a.key, size });
    }
    all[id] = [a.key, size?.width ?? 0, size?.height ?? 0];
  }
  persist();
}

/** What an asset id can look like (ADR 004 ids are 14 base32 characters; `asset.info` takes up to
 * 64). Anything else — a Logseq link to `assets/My photo.png` that the import could not map — is
 * no asset of this server's, and asking about it in a batch would get the whole batch refused. */
const ASSET_ID_RE = /^[a-z0-9]{1,64}$/;

function lookup(id: string): AssetInfo | null | undefined {
  if (!ASSET_ID_RE.test(id)) return null;
  const entry = entryFor(id);
  if (!entry.asked) {
    entry.asked = true;
    ask(id);
  }
  return entry.info[0]();
}

/**
 * Asset `id`'s URL key: a string when known, `null` when the server has no such asset, `undefined`
 * while not known yet. Inside a tracking scope it subscribes, so the caller re-renders when it
 * arrives.
 */
export function lookupAssetKey(id: string): string | null | undefined {
  const info = lookup(id);
  return info === null ? null : info?.key;
}

/**
 * The displayed pixel size of asset `id`, or `undefined` while unknown (not asked yet, asking, not
 * a picture, the server could not say). Subscribes like `lookupAssetKey`.
 */
export function lookupAssetSize(id: string): AssetSize | undefined {
  return lookup(id)?.size ?? undefined;
}

/** For an action outside rendering (opening a link from the keyboard): the key, asking if need
 * be; `undefined` when no answer came within 10 s (offline). */
export async function resolveAssetKey(id: string): Promise<string | null | undefined> {
  const now = lookupAssetKey(id);
  if (now !== undefined) return now;
  const entry = entryFor(id);
  // Polled rather than subscribed: this runs outside any reactive owner.
  for (const started = Date.now(); Date.now() - started < 10_000; ) {
    await new Promise((r) => setTimeout(r, 50));
    const info = entry.info[0]();
    if (info !== undefined) return info === null ? null : info.key;
  }
  return undefined;
}

/** What `asset.upload` answered: a picture just pasted renders without asking again. */
export function rememberAsset(
  id: string,
  key: string,
  width: number | null,
  height: number | null,
): void {
  const entry = entryFor(id);
  const size = width && height ? { width, height } : null;
  entry.asked = true;
  entry.info[1]({ key, size });
  storedInfo()[id] = [key, size?.width ?? 0, size?.height ?? 0];
  persist();
}

/**
 * A keyed URL of asset `id` failed to load. Most often that is no network and no cached copy, but
 * it may be a key rotated since this device learned it: ask the server again, once per asset per
 * session. The known key stays in use until a different one arrives, so an offline failure costs
 * nothing.
 */
export function assetLoadFailed(id: string): void {
  const entry = entries.get(id);
  if (!entry || entry.retried || !entry.info[0]()) return;
  entry.retried = true;
  entry.asked = true;
  ask(id);
}

/** Tests only: forget everything, in memory and in storage. */
export function resetAssetInfoForTest(): void {
  entries.clear();
  queued.clear();
  stored = undefined;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}
