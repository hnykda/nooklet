/**
 * A stable identity for *this database*, so a client can tell whether the graph it holds a copy
 * of is the graph the server is actually serving.
 *
 * Why this is needed: a client keeps a full SQLite replica in OPFS, keyed by ORIGIN. Point
 * `http://127.0.0.1:6100` at a different data directory — which happens every time you run
 * `nooklet serve --data …` against another graph, or when the desktop app's default moved — and
 * the browser happily reuses the replica it already had. The result is a client showing a
 * thousand pages from one graph while every server-backed feature (search, backlinks) answers
 * from a different, nearly empty one. Nothing in either half is broken, and nothing says so.
 *
 * `graph_id` on the tables is a different thing: that is the *logical* graph name (`"default"`),
 * reserved for a future multi-graph server. This is the physical instance, generated once per
 * database file and never reused.
 */

import { randomUUID } from "node:crypto";
import type { SqlDriver } from "@nooklet/core";

const KEY = "graph.instance_id";

/** This database's identity, minted on first call and stable thereafter. */
export function graphInstanceId(driver: SqlDriver): string {
  const row = driver.get<{ value_json: string }>("SELECT value_json FROM setting WHERE key = ?", [
    KEY,
  ]);
  if (row) {
    try {
      const parsed = JSON.parse(row.value_json) as unknown;
      if (typeof parsed === "string" && parsed !== "") return parsed;
    } catch {
      // Corrupt value: fall through and mint a fresh one rather than failing a request over it.
    }
  }
  const id = randomUUID();
  driver.run(
    `INSERT INTO setting(key, graph_id, value_json, updated_at, hlc)
     VALUES (?, 'default', ?, ?, '')
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [KEY, JSON.stringify(id), Date.now()],
  );
  return id;
}
