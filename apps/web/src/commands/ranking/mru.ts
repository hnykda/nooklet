/**
 * R71: MRU tracking. Per-device, unsynced, capped at 20 entries, `{ kind, id, lastUsedAt }`.
 * Deliberately storage-agnostic (`MruStorageAdapter` mirrors the two `Storage` methods this
 * module needs) so tests never touch a real `localStorage`, and the real web build can pass
 * `window.localStorage` directly.
 */
import type { MruEntry } from "../types.js";

const STORAGE_KEY = "nooklet.commands.mru.v1";
const MAX_ENTRIES = 20;

export interface MruStorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isMruEntry(x: unknown): x is MruEntry {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    (o.kind === "command" || o.kind === "page") &&
    typeof o.id === "string" &&
    typeof o.lastUsedAt === "number"
  );
}

function memoryAdapter(): MruStorageAdapter {
  let value: string | null = null;
  return {
    getItem: () => value,
    setItem: (_key, v) => {
      value = v;
    },
  };
}

export interface MruStore {
  /** Most-recent-first. */
  list(): MruEntry[];
  /** Position of `id` within the combined MRU list, or `Infinity` if absent (R73). */
  indexOf(kind: MruEntry["kind"], id: string): number;
  /** Record a successful use, moving `id` to the front (or inserting it) and capping at 20. */
  record(kind: MruEntry["kind"], id: string, now?: number): void;
}

/** Create an MRU store. Pass no adapter to get an in-memory-only store (tests, SSR, or a browser
 * with storage disabled) — reads/writes never throw either way. */
export function createMruStore(storage?: MruStorageAdapter): MruStore {
  const backing = storage ?? memoryAdapter();

  function read(): MruEntry[] {
    try {
      const raw = backing.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isMruEntry);
    } catch {
      return [];
    }
  }

  function write(entries: MruEntry[]): void {
    try {
      backing.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // Best-effort: a full/disabled storage should never break command execution.
    }
  }

  return {
    list() {
      return read();
    },

    indexOf(kind, id) {
      const idx = read().findIndex((e) => e.kind === kind && e.id === id);
      return idx === -1 ? Number.POSITIVE_INFINITY : idx;
    },

    record(kind, id, now = Date.now()) {
      const rest = read().filter((e) => !(e.kind === kind && e.id === id));
      const next = [{ kind, id, lastUsedAt: now }, ...rest].slice(0, MAX_ENTRIES);
      write(next);
    },
  };
}
