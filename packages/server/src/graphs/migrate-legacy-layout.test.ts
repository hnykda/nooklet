import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrateLegacyLayoutIfNeeded } from "./migrate-legacy-layout.js";
import { graphDbPath, graphsRootDir } from "./paths.js";

function makeLegacyDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "nooklet-legacy-layout-test-"));
  writeFileSync(join(dir, "graph.sqlite"), "not a real sqlite file, content doesn't matter here");
  mkdirSync(join(dir, "pages"));
  writeFileSync(join(dir, "pages", "index.md"), "# Index");
  mkdirSync(join(dir, "journals"));
  writeFileSync(join(dir, "journals", "2026-09-15.md"), "# 2026-09-15");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "abc123.png"), "fake png bytes");
  return dir;
}

describe("migrateLegacyLayoutIfNeeded", () => {
  it("folds a flat data dir into graphs/default/, moving the db, mirror, and assets together", () => {
    const dataDir = makeLegacyDataDir();

    const result = migrateLegacyLayoutIfNeeded(dataDir);

    expect(result).toEqual({ migrated: true, graphId: "default" });
    expect(existsSync(join(dataDir, "graph.sqlite"))).toBe(false);
    expect(existsSync(join(dataDir, "pages"))).toBe(false);
    expect(existsSync(graphDbPath(dataDir, "default"))).toBe(true);
    expect(readFileSync(join(graphsRootDir(dataDir), "default", "graph.sqlite"), "utf8")).toContain(
      "not a real sqlite file",
    );
    expect(readFileSync(join(graphsRootDir(dataDir), "default", "pages", "index.md"), "utf8")).toBe(
      "# Index",
    );
    expect(
      readFileSync(join(graphsRootDir(dataDir), "default", "journals", "2026-09-15.md"), "utf8"),
    ).toBe("# 2026-09-15");
    expect(
      readFileSync(join(graphsRootDir(dataDir), "default", "assets", "abc123.png"), "utf8"),
    ).toBe("fake png bytes");
  });

  it("is a no-op once graphs/ already exists", () => {
    const dataDir = makeLegacyDataDir();
    migrateLegacyLayoutIfNeeded(dataDir);

    // A second call, and a call against a dir that never had the legacy layout, both do nothing.
    expect(migrateLegacyLayoutIfNeeded(dataDir)).toEqual({ migrated: false });
  });

  it("does nothing to a data dir that never had the legacy layout (a brand-new install)", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nooklet-fresh-test-"));
    expect(migrateLegacyLayoutIfNeeded(dataDir)).toEqual({ migrated: false });
    expect(existsSync(graphsRootDir(dataDir))).toBe(false);
  });

  it("tolerates a legacy layout with no mirror/assets directories yet (a graph never exported)", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nooklet-legacy-bare-test-"));
    writeFileSync(join(dataDir, "graph.sqlite"), "bytes");

    const result = migrateLegacyLayoutIfNeeded(dataDir);

    expect(result).toEqual({ migrated: true, graphId: "default" });
    expect(existsSync(graphDbPath(dataDir, "default"))).toBe(true);
  });
});
