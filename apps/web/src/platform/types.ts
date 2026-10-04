/**
 * The `platform` adapter (ADR 005): the one seam between app code and the host environment.
 * `./web.ts` is the only implementation today; a `./capacitor.ts` drops in later (native SQLite,
 * exact keyboard events, share-sheet receiving, `nooklet://` deep links, quick actions) without
 * touching any caller, because every caller imports the `Platform` *interface* from this file and
 * the active singleton from `./index.ts`, never a concrete implementation module directly.
 */

export type LifecycleEvent = "online" | "offline" | "visible" | "hidden" | "pause" | "resume";

export interface KeyboardHandle {
  /** Stop observing and reset `--kb` to `0px`. */
  stop(): void;
}

export interface HapticsAdapter {
  impact(style?: "light" | "medium" | "heavy"): void;
  selection(): void;
  notify(type: "success" | "warning" | "error"): void;
}

export interface ShareAdapter {
  /** Best-effort outbound share; resolves `false` if unsupported or cancelled. */
  share(data: { title?: string; text?: string; url?: string }): Promise<boolean>;
  /** B-736: share a file's bytes (an image from a note) through the system share sheet, which on
   * a phone is where "Save Image" lives. Resolves `false` if unsupported or cancelled. */
  shareFile(file: { name: string; blob: Blob }): Promise<boolean>;
}

export interface DeepLinkAdapter {
  /** Fires for `nooklet://...` opens, cold start included. Returns an unsubscribe function. */
  onOpen(cb: (url: string) => void): () => void;
}

export interface LifecycleAdapter {
  /** Returns an unsubscribe function. Wire `online`/`resume` to `syncClient.flush()`+`pull()`
   * (ADR 005: "pending ops are flushed on pause/resume/online, never left to Background Sync"). */
  on(event: LifecycleEvent, cb: () => void): () => void;
}

export interface StorageEstimate {
  usage: number;
  quota: number;
}

export interface StorageAdapter {
  /** Request persistent storage; resolves the granted state. Never throws. */
  persist(): Promise<boolean>;
  persisted(): Promise<boolean>;
  estimate(): Promise<StorageEstimate | undefined>;
}

export interface Platform {
  readonly name: "web" | "capacitor";
  storage: StorageAdapter;
  haptics: HapticsAdapter;
  share: ShareAdapter;
  deepLinks: DeepLinkAdapter;
  lifecycle: LifecycleAdapter;
  /** Start observing the keyboard inset and writing `--kb` on the document root. Call once, at
   * app startup; the returned handle stops it (e.g. on hot-reload teardown in dev). */
  startKeyboardWatcher(): KeyboardHandle;
}
