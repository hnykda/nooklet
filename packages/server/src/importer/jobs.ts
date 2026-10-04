/**
 * In-app Logseq import (ADR 031): the jobs behind the `import.*` ops (`../ops/import.ts`).
 *
 * A job is: an upload, received in chunks into `<data>/import-staging/<job>/upload.zip`; then, in
 * the background, unpacking (`./zip.ts`), importing (`./logseq.ts`, the same importer the CLI
 * uses), and `verifyRebuildParity` (what `nooklet verify` runs) before anything is called done.
 *
 * Two targets:
 *
 * - **A new graph.** Built in a staging data dir that no route can reach, verified, given a token,
 *   then renamed into `<data>/graphs/<id>` in one step. A cancel, a failure or a crash leaves
 *   nothing behind but the staging dir, which the next start of the server deletes. A graph that
 *   fails verification is never published.
 * - **The current graph, only when it has no content.** Imported through the served graph's own
 *   context, one page at a time behind `writeLock`, so connected devices see pages arrive. A
 *   cancel moves the pages imported so far to Trash. Merging into a graph with content is refused:
 *   ADR 025 rules out merging two independent histories, and an import is exactly that.
 *
 * One job at a time per process: an import is CPU- and disk-heavy, and a second one would only
 * make both slower.
 */

import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { makeOp, newId } from "@nooklet/core";
import { createServerContext, type ServerContext, serverApplyOps } from "../apply-ops.js";
import { createToken } from "../auth/tokens.js";
import { openDbWithStatus } from "../db.js";
import type { BaseServerConfig } from "../graphs/open-graph.js";
import { graphDbPath, graphDir, graphsRootDir, isValidGraphId } from "../graphs/paths.js";
import { ensureGraphMeta } from "../graphs/registry.js";
import type { ServerConfig } from "../ops/registry.js";
import { writeLock } from "../ops/trial-lock.js";
import { verifyRebuildParity } from "../verify.js";
import {
  emptyImportProgress,
  IMPORTER_DEVICE_ID,
  type ImportProgress,
  type ImportStats,
  importLogseqGraph,
} from "./logseq.js";
import { DEFAULT_ZIP_LIMITS, extractLogseqZip, type ZipLimits, ZipRejectedError } from "./zip.js";

/** Raw bytes per `import.chunk` call. Base64 makes it ~5.6 MB on the wire, under the 16 MB body
 * cap every ordinary route has (`../http/guards.ts`), so the import needs no larger one. */
export const IMPORT_CHUNK_BYTES = 4 * 1024 * 1024;
/** Default ceiling for one upload. A real 952-page graph with its images is ~250 MB. */
export const DEFAULT_IMPORT_MAX_BYTES = 1024 * 1024 * 1024;
/** An upload with no chunk for this long is abandoned and its bytes deleted. */
const IDLE_UPLOAD_MS = 30 * 60 * 1000;
/** A finished job's status (and a new graph's token) stays readable this long. */
const RETAIN_FINISHED_MS = 60 * 60 * 1000;
/** Warnings/errors returned in a status answer. The counts are always exact. */
const MAX_LISTED = 200;

export type ImportTarget = { kind: "new"; graphId: string; label: string } | { kind: "current" };

export type ImportJobState =
  | "uploading"
  | "extracting"
  | "importing"
  | "verifying"
  | "done"
  | "failed"
  | "cancelled";

const FINISHED: ReadonlySet<ImportJobState> = new Set(["done", "failed", "cancelled"]);

export class ImportJobError extends Error {
  constructor(
    public code: "invalid" | "conflict" | "too_large" | "not_found",
    message: string,
  ) {
    super(message);
  }
}

/** The graph an import was started from: whose admin token asked, and where "current" points. */
export interface ImportSource {
  ctx: ServerContext;
  config: ServerConfig;
}

export interface ImportResultView {
  /** Which Logseq the graph came from: a classic file graph or the DB version (ADR 030). */
  format: "file" | "db";
  pages: number;
  journals: number;
  blocks: number;
  assets: number;
  referenced_pages: number;
  pages_skipped: number;
  dangling_block_refs: number;
  dangling_asset_links: number;
  favorites: number;
  warnings: string[];
  warnings_total: number;
  errors: string[];
  errors_total: number;
  duration_ms: number;
  verify: { ok: boolean; op_count: number; divergences: number; duration_ms: number };
}

export interface ImportJobView {
  job_id: string;
  state: ImportJobState;
  target: { kind: "new"; graph_id: string; label: string } | { kind: "current" };
  bytes_received: number;
  byte_size: number | null;
  /** Files unpacked so far / to unpack. */
  unpacked: { done: number; total: number };
  progress: ImportProgress;
  result: ImportResultView | null;
  /** The new graph and an `admin` + sync token for it, once a "new" import is done. */
  graph: { id: string; label: string; token: string } | null;
  /** Why it failed or what a cancel undid. Not `error`: the client reads a top-level `error` key
   *  as a failed call (`apps/web/src/data/api-client.ts#unwrap`). */
  message: string | null;
  started_at: number;
  finished_at: number | null;
}

interface Job {
  id: string;
  /** `ServerContext.driver` of the graph that started it; only that graph may see or steer it. */
  owner: ImportSource["ctx"]["driver"];
  source: ImportSource;
  target: ImportTarget;
  state: ImportJobState;
  dir: string;
  fd: number | null;
  received: number;
  byteSize: number | null;
  unpacked: { done: number; total: number };
  progress: ImportProgress;
  result: ImportResultView | null;
  graph: { id: string; label: string; token: string } | null;
  error: string | null;
  abort: AbortController;
  startedAt: number;
  finishedAt: number | null;
  lastActivity: number;
}

export interface ImportServiceOptions {
  /** The multi-graph data dir (`<data>`, holding `graphs/`). */
  rootDataDir: string;
  baseConfig: BaseServerConfig;
  maxUploadBytes?: number;
  zipLimits?: Partial<ZipLimits>;
  now?: () => number;
}

/** Whether a graph holds anything an import could clobber or be confused with: a non-blank block,
 * a page property, or an asset. Empty pages (an untouched journal day, a page minted by a
 * reference) do not count; `clearEmptyPages` removes them before importing. */
export function graphContent(driver: ServerContext["driver"]): {
  empty: boolean;
  blocks: number;
  assets: number;
} {
  const blocks =
    driver.get<{ n: number }>(
      `SELECT count(*) AS n FROM block b JOIN page p ON p.id = b.page_id
       WHERE b.deleted_at IS NULL AND p.deleted_at IS NULL AND trim(b.content) <> ''`,
    )?.n ?? 0;
  const props =
    driver.get<{ n: number }>(
      `SELECT count(*) AS n FROM page_prop pp JOIN page p ON p.id = pp.page_id
       WHERE p.deleted_at IS NULL AND pp.value IS NOT NULL`,
    )?.n ?? 0;
  const assets =
    driver.get<{ n: number }>("SELECT count(*) AS n FROM asset WHERE deleted_at IS NULL")?.n ?? 0;
  return { empty: blocks === 0 && props === 0 && assets === 0, blocks, assets };
}

/** Soft-deletes `pageIds` and their blocks, as `page.delete` does: recoverable from Trash. */
function trashPages(ctx: ServerContext, pageIds: readonly string[]): void {
  const now = Date.now();
  for (let i = 0; i < pageIds.length; i += 200) {
    const ops = pageIds.slice(i, i + 200).flatMap((pageId) => [
      makeOp(ctx.hlc.next(), IMPORTER_DEVICE_ID, pageId, { kind: "page.delete", deletedAt: now }),
      ...ctx.driver
        .all<{ id: string }>("SELECT id FROM block WHERE page_id = ? AND deleted_at IS NULL", [
          pageId,
        ])
        .map((b) =>
          makeOp(ctx.hlc.next(), IMPORTER_DEVICE_ID, b.id, {
            kind: "block.delete",
            deletedAt: now,
          }),
        ),
    ]);
    serverApplyOps(ctx, ops, { origin: "import", actor: "logseq-import" });
  }
}

/** An "empty" graph can still hold empty pages (today's journal, opened once). An imported page
 * with the same name would collide with them, so they go first. */
function clearEmptyPages(ctx: ServerContext): void {
  const ids = ctx.driver
    .all<{ id: string }>("SELECT id FROM page WHERE deleted_at IS NULL")
    .map((r) => r.id);
  if (ids.length > 0) trashPages(ctx, ids);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toResultView(stats: ImportStats, verify: ReturnType<typeof verifyRebuildParity>) {
  return {
    format: stats.format,
    pages: stats.pagesImported,
    journals: stats.journalsImported,
    blocks: stats.blocksImported,
    assets: stats.assetsImported,
    referenced_pages: stats.referencedPagesCreated,
    pages_skipped: stats.pagesSkipped,
    dangling_block_refs: stats.danglingBlockRefs,
    dangling_asset_links: stats.danglingAssetLinks,
    favorites: stats.favoritesMarked,
    warnings: stats.warnings.slice(0, MAX_LISTED),
    warnings_total: stats.warnings.length,
    errors: stats.errors.slice(0, MAX_LISTED),
    errors_total: stats.errors.length,
    duration_ms: stats.durationMs,
    verify: {
      ok: verify.ok,
      op_count: verify.opCount,
      divergences: verify.divergences.length,
      duration_ms: verify.durationMs,
    },
  } satisfies ImportResultView;
}

class Cancelled extends Error {
  constructor() {
    super("import cancelled");
  }
}

export class ImportService {
  readonly maxUploadBytes: number;
  readonly chunkBytes = IMPORT_CHUNK_BYTES;
  #opts: ImportServiceOptions;
  #jobs = new Map<string, Job>();
  #now: () => number;
  #staging: string;
  #reaper: ReturnType<typeof setInterval>;

  constructor(opts: ImportServiceOptions) {
    this.#opts = opts;
    this.maxUploadBytes = opts.maxUploadBytes ?? DEFAULT_IMPORT_MAX_BYTES;
    this.#now = opts.now ?? Date.now;
    this.#staging = join(opts.rootDataDir, "import-staging");
    // Anything here belongs to a process that is gone: one server per data dir.
    rmSync(this.#staging, { recursive: true, force: true });
    this.#reaper = setInterval(() => this.reap(), 60_000);
    this.#reaper.unref?.();
  }

  dispose(): void {
    clearInterval(this.#reaper);
    for (const job of this.#jobs.values()) this.#cancel(job);
  }

  /** Drops abandoned uploads and old finished jobs. Runs every minute; exposed for tests. */
  reap(): void {
    const now = this.#now();
    for (const job of [...this.#jobs.values()]) {
      if (job.state === "uploading" && now - job.lastActivity > IDLE_UPLOAD_MS) this.#cancel(job);
      if (job.finishedAt !== null && now - job.finishedAt > RETAIN_FINISHED_MS) {
        this.#jobs.delete(job.id);
      }
    }
  }

  /** The running (or uploading) job, if any, for whichever graph started it. */
  active(): Job | undefined {
    return [...this.#jobs.values()].find((j) => !FINISHED.has(j.state));
  }

  activeFor(source: ImportSource): ImportJobView | null {
    const job = this.active();
    return job && job.owner === source.ctx.driver ? this.view(job) : null;
  }

  begin(source: ImportSource, input: { target: ImportTarget; byteSize?: number }): ImportJobView {
    const running = this.active();
    if (running) {
      throw new ImportJobError(
        "conflict",
        running.owner === source.ctx.driver
          ? "an import is already in progress for this graph"
          : "another import is in progress on this server; try again when it finishes",
      );
    }
    if (input.byteSize !== undefined && input.byteSize > this.maxUploadBytes) {
      throw new ImportJobError(
        "too_large",
        `the graph is ${Math.round(input.byteSize / 1024 / 1024)} MB; this server accepts imports up to ${Math.round(this.maxUploadBytes / 1024 / 1024)} MB (nooklet serve --import-max-mb)`,
      );
    }
    this.#checkTarget(source, input.target);
    const id = newId();
    const dir = join(this.#staging, id);
    mkdirSync(dir, { recursive: true });
    const now = this.#now();
    const job: Job = {
      id,
      owner: source.ctx.driver,
      source,
      target: input.target,
      state: "uploading",
      dir,
      fd: openSync(join(dir, "upload.zip"), "wx"),
      received: 0,
      byteSize: input.byteSize ?? null,
      unpacked: { done: 0, total: 0 },
      progress: emptyImportProgress(),
      result: null,
      graph: null,
      error: null,
      abort: new AbortController(),
      startedAt: now,
      finishedAt: null,
      lastActivity: now,
    };
    this.#jobs.set(id, job);
    return this.view(job);
  }

  #checkTarget(source: ImportSource, target: ImportTarget): void {
    if (target.kind === "new") {
      if (!isValidGraphId(target.graphId)) {
        throw new ImportJobError(
          "invalid",
          `"${target.graphId}" is not a valid graph id (lowercase letters, digits and hyphens, 1-64 characters, not starting or ending with a hyphen)`,
        );
      }
      if (existsSync(graphDir(this.#opts.rootDataDir, target.graphId))) {
        throw new ImportJobError("conflict", `a graph called "${target.graphId}" already exists`);
      }
      return;
    }
    const content = graphContent(source.ctx.driver);
    if (!content.empty) {
      throw new ImportJobError(
        "conflict",
        `this graph is not empty (${content.blocks} blocks with text, ${content.assets} assets); import into a new graph instead`,
      );
    }
  }

  #job(source: ImportSource, jobId: string): Job {
    const job = this.#jobs.get(jobId);
    if (!job || job.owner !== source.ctx.driver) {
      throw new ImportJobError("not_found", `no import "${jobId}" on this graph`);
    }
    return job;
  }

  chunk(source: ImportSource, jobId: string, offset: number, bytes: Uint8Array): ImportJobView {
    const job = this.#job(source, jobId);
    if (job.state !== "uploading" || job.fd === null) {
      throw new ImportJobError("conflict", `this import is ${job.state}, not uploading`);
    }
    // A retried chunk the server already has is fine; anything else out of order is not.
    if (offset < job.received && offset + bytes.length <= job.received) return this.view(job);
    if (offset !== job.received) {
      throw new ImportJobError(
        "invalid",
        `expected the chunk at byte ${job.received}, got one at ${offset}`,
      );
    }
    if (job.received + bytes.length > this.maxUploadBytes) {
      this.#fail(job, "the upload went over this server's import size limit");
      throw new ImportJobError(
        "too_large",
        `uploads are limited to ${Math.round(this.maxUploadBytes / 1024 / 1024)} MB (nooklet serve --import-max-mb)`,
      );
    }
    writeSync(job.fd, bytes, 0, bytes.length, offset);
    job.received += bytes.length;
    job.lastActivity = this.#now();
    return this.view(job);
  }

  /** Ends the upload and starts the import in the background. Poll `status` for the outcome. */
  start(source: ImportSource, jobId: string, byteSize: number): ImportJobView {
    const job = this.#job(source, jobId);
    if (job.state !== "uploading" || job.fd === null) {
      throw new ImportJobError("conflict", `this import is ${job.state}, not uploading`);
    }
    if (byteSize !== job.received) {
      throw new ImportJobError(
        "invalid",
        `the server has ${job.received} bytes of the upload, not ${byteSize}; resend the rest`,
      );
    }
    closeSync(job.fd);
    job.fd = null;
    job.byteSize = byteSize;
    job.state = "extracting";
    void this.#run(job);
    return this.view(job);
  }

  status(source: ImportSource, jobId: string): ImportJobView {
    return this.view(this.#job(source, jobId));
  }

  cancel(source: ImportSource, jobId: string): ImportJobView {
    const job = this.#job(source, jobId);
    this.#cancel(job);
    return this.view(job);
  }

  #cancel(job: Job): void {
    if (FINISHED.has(job.state)) return;
    if (job.state === "uploading") {
      if (job.fd !== null) closeSync(job.fd);
      job.fd = null;
      this.#finish(job, "cancelled");
      return;
    }
    // Running: `#run` notices at its next checkpoint, cleans up and finishes the job.
    job.abort.abort(new Cancelled());
  }

  #fail(job: Job, message: string): void {
    if (job.fd !== null) closeSync(job.fd);
    job.fd = null;
    job.error = message;
    this.#finish(job, "failed");
  }

  #finish(job: Job, state: "done" | "failed" | "cancelled"): void {
    job.state = state;
    job.finishedAt = this.#now();
    rmSync(job.dir, { recursive: true, force: true });
  }

  async #run(job: Job): Promise<void> {
    const graphDirIn = join(job.dir, "graph");
    const signal = job.abort.signal;
    const created: string[] = [];
    try {
      const extracted = await extractLogseqZip(join(job.dir, "upload.zip"), graphDirIn, {
        limits: { ...DEFAULT_ZIP_LIMITS, ...this.#opts.zipLimits },
        signal,
        onProgress: (done, total) => {
          job.unpacked = { done, total };
        },
      });
      // The archive is no longer needed; on a big graph that is a quarter of a gigabyte back.
      rmSync(join(job.dir, "upload.zip"), { force: true });
      job.state = "importing";
      const onProgress = (p: ImportProgress) => {
        job.progress = { ...p };
      };
      if (job.target.kind === "new") {
        await this.#importNew(job, job.target, graphDirIn, extracted.warnings, onProgress);
      } else {
        await this.#importCurrent(job, graphDirIn, extracted.warnings, onProgress, created);
      }
    } catch (err) {
      if (signal.aborted) {
        if (created.length > 0) {
          await writeLock.run(() => trashPages(job.source.ctx, created));
          job.error = `cancelled; the ${created.length} pages imported so far were moved to Trash`;
        }
        this.#finish(job, "cancelled");
        return;
      }
      job.error =
        err instanceof ZipRejectedError || err instanceof ImportJobError
          ? err.message
          : `the import failed: ${errMsg(err)}`;
      this.#finish(job, "failed");
    }
  }

  async #importNew(
    job: Job,
    target: Extract<ImportTarget, { kind: "new" }>,
    graphDirIn: string,
    zipWarnings: string[],
    onProgress: (p: ImportProgress) => void,
  ): Promise<void> {
    // A data dir of its own, shaped like the real one, so `graphDir(staging, id)` is the exact
    // directory that is renamed into place at the end — database, assets and all.
    const stagingData = join(job.dir, "data");
    const db = openDbWithStatus({ path: graphDbPath(stagingData, target.graphId) });
    let closed = false;
    try {
      const ctx = createServerContext(db.driver);
      const stats = await importLogseqGraph(ctx, graphDirIn, {
        dataDir: graphDir(stagingData, target.graphId),
        signal: job.abort.signal,
        onProgress,
      });
      stats.warnings.unshift(...zipWarnings);
      job.state = "verifying";
      await new Promise<void>((r) => setImmediate(r)); // let a poll see "verifying"
      const verify = verifyRebuildParity(db.driver);
      job.result = toResultView(stats, verify);
      if (!verify.ok) {
        throw new ImportJobError(
          "invalid",
          `the imported graph failed verification (${verify.divergences.length} differences between its op log and its state); it was not created`,
        );
      }
      if (job.abort.signal.aborted) throw job.abort.signal.reason;
      // Like `POST /graphs`: the caller gets a token for the graph it just made.
      const token = createToken(db.driver, {
        label: "logseq import",
        scope: "admin",
        canSync: true,
      }).token;
      db.close();
      closed = true;
      const finalDir = graphDir(this.#opts.rootDataDir, target.graphId);
      if (existsSync(finalDir)) {
        throw new ImportJobError(
          "conflict",
          `a graph called "${target.graphId}" was created while this import ran; nothing was changed`,
        );
      }
      mkdirSync(graphsRootDir(this.#opts.rootDataDir), { recursive: true });
      // One rename: the graph appears whole or not at all. The registry opens it lazily on its
      // first request (`../graphs/registry.ts#resolve`), so no restart is needed.
      renameSync(graphDir(stagingData, target.graphId), finalDir);
      ensureGraphMeta(this.#opts.rootDataDir, target.graphId, target.label);
      job.graph = { id: target.graphId, label: target.label, token };
      this.#finish(job, "done");
    } finally {
      if (!closed) db.close();
    }
  }

  async #importCurrent(
    job: Job,
    graphDirIn: string,
    zipWarnings: string[],
    onProgress: (p: ImportProgress) => void,
    created: string[],
  ): Promise<void> {
    const { ctx, config } = job.source;
    await writeLock.run(() => {
      // Checked again: someone may have typed while the upload ran.
      const content = graphContent(ctx.driver);
      if (!content.empty) {
        throw new ImportJobError(
          "conflict",
          "this graph got content while the upload ran; nothing was imported. Import into a new graph instead",
        );
      }
      clearEmptyPages(ctx);
    });
    const stats = await importLogseqGraph(ctx, graphDirIn, {
      dataDir: config.dataDir,
      signal: job.abort.signal,
      onProgress,
      runExclusive: (fn) => writeLock.run(fn),
      onPageCreated: (id) => created.push(id),
    });
    stats.warnings.unshift(...zipWarnings);
    job.state = "verifying";
    await new Promise<void>((r) => setImmediate(r));
    const verify = verifyRebuildParity(ctx.driver);
    job.result = toResultView(stats, verify);
    if (!verify.ok) {
      // The pages are in the graph and synced; there is nothing to roll back to. Say so.
      job.error = `imported, but verification found ${verify.divergences.length} differences between the op log and the graph's state; run "nooklet verify" on the server for details`;
      this.#finish(job, "failed");
      return;
    }
    this.#finish(job, "done");
  }

  view(job: Job): ImportJobView {
    return {
      job_id: job.id,
      state: job.state,
      target:
        job.target.kind === "new"
          ? { kind: "new", graph_id: job.target.graphId, label: job.target.label }
          : { kind: "current" },
      bytes_received: job.received,
      byte_size: job.byteSize,
      unpacked: { ...job.unpacked },
      progress: { ...job.progress },
      result: job.result,
      graph: job.graph,
      message: job.error,
      started_at: job.startedAt,
      finished_at: job.finishedAt,
    };
  }
}

// -------------------------------------------------------------------------------------------
// Which service a graph's ops talk to
// -------------------------------------------------------------------------------------------

/** Keyed by the graph's driver, the identity `OpContext.db` carries (the same trick `../live/`
 * uses). A graph opened without one (tests, `nooklet mcp --stdio`) answers "not available". */
const services = new WeakMap<ServerContext["driver"], ImportSource & { service: ImportService }>();

export function attachImportService(
  ctx: ServerContext,
  config: ServerConfig,
  service: ImportService,
): void {
  services.set(ctx.driver, { ctx, config, service });
}

export function importServiceFor(
  driver: ServerContext["driver"],
): (ImportSource & { service: ImportService }) | undefined {
  return services.get(driver);
}
