/**
 * Option C (docs/proposals/004-capacitor-storage-durability.md): a periodic snapshot of this
 * replica's SQLite bytes, written to `@capacitor/filesystem`'s native app-sandbox storage — real
 * durability outside OPFS entirely, not just fewer failures the way `reopen-on-resume.ts` (Option
 * B) is. Capacitor-only, and main-thread only: `@capacitor/filesystem`, like every Capacitor
 * plugin, needs `window`, which the dedicated Worker (`db.worker.ts`) does not have — the same
 * reason `platform/capacitor.ts`'s trailing doc comment gives for why native SQLite itself can't
 * live in the worker either. So this lives beside `client.ts`, which already is main-thread code
 * with both the worker RPC (`exportSnapshot`) and `platform.lifecycle` in reach.
 *
 * Lazily imported, matching `platform/capacitor.ts`'s established pattern, so a plain web/PWA
 * build never fetches `@capacitor/filesystem` at all.
 */
let filesystemModule: Promise<typeof import("@capacitor/filesystem")> | undefined;
function filesystem(): Promise<typeof import("@capacitor/filesystem")> {
  if (!filesystemModule) filesystemModule = import("@capacitor/filesystem");
  return filesystemModule;
}

/**
 * One checkpoint per replica (B-611). There used to be one fixed file for the whole device, written
 * by whichever graph was active and restored into ANY graph's empty replica: a new local-only graph
 * would have started as a copy of a server graph, `pending_op` included, or a newly added server
 * graph as a copy of local-only notes, which its first push would then have sent to the server.
 * The un-namespaced replica keeps the old filename, so a pure "Just this device" install keeps its
 * backstop through the upgrade; `migrateUnscopedCheckpoint` deals with every other install.
 */
const UNSCOPED_CHECKPOINT_PATH = "nooklet-checkpoint.sqlite3";
const CHECKPOINT_MIGRATED_KEY = "nooklet.checkpoint-scoped.v1";

/** `scope` is `data/bootstrap.ts#replicaScope`: `~` for the un-namespaced replica. */
export function checkpointPath(scope: string): string {
  return scope === "~"
    ? UNSCOPED_CHECKPOINT_PATH
    : `nooklet-checkpoint-${encodeURIComponent(scope)}.sqlite3`;
}

/**
 * Once per device, before any checkpoint is read or written by this build: the old fixed file is
 * left to the un-namespaced replica (whose path it already is) only when that replica is the one
 * thing that could have written it (`soleOwner === "~"`, from
 * `data/bootstrap.ts#soleLegacyStateOwner`). Otherwise it is renamed out of the way — kept, never
 * restored — because restoring it into the wrong graph's replica is the leak. Never throws; a
 * failure leaves the flag unset so the next start tries again (and until then nothing restores
 * from the old path except the un-namespaced replica, the same as before this change).
 */
export async function migrateUnscopedCheckpoint(soleOwner: string | undefined): Promise<void> {
  try {
    if (localStorage.getItem(CHECKPOINT_MIGRATED_KEY) === "1") return;
  } catch {
    return;
  }
  try {
    if (soleOwner !== "~") {
      const { Filesystem, Directory } = await filesystem();
      const exists = await Filesystem.stat({
        path: UNSCOPED_CHECKPOINT_PATH,
        directory: Directory.Data,
      }).then(
        () => true,
        () => false,
      );
      if (exists) {
        await Filesystem.rename({
          from: UNSCOPED_CHECKPOINT_PATH,
          to: `nooklet-checkpoint.quarantine-${Date.now()}.sqlite3`,
          directory: Directory.Data,
          toDirectory: Directory.Data,
        });
        console.warn(
          "nooklet: the device-wide checkpoint from before graphs were kept apart could not be " +
            "matched to one graph; kept as nooklet-checkpoint.quarantine-*.sqlite3, not restored.",
        );
      }
    }
    localStorage.setItem(CHECKPOINT_MIGRATED_KEY, "1");
  } catch {
    // Try again next start.
  }
}

/** No encoding specified means binary, base64-encoded — the Filesystem plugin's own documented
 * contract for non-text data (`WriteFileOptions.encoding`'s doc: "If you do not provide encoding
 * ... provide data as base64 encoded"). Chunked manually rather than `btoa(String.fromCharCode(
 * ...bytes))` — spreading a large `Uint8Array` as call arguments risks the engine's argument-count
 * limit on a graph-sized database. */
const BASE64_CHUNK = 8192;

/** Exported for `capacitor-checkpoint.test.ts` — pure, so testable without a real Filesystem
 * plugin; everything else in this file needs one. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * A prior checkpoint's bytes, for `client.ts` to pass as `restoreBytes` into the worker's
 * `init()` — or `undefined`, which covers both "no checkpoint yet" (by far the common case, every
 * first run) and any read failure. Never throws: a missing/corrupt checkpoint must never block
 * startup, since the ordinary OPFS path (which this is only ever a backstop for) is what actually
 * decides whether the replica has real data.
 */
export async function readCheckpoint(scope: string): Promise<Uint8Array | undefined> {
  try {
    const { Filesystem, Directory } = await filesystem();
    const result = await Filesystem.readFile({
      path: checkpointPath(scope),
      directory: Directory.Data,
    });
    if (typeof result.data === "string") return base64ToBytes(result.data);
    // Blob is web/jeep-sqlite-fallback only per the plugin's own docs, not a real iOS/Android
    // build — handled anyway rather than silently dropping a real checkpoint if it ever occurs.
    return new Uint8Array(await result.data.arrayBuffer());
  } catch {
    return undefined;
  }
}

/** B-631: remove ONE replica's checkpoint, so a discarded replica is not restored from it into the
 * fresh, empty file on the next start. Never throws; a missing file is the common case. */
export async function deleteCheckpoint(scope: string): Promise<void> {
  try {
    const { Filesystem, Directory } = await filesystem();
    await Filesystem.deleteFile({ path: checkpointPath(scope), directory: Directory.Data });
  } catch {
    // No checkpoint (never written), or no plugin.
  }
}

async function writeCheckpoint(scope: string, bytes: Uint8Array): Promise<void> {
  try {
    const { Filesystem, Directory } = await filesystem();
    await Filesystem.writeFile({
      path: checkpointPath(scope),
      directory: Directory.Data,
      data: bytesToBase64(bytes),
    });
  } catch {
    // Best-effort backstop — a failed checkpoint write is not an app-facing error; the live OPFS
    // replica (plus B's reopen-on-resume) is still the primary path regardless.
  }
}

/** How long to wait after a local write before checkpointing — this is a notes app, not a
 * high-write-volume database, so debouncing off actual edits (rather than a bare fixed interval)
 * keeps a burst of typing from writing a checkpoint every keystroke while still capturing state
 * again reasonably soon after things go quiet. */
export const CHECKPOINT_DEBOUNCE_MS = 60_000;

export interface CheckpointScheduler {
  /** Call from `onChange` — debounces by `CHECKPOINT_DEBOUNCE_MS`. */
  onChange(): void;
  /** Call from the `pause` lifecycle event — runs (or re-runs) immediately, since backgrounding is
   * exactly when OPFS may be about to become unusable (research/08 §1.3), not something to still
   * be waiting out a debounce for. */
  onPause(): void;
  stop(): void;
}

/**
 * Takes a plain `exportSnapshot` function rather than the worker API/Comlink object directly, so
 * this never touches `WorkerApi.onChange` itself — that RPC slot is a single registration
 * `client.ts`'s own `fanOut` already owns (B-130: a second direct subscriber there silently
 * replaces the first). The caller (`client.ts`) wires this scheduler's `onChange`/`onPause` methods
 * into its own already-existing `onChange`/`platform.lifecycle.on("pause", ...)` subscriptions
 * instead.
 */
export function createCheckpointScheduler(
  exportSnapshot: () => Promise<Uint8Array | undefined>,
  /** Which replica's checkpoint file this writes (`checkpointPath`). */
  scope = "~",
): CheckpointScheduler {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let running = false;
  // A change (or pause) that arrives while a checkpoint is already exporting/writing is not lost —
  // it schedules one more run right after the current one finishes, rather than overlapping calls
  // against the same worker/file.
  let runAgain = false;

  async function run(): Promise<void> {
    if (running) {
      runAgain = true;
      return;
    }
    running = true;
    try {
      const bytes = await exportSnapshot().catch(() => undefined);
      if (bytes && !stopped) await writeCheckpoint(scope, bytes);
    } finally {
      running = false;
      if (runAgain && !stopped) {
        runAgain = false;
        void run();
      }
    }
  }

  return {
    onChange(): void {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void run(), CHECKPOINT_DEBOUNCE_MS);
    },
    onPause(): void {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = undefined;
      void run();
    },
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
