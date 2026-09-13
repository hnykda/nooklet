/**
 * Where a plugin's client bundle lands (B-181). It used to be a fresh `mkdtemp` directory per
 * activation that nothing removed — 2,063 of them had piled up in one developer's `$TMPDIR` — which
 * stopped being harmless once a client half could bundle a real library (mermaid: 12 MB per copy).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundleClientEntry } from "./bundler.js";
import { tmpDir, writePluginFixture } from "./plugin-test-helpers.js";

const CLIENT = `export default { activate(ctx) { ctx.log.info("hello from the client half"); } };\n`;

describe("bundleClientEntry (B-181)", () => {
  it("writes into the plugin's own .nooklet-build, content-addressed, never a temp dir per call", async () => {
    const dir = writePluginFixture(
      tmpDir("nooklet-bundler-test-"),
      "hello",
      { id: "hello", api: "1", client: "./src/client.ts" },
      { "src/client.ts": CLIENT },
    );
    const entry = join(dir, "src", "client.ts");

    const first = await bundleClientEntry(entry, dir);
    const second = await bundleClientEntry(entry, dir);

    expect(first.file).toBe(join(dir, ".nooklet-build", `client.${first.hash}.js`));
    // Same source, same bytes, same file: re-activating (every server start, every reload) adds
    // nothing on disk.
    expect(second.file).toBe(first.file);
    expect(readdirSync(join(dir, ".nooklet-build")).filter((f) => f.startsWith("client."))).toEqual(
      [`client.${first.hash}.js`],
    );
    expect(existsSync(first.file)).toBe(true);
    expect(readFileSync(first.file, "utf8")).toContain("hello from the client half");
  });
});
