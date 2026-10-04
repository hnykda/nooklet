/**
 * Settings → Import from Logseq, client side (ADR 031).
 *
 * The server does the import (`packages/server/src/importer/`); this file gets the graph to it:
 * a picked folder is turned into a zip here, one file at a time (`ZipStoreWriter`, STORE only:
 * images are already compressed and markdown is small), and a picked .zip (the phone, or anyone)
 * is sent as it is. Either way the bytes go up in `chunk_bytes` pieces through `import.chunk`, so
 * a 250 MB graph never sits in memory whole and every request stays small.
 *
 * Only what the importer reads is sent (`logseqArchiveTarget`, shared with the server): a folder
 * pick of a real graph also holds `logseq/bak/`, `.git/` and the like, which are left out.
 */

import {
  findLogseqRoot,
  LogseqArchiveError,
  logseqArchiveTarget,
  ZipStoreWriter,
} from "@nooklet/core";
import { ApiError, callOp } from "./api-client.js";
import { addServerGraph, apiBaseUrl, type GraphListEntry } from "./bootstrap.js";
import { serverRootOf } from "./connect-graph.js";

export type ImportJobState =
  | "uploading"
  | "extracting"
  | "importing"
  | "verifying"
  | "done"
  | "failed"
  | "cancelled";

export interface ImportProgress {
  phase: "reading" | "assets" | "pages" | "references" | "done";
  filesTotal: number;
  filesRead: number;
  assetsTotal: number;
  assetsDone: number;
  assetsImported: number;
  pagesDone: number;
  pagesImported: number;
  journalsImported: number;
  blocksImported: number;
}

export interface ImportResult {
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

export interface ImportJob {
  job_id: string;
  state: ImportJobState;
  target: { kind: "new"; graph_id: string; label: string } | { kind: "current" };
  bytes_received: number;
  byte_size: number | null;
  unpacked: { done: number; total: number };
  progress: ImportProgress;
  result: ImportResult | null;
  graph: { id: string; label: string; token: string } | null;
  message: string | null;
}

export interface ImportInfo {
  max_upload_bytes: number;
  chunk_bytes: number;
  current_graph: { empty: boolean; blocks: number; assets: number };
  active: ImportJob | null;
}

export const FINISHED_STATES: ReadonlySet<ImportJobState> = new Set([
  "done",
  "failed",
  "cancelled",
]);

/** What the section can offer this session. */
export type ImportAvailability =
  | { kind: "ready"; info: ImportInfo }
  /** A "Just this device" graph: no server to import on (ADR 031). */
  | { kind: "local-only" }
  /** A phone's paired token is `write`; importing is server administration (`admin`). */
  | { kind: "not-admin" }
  /** A server without the import service (older build, or `nooklet mcp --stdio`). */
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

export async function importAvailability(): Promise<ImportAvailability> {
  try {
    return { kind: "ready", info: await callOp<ImportInfo>("import.info", {}) };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.code === "no_sync_target") return { kind: "local-only" };
      if (err.code === "forbidden") return { kind: "not-admin" };
      if (err.code === "not_found") return { kind: "unavailable" };
    }
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------------------------
// The source: a picked folder or a picked .zip
// ---------------------------------------------------------------------------------------------

export interface FolderSource {
  kind: "folder";
  /** The picked folder's own name, a good default for the new graph's name. */
  name: string;
  files: Array<{ target: string; file: File }>;
  pages: number;
  journals: number;
  assets: number;
  /** Sum of the files' sizes; the zip adds a few dozen bytes per file. */
  bytes: number;
}

export interface ZipSource {
  kind: "zip";
  name: string;
  file: File;
  bytes: number;
}

export type ImportSource = FolderSource | ZipSource;

/** Path of a file from a folder pick: `<folder>/pages/A.md`. */
function relativePath(file: File): string {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}

/** The graph inside a folder pick, or a sentence saying why it is not one. */
export function folderSource(files: readonly File[]): FolderSource | { error: string } {
  const paths = files.map(relativePath);
  let root: string;
  try {
    root = findLogseqRoot(paths);
  } catch (err) {
    if (err instanceof LogseqArchiveError) return { error: `That folder: ${err.message}.` };
    throw err;
  }
  const picked: FolderSource["files"] = [];
  let pages = 0;
  let journals = 0;
  let assets = 0;
  let bytes = 0;
  files.forEach((file, i) => {
    const target = logseqArchiveTarget(paths[i] as string, root);
    if (target === null) return;
    picked.push({ target, file });
    bytes += file.size;
    const inGraph = target.replace(/^mirror\/markdown\//, "");
    if (inGraph.startsWith("pages/")) pages++;
    else if (inGraph.startsWith("journals/")) journals++;
    else if (target.startsWith("assets/")) assets++;
  });
  const top = (paths[0] ?? "").split("/")[0] ?? "";
  const name = root ? (root.replace(/\/$/, "").split("/").pop() ?? top) : top;
  return { kind: "folder", name: name || "Logseq", files: picked, pages, journals, assets, bytes };
}

export function zipSource(file: File): ZipSource {
  return { kind: "zip", name: file.name.replace(/\.zip$/i, ""), file, bytes: file.size };
}

/** The zip of a folder source, a piece at a time. */
async function* zipPieces(source: FolderSource): AsyncGenerator<Uint8Array> {
  const writer = new ZipStoreWriter();
  for (const { target, file } of source.files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    yield* writer.add(target, bytes, new Date(file.lastModified || Date.now()));
  }
  yield writer.finish();
}

async function* filePieces(file: Blob, size: number): AsyncGenerator<Uint8Array> {
  for (let o = 0; o < file.size; o += size) {
    yield new Uint8Array(await file.slice(o, o + size).arrayBuffer());
  }
}

/** Regroups `pieces` into chunks of exactly `size` bytes (the last one shorter). */
export async function* rechunk(
  pieces: AsyncIterable<Uint8Array>,
  size: number,
): AsyncGenerator<Uint8Array> {
  let buf = new Uint8Array(size);
  let used = 0;
  for await (const piece of pieces) {
    let p = 0;
    while (p < piece.length) {
      const n = Math.min(size - used, piece.length - p);
      buf.set(piece.subarray(p, p + n), used);
      used += n;
      p += n;
      if (used === size) {
        yield buf;
        buf = new Uint8Array(size);
        used = 0;
      }
    }
  }
  if (used > 0) yield buf.subarray(0, used);
}

/** Base64 through the browser's own encoder: a 4 MiB chunk in a few milliseconds, where a
 * `btoa(String.fromCharCode(...))` loop takes far longer and allocates a string per byte. */
export function toBase64(bytes: Uint8Array): Promise<string> {
  return new Promise((ok, fail) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      ok(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => fail(reader.error ?? new Error("could not encode the upload"));
    reader.readAsDataURL(new Blob([bytes as Uint8Array<ArrayBuffer>]));
  });
}

// ---------------------------------------------------------------------------------------------
// Upload and job control
// ---------------------------------------------------------------------------------------------

export type ImportTargetChoice =
  | { kind: "new"; graphId: string; label: string }
  | { kind: "current" };

/** A graph id the server accepts (`isValidGraphId`), made from a name. */
export function graphIdFromName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

/** Chunk calls carry a few MB; on a phone over a tailnet that can take longer than the ordinary
 * 10 s request bound. */
const CHUNK_TIMEOUT_MS = 120_000;

async function sendChunk(jobId: string, offset: number, bytes: Uint8Array, signal: AbortSignal) {
  const data_base64 = await toBase64(bytes);
  // A dropped connection mid-upload is retried in place: the server accepts a chunk it already
  // has, so a retry after a lost reply is harmless.
  for (let attempt = 1; ; attempt++) {
    try {
      await callOp(
        "import.chunk",
        { job_id: jobId, offset, data_base64 },
        {
          signal,
          timeoutMs: CHUNK_TIMEOUT_MS,
        },
      );
      return;
    } catch (err) {
      const transient =
        err instanceof ApiError && (err.code === "network" || err.code === "timeout");
      if (!transient || attempt >= 3 || signal.aborted) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

/**
 * Opens a job, uploads `source`, and starts the import. Returns the started job; poll
 * `importStatus` from there. `onJob` gets the job id as soon as there is one, so Cancel works
 * during the upload too.
 */
export async function uploadImport(opts: {
  source: ImportSource;
  target: ImportTargetChoice;
  chunkBytes: number;
  signal: AbortSignal;
  onJob: (jobId: string) => void;
  onUploaded: (bytes: number) => void;
}): Promise<ImportJob> {
  const { source, target, chunkBytes, signal } = opts;
  const job = await callOp<ImportJob>("import.begin", {
    target: target.kind,
    ...(target.kind === "new" ? { graph_id: target.graphId, label: target.label } : {}),
    byte_size: source.bytes,
  });
  opts.onJob(job.job_id);
  const pieces = source.kind === "zip" ? filePieces(source.file, chunkBytes) : zipPieces(source);
  let offset = 0;
  for await (const chunk of rechunk(pieces, chunkBytes)) {
    if (signal.aborted) throw new ApiError("aborted", "the import was cancelled");
    await sendChunk(job.job_id, offset, chunk, signal);
    offset += chunk.length;
    opts.onUploaded(offset);
  }
  return callOp<ImportJob>("import.start", { job_id: job.job_id, byte_size: offset });
}

export function importStatus(jobId: string): Promise<ImportJob> {
  return callOp<ImportJob>("import.status", { job_id: jobId });
}

export function cancelImport(jobId: string): Promise<ImportJob> {
  return callOp<ImportJob>("import.cancel", { job_id: jobId });
}

/** Remembers the new graph on this device with the token the server made for it, and makes it
 * the active one. The caller navigates. */
export function rememberImportedGraph(graph: NonNullable<ImportJob["graph"]>): GraphListEntry {
  const base = apiBaseUrl();
  const root = base ? serverRootOf(base) : "";
  return addServerGraph(`${root}/g/${graph.id}`, graph.token, graph.label);
}
