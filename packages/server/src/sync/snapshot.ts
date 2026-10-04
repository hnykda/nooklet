/**
 * `GET /sync/snapshot` (ADR 003 / research/03-sync.md §6.5): the bootstrap path for a brand-new
 * device — the current *state* (every row of the four sync state tables: `page`, `block`,
 * `block_prop`, `page_prop`) plus the `cursor` (max `op.seq`) it is consistent with, so a fresh
 * client can populate its replica in one shot instead of replaying the whole op log.
 *
 * Pagination choice: NONE — this returns all four tables as one JSON body. A cursor-paginated
 * version would have to keep the four tables' pages consistent with each other AND with `cursor`
 * across several HTTP round trips while the graph keeps accepting writes in between, which needs a
 * read transaction held open across requests. Revisit together with the client, which still
 * parses the whole body and inserts it in one transaction (B-660's deferred foreign keys rely on
 * that).
 *
 * Streaming: the body is generated row by row, not built in memory. The first version ran four
 * `driver.all()`s and `c.json()`ed the result: a 60,000-block graph's 51 MiB snapshot cost the
 * server +284 MiB RSS per request (docs/progress/streaming-backup.md), and the owner's real
 * 18.6k-block graph is 17 MB of JSON. The bytes are unchanged — the same keys, the same rows in
 * the same order, the same `JSON.stringify` of each — so every client, old or new, reads it as
 * before.
 *
 * Consistency: all five reads (cursor + four tables) run inside ONE read transaction, so the rows
 * and the cursor describe the same instant. Streamed, that transaction stays open across `await`s,
 * so it cannot run on the server's shared connection — a write committed in between would join it.
 * It runs on a second, read-only connection to the same file: in WAL mode that connection's read
 * transaction sees one fixed snapshot while the main connection keeps writing. An in-memory
 * database (tests) has no second connection to open, and is served the old way.
 *
 * Every row of every table is included, not just `deleted_at IS NULL` rows: a fresh replica needs
 * tombstones and their `_hlc` columns too, exactly like `rebuild()` does (`docs/spec/sql-schema.md`
 * rule 26) — otherwise a later, older-HLC op arriving via `/sync/pull` could incorrectly "win"
 * against a delete/removal the replica never learned about.
 */

import { DatabaseSync } from "node:sqlite";
import type { SqlDriver } from "@nooklet/core";
import type { Hono } from "hono";
import type { ServerContext } from "../apply-ops.js";
import { requireSyncToken } from "./auth.js";

/** Response keys and their tables, in response order. */
const TABLES = [
  ["pages", "page"],
  ["blocks", "block"],
  ["block_props", "block_prop"],
  ["page_props", "page_prop"],
] as const;

/** Flush the JSON text to the response in pieces of about this many characters. */
const CHUNK_CHARS = 64 * 1024;

/** The database file behind `driver`, or `null` for an in-memory one. */
function databaseFile(driver: SqlDriver): string | null {
  const main = driver
    .all<{ name: string; file: string }>("PRAGMA database_list")
    .find((d) => d.name === "main");
  return main?.file ? main.file : null;
}

/** The pre-streaming body, for in-memory databases. */
function inMemorySnapshot(driver: SqlDriver): Record<string, unknown> {
  return driver.transaction(() => {
    const out: Record<string, unknown> = {
      cursor: driver.get<{ n: number }>("SELECT COALESCE(MAX(seq), 0) AS n FROM op")?.n ?? 0,
    };
    for (const [key, table] of TABLES) out[key] = driver.all(`SELECT * FROM ${table}`);
    return out;
  });
}

/**
 * The snapshot body as JSON text, a piece at a time, from its own connection and read
 * transaction. The connection is closed when the generator finishes, throws, or is `return()`ed
 * (a client that disconnects mid-download).
 */
function* snapshotJson(file: string): Generator<string> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("BEGIN");
    const cursor = (
      db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM op").get() as { n: number } | undefined
    )?.n;
    let buf = `{"cursor":${JSON.stringify(cursor ?? 0)}`;
    for (const [key, table] of TABLES) {
      buf += `,"${key}":[`;
      let first = true;
      for (const row of db.prepare(`SELECT * FROM ${table}`).iterate()) {
        buf += first ? JSON.stringify(row) : `,${JSON.stringify(row)}`;
        first = false;
        if (buf.length >= CHUNK_CHARS) {
          yield buf;
          buf = "";
        }
      }
      buf += "]";
    }
    yield `${buf}}`;
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

/** A pull-driven byte stream over `snapshotJson`: the next rows are read only when the consumer
 * (the socket, through gzip) wants more, so memory is a chunk or two whatever the graph's size. */
function snapshotStream(file: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let gen: Generator<string> | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // The first piece is produced here, not on the first pull: that runs the cursor query, which
      // fixes the snapshot's instant when the response is created rather than whenever the client
      // starts reading.
      gen = snapshotJson(file);
      const first = gen.next();
      if (first.done) controller.close();
      else controller.enqueue(encoder.encode(first.value));
    },
    pull(controller) {
      const next = (gen as Generator<string>).next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(next.value));
    },
    cancel() {
      gen?.return(undefined);
    },
  });
}

export function registerSyncSnapshot(app: Hono, serverCtx: ServerContext): void {
  app.get("/sync/snapshot", (c) => {
    const auth = requireSyncToken(c, serverCtx.driver);
    if (auth instanceof Response) return auth;

    const file = databaseFile(serverCtx.driver);
    if (!file) return c.json(inMemorySnapshot(serverCtx.driver));
    return c.body(snapshotStream(file), 200, { "Content-Type": "application/json" });
  });
}
