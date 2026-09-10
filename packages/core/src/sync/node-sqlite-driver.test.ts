/**
 * `SqlDriver.savepoint()` (`./driver.ts`'s `Savepoint`) and its interaction with `transaction()`'s
 * shared `depth` counter — the mechanism `packages/server/src/ops/dry-run.ts` and `./batch.ts`
 * rely on instead of cloning the whole database for trial execution (see those files' header
 * comments). A plain ad hoc table is enough here; none of this needs vrite's real schema.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { SqlDriver } from "./driver.js";
import { createNodeSqliteDriver } from "./node-sqlite-driver.js";

function newDb(): SqlDriver {
  const driver = createNodeSqliteDriver(new DatabaseSync(":memory:"));
  driver.exec("CREATE TABLE t(v TEXT)");
  return driver;
}

let driver: SqlDriver;

beforeEach(() => {
  driver = newDb();
});

function values(): string[] {
  return driver.all<{ v: string }>("SELECT v FROM t ORDER BY v").map((r) => r.v);
}

describe("savepoint()", () => {
  it("release() commits, even opened at depth 0 with no wrapping transaction()", () => {
    const sp = driver.savepoint();
    driver.run("INSERT INTO t VALUES ('a')");
    sp.release();
    expect(values()).toEqual(["a"]);
  });

  it("rollback() undoes everything since savepoint(), even opened at depth 0", () => {
    driver.run("INSERT INTO t VALUES ('before')");
    const sp = driver.savepoint();
    driver.run("INSERT INTO t VALUES ('during')");
    sp.rollback();
    expect(values()).toEqual(["before"]);
  });

  it("release() and rollback() are each idempotent, including calling the other afterward", () => {
    const sp = driver.savepoint();
    driver.run("INSERT INTO t VALUES ('a')");
    sp.release();
    expect(() => sp.release()).not.toThrow();
    expect(() => sp.rollback()).not.toThrow(); // must NOT undo the already-committed release
    expect(values()).toEqual(["a"]);

    const sp2 = driver.savepoint();
    driver.run("INSERT INTO t VALUES ('b')");
    sp2.rollback();
    expect(() => sp2.rollback()).not.toThrow();
    expect(() => sp2.release()).not.toThrow(); // must NOT resurrect the rolled-back 'b'
    expect(values()).toEqual(["a"]);
  });

  it("a nested transaction() call sees depth > 0 and composes instead of issuing a conflicting BEGIN", () => {
    const sp = driver.savepoint();
    // Two SEPARATE transaction() calls while the savepoint is open -- exactly the shape of a
    // handler that calls ctx.applyOps (each a driver.transaction() call) more than once inside
    // one dry_run/batch trial. A driver that issued a real BEGIN here would make node:sqlite throw
    // "cannot start a transaction within a transaction" before this test could get any further.
    driver.transaction(() => driver.run("INSERT INTO t VALUES ('x')"));
    driver.transaction(() => driver.run("INSERT INTO t VALUES ('y')"));
    expect(values()).toEqual(["x", "y"]);
    sp.rollback();
    expect(values()).toEqual([]); // rolling back the savepoint undoes both nested transactions
  });

  it("a failing nested transaction() does not partially commit -- only the savepoint decides the outcome", () => {
    const sp = driver.savepoint();
    driver.run("INSERT INTO t VALUES ('kept')");
    expect(() =>
      driver.transaction(() => {
        driver.run("INSERT INTO t VALUES ('doomed')");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    // transaction() only issues ROLLBACK at depth 0 (see its own doc); nested inside an open
    // savepoint it just decrements depth and rethrows, leaving the outcome to the savepoint --
    // exactly what lets batch.ts catch a failed step and roll back the WHOLE trial itself.
    expect(values()).toEqual(["doomed", "kept"]);
    sp.rollback();
    expect(values()).toEqual([]);
  });

  it("uses unique, non-colliding names for sequential savepoints", () => {
    const sp1 = driver.savepoint();
    driver.run("INSERT INTO t VALUES ('one')");
    sp1.release();
    const sp2 = driver.savepoint();
    driver.run("INSERT INTO t VALUES ('two')");
    sp2.release();
    expect(values()).toEqual(["one", "two"]);
  });

  it("nests correctly inside an already-open transaction(), and inside itself", () => {
    driver.transaction(() => {
      driver.run("INSERT INTO t VALUES ('outer')");
      const inner = driver.savepoint();
      driver.run("INSERT INTO t VALUES ('inner')");
      inner.rollback();
      driver.run("INSERT INTO t VALUES ('after-inner-rollback')");
    });
    expect(values()).toEqual(["after-inner-rollback", "outer"]);
  });
});
