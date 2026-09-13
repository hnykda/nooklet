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
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packageBundledPlugins } from "./bundled.js";
import { makePluginTestSetup, post, tmpDir } from "./plugin-test-helpers.js";

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
