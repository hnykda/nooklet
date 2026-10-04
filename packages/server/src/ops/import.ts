/**
 * `import.*` (ADR 031): import a Logseq graph from inside the app, without a terminal.
 *
 * The client zips the graph folder (or the phone picks a .zip), then:
 *
 *   import.info    may this session import, how big may it be, is this graph empty
 *   import.begin   name the target (a new graph, or this one if empty) -> job_id
 *   import.chunk   the zip, 4 MiB at a time, base64, in order (a retried chunk is accepted)
 *   import.start   upload complete; unpack, import and verify in the background
 *   import.status  poll: state, counts, then the summary (and the new graph's token)
 *   import.cancel  stop; nothing is left behind (see `../importer/jobs.ts`)
 *
 * Chunks rather than one big body keep every request under the ordinary 16 MB cap, so nothing in
 * `../http/guards.ts` had to grow; the import's own, larger total is `nooklet serve
 * --import-max-mb`. All `admin` (ADR 029: server administration, and creating a graph is that),
 * and HTTP only: an MCP agent has `nooklet import` and no reason to base64 a quarter gigabyte.
 */

import { z } from "zod";
import {
  graphContent,
  ImportJobError,
  type ImportJobView,
  importServiceFor,
} from "../importer/jobs.js";
import { defineOp, type OpContext, OpError } from "./registry.js";

const ADMIN_HTTP_ONLY = { http: true, mcp: false } as const;

const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;
const READ = { ...WRITE, readOnlyHint: true, idempotentHint: true } as const;

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

const Progress = z.object({
  phase: z.enum(["reading", "assets", "pages", "references", "done"]),
  filesTotal: z.number().int(),
  filesRead: z.number().int(),
  assetsTotal: z.number().int(),
  assetsDone: z.number().int(),
  assetsImported: z.number().int(),
  pagesDone: z.number().int(),
  pagesImported: z.number().int(),
  journalsImported: z.number().int(),
  blocksImported: z.number().int(),
});

const JobView = z.object({
  job_id: z.string(),
  state: z.enum([
    "uploading",
    "extracting",
    "importing",
    "verifying",
    "done",
    "failed",
    "cancelled",
  ]),
  target: z.union([
    z.object({ kind: z.literal("new"), graph_id: z.string(), label: z.string() }),
    z.object({ kind: z.literal("current") }),
  ]),
  bytes_received: z.number().int(),
  byte_size: z.number().int().nullable(),
  unpacked: z.object({ done: z.number().int(), total: z.number().int() }),
  progress: Progress,
  result: z
    .object({
      format: z.enum(["file", "db"]),
      pages: z.number().int(),
      journals: z.number().int(),
      blocks: z.number().int(),
      assets: z.number().int(),
      referenced_pages: z.number().int(),
      pages_skipped: z.number().int(),
      dangling_block_refs: z.number().int(),
      dangling_asset_links: z.number().int(),
      favorites: z.number().int(),
      warnings: z.array(z.string()),
      warnings_total: z.number().int(),
      errors: z.array(z.string()),
      errors_total: z.number().int(),
      duration_ms: z.number(),
      verify: z.object({
        ok: z.boolean(),
        op_count: z.number().int(),
        divergences: z.number().int(),
        duration_ms: z.number(),
      }),
    })
    .nullable(),
  graph: z.object({ id: z.string(), label: z.string(), token: z.string() }).nullable(),
  message: z.string().nullable(),
  started_at: z.number(),
  finished_at: z.number().nullable(),
});

const JobId = z.string().min(1).max(64);

function host(ctx: OpContext) {
  const found = importServiceFor(ctx.db);
  if (!found) {
    throw new OpError(
      "not_found",
      "importing from the app is not available on this server",
      "run `nooklet import <graph-dir>` on the server instead",
    );
  }
  return found;
}

/** `ImportJobError` -> the op error envelope, same codes. */
function run<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ImportJobError) throw new OpError(err.code, err.message);
    throw err;
  }
}

export const importInfo = defineOp({
  name: "import.info",
  summary: "Whether this session can import a Logseq graph",
  description:
    "For the app's Import from Logseq screen: the upload limit, the chunk size to send, whether " +
    "this graph is empty (and so may be imported into), and the import in progress, if any.",
  input: z.object({}).strict(),
  output: z.object({
    max_upload_bytes: z.number().int(),
    chunk_bytes: z.number().int(),
    current_graph: z.object({
      empty: z.boolean(),
      blocks: z.number().int(),
      assets: z.number().int(),
    }),
    active: JobView.nullable(),
  }),
  annotations: READ,
  scopes: ["admin"],
  expose: ADMIN_HTTP_ONLY,
  handler: (_input, ctx) => {
    const h = host(ctx);
    return {
      max_upload_bytes: h.service.maxUploadBytes,
      chunk_bytes: h.service.chunkBytes,
      current_graph: graphContent(ctx.db),
      active: h.service.activeFor(h),
    };
  },
});

export const importBegin = defineOp({
  name: "import.begin",
  summary: "Start uploading a Logseq graph to import",
  description:
    "Opens an import job. target 'new' creates a graph with id graph_id (lowercase letters, " +
    "digits, hyphens) when the import succeeds; 'current' imports into this graph, and is refused " +
    "unless it is empty. Send the zip with import.chunk, then call import.start.",
  input: z
    .object({
      target: z.enum(["new", "current"]),
      graph_id: z.string().min(1).max(64).optional(),
      label: z.string().min(1).max(200).optional(),
      byte_size: z.number().int().min(1).optional().describe("Expected upload size, if known"),
    })
    .strict(),
  output: JobView,
  annotations: WRITE,
  scopes: ["admin"],
  expose: ADMIN_HTTP_ONLY,
  handler: (input, ctx): ImportJobView => {
    const h = host(ctx);
    if (input.target === "new" && !input.graph_id) {
      throw new OpError("invalid", "graph_id is required for a new graph");
    }
    return run(() =>
      h.service.begin(h, {
        target:
          input.target === "new"
            ? {
                kind: "new",
                graphId: input.graph_id as string,
                label: input.label?.trim() || (input.graph_id as string),
              }
            : { kind: "current" },
        byteSize: input.byte_size,
      }),
    );
  },
});

export const importChunk = defineOp({
  name: "import.chunk",
  summary: "Send the next piece of an import upload",
  description:
    "Appends base64 bytes at offset (which must equal the bytes received so far; resending a " +
    "chunk the server already has is accepted). At most chunk_bytes (import.info) per call.",
  input: z
    .object({
      job_id: JobId,
      offset: z.number().int().min(0),
      data_base64: z.string().min(1),
    })
    .strict(),
  output: z.object({ bytes_received: z.number().int() }),
  annotations: WRITE,
  scopes: ["admin"],
  expose: ADMIN_HTTP_ONLY,
  handler: (input, ctx) => {
    const h = host(ctx);
    if (!BASE64_RE.test(input.data_base64) || input.data_base64.length % 4 !== 0) {
      throw new OpError("invalid", "data_base64 is not valid base64");
    }
    const bytes = Buffer.from(input.data_base64, "base64");
    if (bytes.length > h.service.chunkBytes) {
      throw new OpError("too_large", `a chunk may be at most ${h.service.chunkBytes} bytes`);
    }
    const view = run(() => h.service.chunk(h, input.job_id, input.offset, bytes));
    return { bytes_received: view.bytes_received };
  },
});

export const importStart = defineOp({
  name: "import.start",
  summary: "Finish an import upload and run the import",
  description:
    "Marks the upload complete (byte_size must match what was received), then unpacks, imports " +
    "and verifies in the background. Poll import.status.",
  input: z.object({ job_id: JobId, byte_size: z.number().int().min(1) }).strict(),
  output: JobView,
  annotations: WRITE,
  scopes: ["admin"],
  expose: ADMIN_HTTP_ONLY,
  handler: (input, ctx) => {
    const h = host(ctx);
    return run(() => h.service.start(h, input.job_id, input.byte_size));
  },
});

export const importStatus = defineOp({
  name: "import.status",
  summary: "Progress and outcome of an import",
  description:
    "State (uploading, extracting, importing, verifying, done, failed, cancelled), live counts, " +
    "and once finished the summary. A finished 'new' import includes the graph id and a token " +
    "for it. Kept for an hour after it finishes.",
  input: z.object({ job_id: JobId }).strict(),
  output: JobView,
  annotations: READ,
  scopes: ["admin"],
  expose: ADMIN_HTTP_ONLY,
  handler: (input, ctx) => {
    const h = host(ctx);
    return run(() => h.service.status(h, input.job_id));
  },
});

export const importCancel = defineOp({
  name: "import.cancel",
  summary: "Cancel an import",
  description:
    "Stops an upload or a running import. A new graph is never created; pages already imported " +
    "into this graph are moved to Trash.",
  input: z.object({ job_id: JobId }).strict(),
  output: JobView,
  annotations: { ...WRITE, destructiveHint: true },
  scopes: ["admin"],
  expose: ADMIN_HTTP_ONLY,
  handler: (input, ctx) => {
    const h = host(ctx);
    return run(() => h.service.cancel(h, input.job_id));
  },
});

export const IMPORT_OPS = [
  importInfo,
  importBegin,
  importChunk,
  importStart,
  importStatus,
  importCancel,
];
