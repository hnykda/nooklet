/**
 * The built-in plugins as the desktop sidecar ships them (B-180): bundled at build time by
 * `packageBundledPlugins`, then loaded from a READ-ONLY directory with nothing to resolve imports
 * against (a temp dir, outside every `node_modules`) — the two things the app bundle does not
 * have. The same three plugins, the same halves, and word-count's op answering, as
 * `./built-ins.test.ts` checks for the repo's sources.
 *
 * The whole path — `apps/desktop/build-sidecar.mjs` building a sidecar that a copy outside the repo
 * starts with its plugins — is `tools/probes/sidecar-plugins.mjs`.
 */
import { chmodSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packageBundledPlugins, packageHostModules } from "./bundled.js";
import { HOST_PROVIDED_SPECIFIERS, hostAliasMap, hostModuleFileName } from "./bundler.js";
import { makePluginTestSetup, post, tmpDir, writePluginFixture } from "./plugin-test-helpers.js";

const REPO_PLUGINS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "plugins",
);

function chmodTree(path: string, dirMode: number, fileMode: number): void {
  const isDir = statSync(path).isDirectory();
  if (isDir) for (const name of readdirSync(path)) chmodTree(join(path, name), dirMode, fileMode);
  chmodSync(path, isDir ? dirMode : fileMode);
}

let out: string;

beforeAll(async () => {
  out = join(tmpDir("nooklet-bundled-plugins-"), "plugins");
  const packaged = await packageBundledPlugins(REPO_PLUGINS_DIR, out);
  expect(packaged.map((p) => p.id).sort()).toEqual(["daily-summary", "mermaid", "word-count"]);
  // Read-only, like an app run from its disk image: a loader that bundles or writes fails here.
  chmodTree(out, 0o555, 0o444);
}, 60_000);

afterAll(() => chmodTree(out, 0o755, 0o644));

describe("bundled built-in plugins (B-180)", () => {
  it("load from a read-only directory with the same halves as the sources", async () => {
    const setup = await makePluginTestSetup([], [out]);
    const byId = Object.fromEntries(setup.host.list().map((p) => [p.id, p]));
    expect(byId["word-count"]).toMatchObject({
      status: "active",
      hasServer: true,
      hasClient: true,
    });
    expect(byId.mermaid).toMatchObject({ status: "active", hasServer: false, hasClient: true });
    expect(byId["daily-summary"]).toMatchObject({
      status: "active",
      hasServer: true,
      hasClient: false,
    });
    for (const name of readdirSync(out)) {
      expect(existsSync(join(out, name, ".nooklet-build"))).toBe(false);
    }
  });

  it("answer word-count's op, and serve a client half at its listed URL", async () => {
    const setup = await makePluginTestSetup([], [out]);
    await post(setup.app, "/api/v1/page.create", setup.writeToken, { name: "Bundled Count" });
    await post(setup.app, "/api/v1/page.append", setup.writeToken, {
      page: "Bundled Count",
      markdown: "- Buy milk\n- Call Anna about the API",
    });
    const count = await post(setup.app, "/api/v1/page.wordcount", setup.readToken, {
      page: "Bundled Count",
    });
    expect(count.status).toBe(200);
    expect(count.json).toMatchObject({ block_count: 2, word_count: 7 });

    const list = await setup.app.request("/api/v1/plugins", {
      headers: { authorization: `Bearer ${setup.readToken}` },
    });
    const plugins = ((await list.json()) as { plugins: Array<{ id: string; client_url: string }> })
      .plugins;
    const url = plugins.find((p) => p.id === "word-count")?.client_url;
    expect(url).toMatch(/^\/plugins\/word-count\/client\.[0-9a-f]{12}\.js$/);
    const js = await setup.app.request(url as string);
    expect(js.status).toBe(200);
    expect(await js.text()).toContain("word");
  });
});

// A plugin the USER writes, the documented way, loaded by a server that has no `node_modules` for
// its imports — the desktop sidecar (B-336). The sidecar resolves `@nooklet/plugin-api`, `zod` etc.
// to the files `packageHostModules` shipped, through `$NOOKLET_HOST_MODULES_DIR`; here those files
// are written to a temp dir, and the plugin's bundle is checked to have taken them from THERE —
// this package's own `node_modules` would otherwise satisfy the imports and prove nothing. The
// whole path, with a real sidecar copied out of the repo, is `tools/probes/sidecar-user-plugin.mjs`.
const USER_PLUGIN = `
import { defineOp, OpError } from "@nooklet/plugin-api";
import { z } from "zod";

export default {
  async activate(ctx) {
    ctx.ops.register(defineOp({
      name: "mine.echo",
      summary: "Echo",
      description: "Echoes back the given text.",
      input: z.object({ text: z.string() }).strict(),
      output: z.object({ text: z.string() }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      scopes: ["read"],
      expose: { http: true, mcp: true },
      render: (o) => o.text,
      async handler(input) {
        if (input.text === "fail") throw new OpError("not_found", "text was 'fail'", "try again");
        return { text: input.text };
      },
    }));
  },
};
`;

describe("a user's plugin where the host modules are shipped as files (B-336)", () => {
  let hostModules: string;
  const previous = process.env.NOOKLET_HOST_MODULES_DIR;

  beforeAll(async () => {
    hostModules = join(tmpDir("nooklet-host-modules-"), "host-modules");
    const written = await packageHostModules(hostModules);
    expect(written.map((f) => basename(f)).sort()).toEqual(
      HOST_PROVIDED_SPECIFIERS.map(hostModuleFileName).sort(),
    );
    process.env.NOOKLET_HOST_MODULES_DIR = hostModules;
  }, 60_000);

  afterAll(() => {
    if (previous === undefined) delete process.env.NOOKLET_HOST_MODULES_DIR;
    else process.env.NOOKLET_HOST_MODULES_DIR = previous;
  });

  it("aliases every host-provided import to the shipped file, not to node_modules", () => {
    const alias = hostAliasMap();
    for (const spec of HOST_PROVIDED_SPECIFIERS) {
      expect(alias[spec]).toBe(join(hostModules, hostModuleFileName(spec)));
    }
  });

  it("builds, activates, answers its op, and bridges its OpError", async () => {
    const root = tmpDir("nooklet-user-plugins-");
    const dir = writePluginFixture(
      root,
      "mine",
      { id: "mine", api: "1", server: "./src/server.ts" },
      { "src/server.ts": USER_PLUGIN },
    );
    const setup = await makePluginTestSetup([root]);
    expect(setup.host.list().find((p) => p.id === "mine")).toMatchObject({ status: "active" });

    const ok = await post(setup.app, "/api/v1/mine.echo", setup.readToken, { text: "hello" });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ text: "hello" });
    const failed = await post(setup.app, "/api/v1/mine.echo", setup.readToken, { text: "fail" });
    expect(failed.status).toBe(404);
    expect(failed.json.error.code).toBe("not_found");

    // Where the bundle got zod and the plugin API from: esbuild names each input file in a comment.
    const bundle = readFileSync(join(dir, ".nooklet-build", "server.mjs"), "utf8");
    expect(bundle).toContain(hostModuleFileName("zod"));
    expect(bundle).toContain(hostModuleFileName("@nooklet/plugin-api"));
    expect(bundle).not.toMatch(/node_modules\/(\.pnpm\/)?zod/);
  }, 60_000);
});
