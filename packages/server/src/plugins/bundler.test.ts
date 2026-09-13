/**
 * Where a plugin's client bundle lands (B-181). It used to be a fresh `mkdtemp` directory per
 * activation that nothing removed — 2,063 of them had piled up in one developer's `$TMPDIR` — which
 * stopped being harmless once a client half could bundle a real library (mermaid: 12 MB per copy).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bundleClientEntry } from "./bundler.js";
import { makePluginTestSetup, tmpDir, writePluginFixture } from "./plugin-test-helpers.js";

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

describe("a client half that fails to bundle (B-186)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is bundled once per activation, however often its unauthenticated URL is requested", async () => {
    const root = tmpDir("nooklet-bundler-broken-");
    writePluginFixture(
      root,
      "broken-client",
      { id: "broken-client", api: "1", client: "./src/client.ts" },
      { "src/client.ts": `import "./does-not-exist.js";\nexport default { activate() {} };\n` },
    );
    const setup = await makePluginTestSetup([root]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const statuses: number[] = [];
    const bodies: string[] = [];
    for (let i = 0; i < 3; i++) {
      // No token: this route sits before the auth gate (a <script src> cannot carry one).
      const res = await setup.app.request("/plugins/broken-client/client.000000000000.js");
      statuses.push(res.status);
      bodies.push(await res.text());
    }

    expect(statuses).toEqual([500, 500, 500]);
    // esbuild ran once: every attempt logs exactly one "failed to bundle".
    const bundleFailures = errors.mock.calls.filter((args) =>
      args.some((a) => typeof a === "string" && a.includes("client half failed to bundle")),
    );
    expect(bundleFailures).toHaveLength(1);
    // The details are in the server log, not handed to whoever asked: esbuild's message names
    // absolute paths on the server's disk.
    for (const body of bodies) expect(body).not.toContain(root);
  });
});
