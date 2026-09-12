/**
 * `idempotency_key` (mcp-tools.md §3.6): a write repeated with the same key and the same body
 * replays the stored response instead of running again; the same key with a different body is a
 * `conflict`. Keyed by `(token_id, key)`, kept 24 h.
 *
 * Every write op has carried the field, and `page_append`'s description has told agents "pass
 * idempotency_key if you might retry after a timeout, or you may get duplicate blocks" — while
 * nothing read it. A retried append duplicated the blocks, which is the one outcome the field
 * exists to prevent. This is the implementation, wrapped around every write in `runOpHandler` so
 * the HTTP and MCP mounts (and the stdio bridge) get it identically.
 *
 * What counts as "the same body" is the parsed input with defaults applied, serialised with sorted
 * keys, so `{a, b}` and `{b, a}` are one request and a caller's omitted-vs-explicit default is not
 * a difference. `dry_run` requests are never recorded: they wrote nothing, so there is nothing to
 * protect from being done twice.
 */

import { createHash } from "node:crypto";
import type { SqlDriver } from "@nooklet/core";
import { OpError } from "./registry.js";

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function requestHash(input: unknown): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

interface StoredResponse {
  request_hash: string;
  response_json: string;
}

/**
 * Run `execute` under the idempotency contract for `key`, or straight through when the request
 * carries no key (or no token identity to scope it to — an internal caller). `now` is injectable
 * for the expiry test.
 */
export async function withIdempotency<T>(
  driver: SqlDriver,
  scope: { tokenId: string | undefined; key: string | undefined; input: unknown },
  execute: () => Promise<T>,
  now: number = Date.now(),
): Promise<T> {
  const { tokenId, key } = scope;
  if (key === undefined || tokenId === undefined) return execute();

  // Expiry is enforced at read time (a stale row is ignored) and tidied at write time, so no
  // background job is needed for a table that only ever holds a day of one token's retries.
  const hash = requestHash(scope.input);
  const stored = driver.get<StoredResponse>(
    "SELECT request_hash, response_json FROM idempotency WHERE token_id = ? AND key = ? AND created_at > ?",
    [tokenId, key, now - IDEMPOTENCY_TTL_MS],
  );
  if (stored) {
    if (stored.request_hash !== hash) {
      throw new OpError(
        "conflict",
        "idempotency key reused with a different request",
        "use a fresh idempotency_key for a different write; the same key replays only the same body",
      );
    }
    return JSON.parse(stored.response_json) as T;
  }

  const result = await execute();
  driver.run("DELETE FROM idempotency WHERE created_at <= ?", [now - IDEMPOTENCY_TTL_MS]);
  driver.run(
    `INSERT INTO idempotency(token_id, key, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(token_id, key) DO UPDATE SET
       request_hash = excluded.request_hash, response_json = excluded.response_json, created_at = excluded.created_at`,
    [tokenId, key, hash, JSON.stringify(result), now],
  );
  return result;
}
