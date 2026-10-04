/**
 * Drains the native capture queue (ADR 033). The iOS "Add to nooklet" App Intent runs without the
 * web view, so it cannot write to the replica; it leaves one JSON file per capture in the app's
 * own container (`Application Support/captures/<uuid>.json`) and this module turns each into a
 * block on its day's journal through the ordinary quick-capture write, on launch and on every
 * resume.
 *
 * The rules that make it safe to run at any moment, any number of times:
 * - **Order.** Files are written in `created_at` order, oldest first, so two captures on the same
 *   day land in the order they were made. Ties break on the file name.
 * - **Delete after commit.** A file is deleted only after `applyOps` resolved with nothing
 *   rejected. A crash between the write and the delete leaves the file behind, so…
 * - **Idempotent.** …the block id is derived from the capture's uuid and its time
 *   (`captureBlockId`), and before writing the drain asks whether a block with that id already
 *   exists (deleted ones included: a capture the person already deleted must not come back). If
 *   it does, the file is only deleted.
 * - **One at a time.** A drain asked for while another runs waits for it and then runs once more
 *   (`drainCaptureQueue`), so launch and an immediate resume never race each other.
 * - **Partial failure.** A capture whose write throws or is rejected stays queued for the next
 *   drain; the ones after it still run. A file that is not valid capture JSON is never deleted
 *   (it might be a newer format) — it is skipped and reported, and the rest still drain.
 *
 * Every dependency is injected (`CaptureQueueDeps`) so `capture-queue.test.ts` covers all of this
 * with an in-memory queue and a fake write.
 */
import { formatCapture } from "./capture-link.js";

/** One file in the queue, as the native side writes it (`CaptureQueue.swift`). */
export interface QueuedCapture {
  /** The file's uuid (its name without `.json`). */
  id: string;
  text?: string;
  url?: string;
  title?: string;
  /** ISO 8601, e.g. "2026-10-04T08:15:30.123Z". */
  created_at: string;
}

export interface CaptureQueueDeps {
  /** Ids (file names without `.json`) currently queued, in no particular order. */
  list(): Promise<string[]>;
  /** The raw JSON text of one queued capture. */
  read(id: string): Promise<string>;
  remove(id: string): Promise<void>;
  /** True if a block with this id exists, deleted or not. */
  blockExists(blockId: string): Promise<boolean>;
  /** Writes one block to the journal of `at`'s day and resolves how many ops were rejected, or
   * `null` if there was nothing to write (blank text). */
  write(text: string, opts: { at: number; blockId: string }): Promise<{ rejected: number } | null>;
}

export interface DrainReport {
  written: string[];
  /** Already in the graph from an earlier, interrupted drain; only the file was removed. */
  alreadyThere: string[];
  /** Blank captures: nothing to write, file removed. */
  empty: string[];
  /** Write failed or was rejected; left queued. */
  failed: string[];
  /** Not readable as a capture; left in place. */
  malformed: string[];
}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * A valid nooklet id (ADR 004: 9 base32 chars of milliseconds, then 5 of "random") that is the
 * same every time for the same capture: the time part is the capture's own time, the random part
 * the first 25 bits of its uuid. Collides only with another block created in the same millisecond
 * with the same 25 bits.
 */
export function captureBlockId(uuid: string, createdAtMs: number): string {
  const hex = uuid.replace(/-/g, "");
  const rand = Number.parseInt(hex.slice(0, 7), 16) >>> 3; // 28 bits → 25
  const encode = (value: number, chars: number): string => {
    let out = "";
    let v = value;
    for (let i = 0; i < chars; i++) {
      out = ALPHABET[v % 32] + out;
      v = Math.floor(v / 32);
    }
    return out;
  };
  return encode(Math.max(0, Math.floor(createdAtMs)), 9) + encode(rand, 5);
}

/** Parses one file's JSON; `undefined` if it is not a capture this version understands. */
export function parseQueuedCapture(id: string, json: string): QueuedCapture | undefined {
  if (!ID_RE.test(id)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const createdAt = str(o.created_at);
  if (createdAt === undefined || Number.isNaN(Date.parse(createdAt))) return undefined;
  for (const key of ["text", "url", "title"]) {
    if (o[key] !== undefined && o[key] !== null && typeof o[key] !== "string") return undefined;
  }
  const out: QueuedCapture = { id, created_at: createdAt };
  const text = str(o.text);
  const url = str(o.url);
  const title = str(o.title);
  if (text !== undefined) out.text = text;
  if (url !== undefined) out.url = url;
  if (title !== undefined) out.title = title;
  return out;
}

async function drainOnce(deps: CaptureQueueDeps): Promise<DrainReport> {
  const report: DrainReport = {
    written: [],
    alreadyThere: [],
    empty: [],
    failed: [],
    malformed: [],
  };
  const ids = await deps.list();
  const captures: QueuedCapture[] = [];
  for (const id of ids) {
    let parsed: QueuedCapture | undefined;
    try {
      parsed = parseQueuedCapture(id, await deps.read(id));
    } catch {
      parsed = undefined;
    }
    if (parsed) captures.push(parsed);
    else report.malformed.push(id);
  }
  captures.sort(
    (a, b) =>
      Date.parse(a.created_at) - Date.parse(b.created_at) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  for (const c of captures) {
    const at = Date.parse(c.created_at);
    const blockId = captureBlockId(c.id, at);
    try {
      if (await deps.blockExists(blockId)) {
        await deps.remove(c.id);
        report.alreadyThere.push(c.id);
        continue;
      }
      const text = formatCapture(c);
      const result = text.trim() === "" ? null : await deps.write(text, { at, blockId });
      if (result === null) {
        await deps.remove(c.id);
        report.empty.push(c.id);
        continue;
      }
      if (result.rejected > 0) {
        report.failed.push(c.id);
        continue;
      }
      await deps.remove(c.id);
      report.written.push(c.id);
    } catch {
      // Left queued: the next launch or resume tries again, and `blockExists` makes that safe
      // even when the write landed and only the delete failed.
      report.failed.push(c.id);
    }
  }
  return report;
}

let inflight: Promise<DrainReport> | undefined;
let next: Promise<DrainReport> | undefined;

function start(deps: CaptureQueueDeps): Promise<DrainReport> {
  const run = drainOnce(deps).finally(() => {
    inflight = undefined;
  });
  inflight = run;
  return run;
}

/**
 * Drains the queue. Never two at once: a call while a drain runs schedules exactly one more after
 * it (files may have arrived since the running one listed the folder) and every caller in the
 * meantime shares that follow-up's promise.
 */
export function drainCaptureQueue(deps: CaptureQueueDeps): Promise<DrainReport> {
  if (!inflight) return start(deps);
  if (!next) {
    next = inflight
      .catch(() => undefined)
      .then(() => {
        next = undefined;
        return start(deps);
      });
  }
  return next;
}
