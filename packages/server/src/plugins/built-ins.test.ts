/**
 * The three built-in plugins (`/plugins/word-count`, `/plugins/mermaid`, `/plugins/daily-summary`
 * at the repo root, M4's dogfooding requirement / exit criterion — PLAN §13) actually loading and
 * working, through the real loader (discovery -> esbuild bundling -> `import()` -> `activate()`),
 * not a mock of it.
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DataApi, ServerPluginContext } from "@nooklet/plugin-api";
import { describe, expect, it } from "vitest";
import { createServerContext } from "../apply-ops.js";
import { openDb } from "../db.js";
import { bundleServerEntry } from "./bundler.js";
import { makePluginTestSetup, post } from "./plugin-test-helpers.js";

// packages/server/src/plugins/built-ins.test.ts -> repo root's plugins/
const REPO_PLUGINS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "plugins",
);

describe("built-in plugins load from the repo root", () => {
  it("discovers and activates word-count, mermaid, and daily-summary", async () => {
    const setup = await makePluginTestSetup([REPO_PLUGINS_DIR]);
    const list = setup.host.list();
    const byId = Object.fromEntries(list.map((p) => [p.id, p]));

    expect(byId["word-count"]?.status).toBe("active");
    expect(byId["word-count"]?.hasServer).toBe(true);
    expect(byId["word-count"]?.hasClient).toBe(true);

    expect(byId.mermaid?.status).toBe("active");
    expect(byId.mermaid?.hasServer).toBe(false);
    expect(byId.mermaid?.hasClient).toBe(true);

    expect(byId["daily-summary"]?.status).toBe("active");
    expect(byId["daily-summary"]?.hasServer).toBe(true);
    expect(byId["daily-summary"]?.hasClient).toBe(false);
  });
});

describe("word-count", () => {
  async function makePageWithContent(setup: Awaited<ReturnType<typeof makePluginTestSetup>>) {
    const create = await post(setup.app, "/api/v1/page.create", setup.writeToken, {
      name: "Word Count Fixture",
    });
    expect(create.status).toBe(200);
    await post(setup.app, "/api/v1/page.append", setup.writeToken, {
      page: "Word Count Fixture",
      markdown: "- Buy milk\n- Call Anna about the API\n  - decided: RPC over HTTP",
    });
  }

  it("counts words over HTTP, matching the manual walk", async () => {
    const setup = await makePluginTestSetup([REPO_PLUGINS_DIR]);
    await makePageWithContent(setup);

    const { status, json } = await post(setup.app, "/api/v1/page.wordcount", setup.readToken, {
      page: "Word Count Fixture",
    });
    expect(status).toBe(200);
    expect(json.page).toBe("Word Count Fixture");
    // "Buy milk" (2) + "Call Anna about the API" (5) + "decided: RPC over HTTP" (4) = 11 words,
    // across 3 blocks (the spec's worked example uses similar but not identical fixture content).
    expect(json.block_count).toBe(3);
    expect(json.word_count).toBe(11);
  });

  it("resolves 'today' via pages.journal, not just a literal page name", async () => {
    const setup = await makePluginTestSetup([REPO_PLUGINS_DIR]);
    await post(setup.app, "/api/v1/page.append", setup.writeToken, {
      page: "today",
      markdown: "one two three",
    });
    const { status, json } = await post(setup.app, "/api/v1/page.wordcount", setup.readToken, {
      page: "today",
    });
    expect(status).toBe(200);
    expect(json.word_count).toBeGreaterThanOrEqual(3);
  });

  it("returns not_found with a hint for a nonexistent page", async () => {
    const setup = await makePluginTestSetup([REPO_PLUGINS_DIR]);
    const { status, json } = await post(setup.app, "/api/v1/page.wordcount", setup.readToken, {
      page: "Never Existed Ever",
    });
    expect(status).toBe(404);
    expect(json.error.code).toBe("not_found");
  });

  it("is exposed as the page_wordcount MCP tool", async () => {
    const setup = await makePluginTestSetup([REPO_PLUGINS_DIR]);
    const { mcpRpc } = await import("./plugin-test-helpers.js");
    const list = await mcpRpc(setup.app, setup.readToken, "tools/list", {});
    const names = list.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("page_wordcount");
  });

  it("bundles a client entry servable from /plugins/word-count/client.<hash>.js", async () => {
    const setup = await makePluginTestSetup([REPO_PLUGINS_DIR]);
    const info = setup.host.list().find((p) => p.id === "word-count");
    expect(info?.clientUrl).toMatch(/^\/plugins\/word-count\/client\.[0-9a-f]{12}\.js$/);
    const res = await setup.app.request(info?.clientUrl as string);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const body = await res.text();
    expect(body).toContain("registerStatusItem");
  });
});

describe("mermaid", () => {
  it("bundles a client-only entry that registers the mermaid code-block renderer", async () => {
    const setup = await makePluginTestSetup([REPO_PLUGINS_DIR]);
    const info = setup.host.list().find((p) => p.id === "mermaid");
    expect(info?.clientUrl).toBeTruthy();
    const res = await setup.app.request(info?.clientUrl as string);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("registerCodeBlockRenderer");
    // No "mermaid" npm dependency: the real library is fetched from a CDN via a non-literal
    // `import()` at render time, so the CDN URL string appears in the bundle, but nothing named
    // "mermaid" was ever resolved as an npm package at bundle time.
    expect(body).toContain("cdn.jsdelivr.net");
  });
});

describe("daily-summary", () => {
  async function loadDailySummaryModule() {
    const entry = join(REPO_PLUGINS_DIR, "daily-summary", "src", "server.ts");
    const bundle = await bundleServerEntry(entry, join(REPO_PLUGINS_DIR, "daily-summary"));
    return import(`${pathToFileURL(bundle.file).href}?v=${bundle.hash}`);
  }

  it("registers nothing when disabled (the default) — never surprises anyone", async () => {
    const mod = await loadDailySummaryModule();
    let jobRegistered = false;
    const fakeCtx = {
      settings: { get: () => ({}) },
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
      registerJob: () => {
        jobRegistered = true;
        return { dispose() {} };
      },
    } as unknown as ServerPluginContext;
    await mod.default.activate(fakeCtx);
    expect(jobRegistered).toBe(false);
  });

  it("registers the job when explicitly enabled via settings", async () => {
    const mod = await loadDailySummaryModule();
    let jobRegistered = false;
    const fakeCtx = {
      settings: { get: () => ({ enabled: true }) },
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
      registerJob: (job: { cron?: string }) => {
        jobRegistered = true;
        expect(job.cron).toBeTruthy();
        return { dispose() {} };
      },
    } as unknown as ServerPluginContext;
    await mod.default.activate(fakeCtx);
    expect(jobRegistered).toBe(true);
  });

  it("runDailySummary appends exactly one summary block per journal day (idempotent via kv)", async () => {
    const mod = await loadDailySummaryModule();
    const serverCtx = createServerContext(openDb({ path: ":memory:" }));
    const { createDataApi } = await import("../data-api.js");
    const data: DataApi = createDataApi(serverCtx, {
      origin: "plugin",
      actor: "plugin:daily-summary",
    });
    const { kvGet, kvSet } = await import("./kv.js");
    const kv: ServerPluginContext["kv"] = {
      get: async (k) => kvGet(serverCtx.driver, "daily-summary", k),
      set: async (k, v) => kvSet(serverCtx.driver, "daily-summary", k, v),
      delete: async () => {},
      list: async () => [],
    };
    const log = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };

    const today = await data.pages.journal("today", { create: true });
    if (!today) throw new Error('journal("today", { create: true }) unexpectedly returned null');
    await data.blocks.insert({ page: today.id, content: "did a thing" });

    const first = await mod.runDailySummary(data, kv, log);
    expect(first.wrote).toBe(true);
    expect(first.blockCount).toBe(1);

    const second = await mod.runDailySummary(data, kv, log);
    expect(second.wrote).toBe(false); // kv guard: already summarized today

    const tree = await data.blocks.tree({ page: today.id });
    const summaryBlocks = tree.filter((b) => b.content.startsWith("Daily summary:"));
    expect(summaryBlocks).toHaveLength(1);
  });
});
