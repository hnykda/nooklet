import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverPlugins } from "./manifest.js";
import { tmpDir, writePluginFixture } from "./plugin-test-helpers.js";

describe("discoverPlugins", () => {
  it("discovers a valid plugin and resolves its server/client entries", () => {
    const root = tmpDir("nooklet-manifest-test-");
    const dir = writePluginFixture(
      root,
      "ok-plugin",
      { id: "ok-plugin", api: "1", server: "./src/server.ts", client: "./src/client.ts" },
      {
        "src/server.ts": "export default { activate() {} };\n",
        "src/client.ts": "export default { activate() {} };\n",
      },
    );

    const { found, errors } = discoverPlugins([root]);
    expect(errors).toEqual([]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      id: "ok-plugin",
      version: "0.1.0",
      serverEntry: join(dir, "src", "server.ts"),
      clientEntry: join(dir, "src", "client.ts"),
    });
  });

  it("rejects a manifest missing both server and client (rule 14), without throwing", () => {
    const root = tmpDir("nooklet-manifest-test-");
    writePluginFixture(root, "neither-half", { id: "neither-half", api: "1" });

    const { found, errors } = discoverPlugins([root]);
    expect(found).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/at least one of server\/client/);
  });

  it("rejects an unknown id shape without throwing", () => {
    const root = tmpDir("nooklet-manifest-test-");
    writePluginFixture(
      root,
      "Bad_Id",
      { id: "Bad_Id", api: "1", server: "./s.ts" },
      {
        "s.ts": "export default { activate() {} };\n",
      },
    );

    const { found, errors } = discoverPlugins([root]);
    expect(found).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/"id" must match/);
  });

  it("marks an incompatible api major as an error, never aborting discovery of other plugins", () => {
    const root = tmpDir("nooklet-manifest-test-");
    writePluginFixture(
      root,
      "future-api",
      { id: "future-api", api: "2", server: "./s.ts" },
      {
        "s.ts": "export default { activate() {} };\n",
      },
    );
    writePluginFixture(
      root,
      "fine",
      { id: "fine", api: "1", server: "./s.ts" },
      {
        "s.ts": "export default { activate() {} };\n",
      },
    );

    const { found, errors } = discoverPlugins([root]);
    // "api": "2" fails validateManifest's own literal-"1" check before assertApiSupported even
    // runs (manifest.ts's PluginManifest["api"] type is fixed at "1") — still surfaced as a
    // discovery error, not a thrown exception, and "fine" loads regardless.
    expect(errors.some((e) => e.message.includes("api"))).toBe(true);
    expect(found.map((p) => p.id)).toEqual(["fine"]);
  });

  it("reports a duplicate plugin id across two directories as an error, keeping the first", () => {
    const rootA = tmpDir("nooklet-manifest-test-a-");
    const rootB = tmpDir("nooklet-manifest-test-b-");
    writePluginFixture(
      rootA,
      "dup",
      { id: "dup", api: "1", server: "./s.ts" },
      {
        "s.ts": "export default { activate() {} };\n",
      },
    );
    writePluginFixture(
      rootB,
      "dup",
      { id: "dup", api: "1", server: "./s.ts" },
      {
        "s.ts": "export default { activate() {} };\n",
      },
    );

    const { found, errors } = discoverPlugins([rootA, rootB]);
    expect(found).toHaveLength(1);
    expect(found[0]?.dir).toBe(join(rootA, "dup"));
    expect(errors.some((e) => e.message.includes("duplicate plugin id"))).toBe(true);
  });

  it("skips a directory with no package.json, and a nonexistent root, without error", () => {
    const root = tmpDir("nooklet-manifest-test-");
    mkdirSync(join(root, "not-a-plugin"), { recursive: true });
    writeFileSync(join(root, "not-a-plugin", "README.md"), "just a folder\n");

    const { found, errors } = discoverPlugins([root, join(root, "does-not-exist")]);
    expect(found).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("single-file *.plugin.ts entries are not scanned (package form only, v1 loader scope)", () => {
    const root = tmpDir("nooklet-manifest-test-");
    writeFileSync(join(root, "quick.plugin.ts"), "export default { id: 'quick', api: '1' };\n");
    const { found, errors } = discoverPlugins([root]);
    expect(found).toEqual([]);
    expect(errors).toEqual([]);
  });
});
