/**
 * B-607: a graph's database must always have its `graph.json`, whichever path created it, and a
 * data dir already left without one must recover. The CLI-level orders (import -> serve,
 * token create -> serve) are run for real in `../cli-first-run.test.ts`.
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRegistry } from "../ops/index.js";
import { openGraph } from "./open-graph.js";
import { graphDbPath, graphMetaPath } from "./paths.js";
import { GraphRegistry, GraphSelectionError, openGraphForCommand } from "./registry.js";

const base = { timezone: "UTC", port: 0, mirror: { enabled: false } };

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), "nooklet-registry-test-"));
}

describe("graph.json is written by every path that creates a graph (B-607)", () => {
  it("openGraphForCommand creates the default graph WITH its graph.json", () => {
    const dir = freshDataDir();
    openGraphForCommand(dir, "default", base);
    expect(existsSync(graphDbPath(dir, "default"))).toBe(true);
    const meta = JSON.parse(readFileSync(graphMetaPath(dir, "default"), "utf8"));
    expect(meta).toMatchObject({ id: "default", label: "default" });
  });

  it("then the registry lists it, so serve's create('default') bootstrap is skipped", async () => {
    const dir = freshDataDir();
    openGraphForCommand(dir, "default", base);
    const registry = new GraphRegistry(dir, { registry: buildRegistry(), baseConfig: base });
    expect((await registry.list()).map((g) => g.id)).toEqual(["default"]);
  });

  it("refuses to create a graph other than default — a --graph typo must not make a new graph", () => {
    const dir = freshDataDir();
    expect(() => openGraphForCommand(dir, "work", base)).toThrow(GraphSelectionError);
    expect(existsSync(graphDbPath(dir, "work"))).toBe(false);
    expect(() => openGraphForCommand(dir, "Not Valid", base)).toThrow(GraphSelectionError);
  });

  it("adopts a database left with no graph.json (a data dir already in B-607's state recovers)", async () => {
    const dir = freshDataDir();
    // Exactly what `import`/`token create` used to do: open the database directly.
    openGraph(dir, "default", base);
    expect(existsSync(graphMetaPath(dir, "default"))).toBe(false);
    const registry = new GraphRegistry(dir, { registry: buildRegistry(), baseConfig: base });
    expect((await registry.list()).map((g) => g.id)).toEqual(["default"]);
    expect(existsSync(graphMetaPath(dir, "default"))).toBe(true);
    await expect(registry.create("default")).rejects.toThrow(/already exists/);
    expect(await registry.resolve("default")).toBeDefined();
  });

  it("create() still records the label it was given", async () => {
    const dir = freshDataDir();
    const registry = new GraphRegistry(dir, { registry: buildRegistry(), baseConfig: base });
    await registry.create("work", "Work notes");
    expect(await registry.list()).toEqual([
      expect.objectContaining({ id: "work", label: "Work notes" }),
    ]);
  });
});
