/**
 * In-app Logseq import (ADR 031) over the real HTTP routes: scopes, the two targets and their
 * rules, chunked upload, cancel, and that the result matches what `nooklet import` makes of the
 * same files.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServerContext } from "../apply-ops.js";
import { verifyToken } from "../auth/tokens.js";
import { openDb } from "../db.js";
import { graphDbPath, graphMetaPath } from "../graphs/paths.js";
import { attachImportService, ImportService } from "../importer/jobs.js";
import { importLogseqGraph } from "../importer/logseq.js";
import { writeFixtureDbGraph } from "../importer/logseq-db-fixture.js";
import { fixtureGraphFiles, rawZip, storeZip } from "../importer/zip-test-helpers.js";
import { type JsonAny, makeTestServer, post } from "../test-helpers.js";

const services: ImportService[] = [];

/** Every file under `dir`, relative, `/`-separated. */
function walk(dir: string, rel = ""): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? walk(dir, r) : [r];
  });
}
afterEach(() => {
  for (const s of services.splice(0)) s.dispose();
});

function setup(opts: { maxUploadBytes?: number } = {}) {
  const s = makeTestServer();
  const root = mkdtempSync(join(tmpdir(), "nooklet-import-root-"));
  const service = new ImportService({
    rootDataDir: root,
    baseConfig: { timezone: "UTC", port: 0, mirror: { enabled: false } },
    maxUploadBytes: opts.maxUploadBytes,
  });
  services.push(service);
  attachImportService(s.serverCtx, s.config, service);
  return { ...s, root, service };
}

type Setup = ReturnType<typeof setup>;

async function waitFinished(s: Setup, token: string, jobId: string): Promise<JsonAny> {
  for (let i = 0; i < 400; i++) {
    const st = await post(s.app, "/api/v1/import.status", token, { job_id: jobId });
    if (["done", "failed", "cancelled"].includes(st.json.state)) return st.json;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("import never finished");
}

async function upload(
  s: Setup,
  zip: Buffer,
  target: { target: "new"; graph_id: string; label?: string } | { target: "current" },
  token = s.adminToken,
): Promise<JsonAny> {
  const begun = await post(s.app, "/api/v1/import.begin", token, {
    ...target,
    byte_size: zip.length,
  });
  expect(begun.status, JSON.stringify(begun.json)).toBe(200);
  const jobId = begun.json.job_id as string;
  // Small chunks on purpose, so a multi-chunk upload is what is tested.
  const step = 1000;
  for (let o = 0; o < zip.length; o += step) {
    const c = await post(s.app, "/api/v1/import.chunk", token, {
      job_id: jobId,
      offset: o,
      data_base64: zip.subarray(o, o + step).toString("base64"),
    });
    expect(c.status, JSON.stringify(c.json)).toBe(200);
  }
  const started = await post(s.app, "/api/v1/import.start", token, {
    job_id: jobId,
    byte_size: zip.length,
  });
  expect(started.status, JSON.stringify(started.json)).toBe(200);
  return waitFinished(s, token, jobId);
}

/** What `nooklet import` makes of the same files: the comparison the e2e also draws. */
async function cliCounts(files: Record<string, string | Uint8Array>) {
  const dir = mkdtempSync(join(tmpdir(), "nooklet-import-cli-"));
  for (const [rel, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), data);
  }
  const ctx = createServerContext(openDb({ path: ":memory:" }));
  const data = mkdtempSync(join(tmpdir(), "nooklet-import-cli-data-"));
  return importLogseqGraph(ctx, dir, { dataDir: data });
}

describe("import.* scopes", () => {
  it("needs admin: a write or read token is refused, with no job created", async () => {
    const s = setup();
    for (const token of [s.writeToken, s.readToken]) {
      const calls: Array<[string, unknown]> = [
        ["import.info", {}],
        ["import.begin", { target: "current" }],
        ["import.status", { job_id: "x" }],
      ];
      for (const [op, body] of calls) {
        const r = await post(s.app, `/api/v1/${op}`, token, body);
        expect(r.status, op).toBe(403);
      }
    }
    expect(s.service.active()).toBeUndefined();
    const ok = await post(s.app, "/api/v1/import.info", s.adminToken, {});
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ chunk_bytes: 4 * 1024 * 1024, current_graph: { empty: true } });
  });

  it("is not offered over MCP", () => {
    const s = setup();
    const op = s.registry.get("import.begin");
    expect(op?.expose?.mcp).toBe(false);
  });

  it("answers 'not available' on a graph opened without the service", async () => {
    const s = makeTestServer();
    const r = await post(s.app, "/api/v1/import.info", s.adminToken, {});
    expect(r.status).toBe(404);
    expect(r.json.error.message).toMatch(/not available/);
  });
});

describe("import into a new graph", () => {
  it("creates the graph whole, with counts matching the CLI import, and hands back a token", async () => {
    const s = setup();
    const job = await upload(s, storeZip(fixtureGraphFiles("Some graph/")), {
      target: "new",
      graph_id: "garden",
      label: "Garden",
    });
    expect(job.state, job.message).toBe("done");
    const cli = await cliCounts(fixtureGraphFiles());
    expect(job.result).toMatchObject({
      pages: cli.pagesImported,
      journals: cli.journalsImported,
      blocks: cli.blocksImported,
      assets: cli.assetsImported,
      referenced_pages: cli.referencedPagesCreated,
      dangling_block_refs: cli.danglingBlockRefs,
      verify: { ok: true, divergences: 0 },
    });
    expect(job.result.pages).toBe(2);
    expect(job.result.journals).toBe(1);
    expect(job.result.assets).toBe(1);
    // The journal-format note the CLI prints is in the summary too.
    expect(job.result.warnings.join("\n")).toMatch(/EEE, dd\.MM\.yyyy/);

    expect(JSON.parse(readFileSync(graphMetaPath(s.root, "garden"), "utf8"))).toMatchObject({
      id: "garden",
      label: "Garden",
    });
    const db = openDb({ path: graphDbPath(s.root, "garden") });
    expect(verifyToken(db, job.graph.token)).toMatchObject({ scope: "admin", canSync: true });
    expect(existsSync(join(s.root, "import-staging", job.job_id))).toBe(false);
    // The source graph was not touched.
    expect(s.serverCtx.driver.get<{ n: number }>("SELECT count(*) AS n FROM page")?.n).toBe(0);
  });

  it("refuses an existing or invalid graph id before any upload", async () => {
    const s = setup();
    mkdirSync(join(s.root, "graphs", "taken"), { recursive: true });
    const taken = await post(s.app, "/api/v1/import.begin", s.adminToken, {
      target: "new",
      graph_id: "taken",
    });
    expect(taken.status).toBe(409);
    const bad = await post(s.app, "/api/v1/import.begin", s.adminToken, {
      target: "new",
      graph_id: "../escape",
    });
    expect(bad.status).toBe(400);
  });

  it("a hostile zip fails the job and creates no graph", async () => {
    const s = setup();
    const job = await upload(
      s,
      rawZip([
        { name: "pages/A.md", data: "- ok" },
        { name: "../../escaped.md", data: "- pwned" },
      ]),
      { target: "new", graph_id: "evil" },
    );
    expect(job.state).toBe("failed");
    expect(job.message).toMatch(/unsafe|damaged/);
    expect(existsSync(join(s.root, "graphs", "evil"))).toBe(false);
    expect(existsSync(join(s.root, "..", "escaped.md"))).toBe(false);
  });

  it("cancelling leaves nothing behind", async () => {
    const s = setup();
    const files: Record<string, string> = {};
    for (let i = 0; i < 400; i++) files[`pages/Page ${i}.md`] = `- block ${i}\n  - child\n`;
    const zip = storeZip(files);
    const begun = await post(s.app, "/api/v1/import.begin", s.adminToken, {
      target: "new",
      graph_id: "big",
    });
    const jobId = begun.json.job_id;
    await post(s.app, "/api/v1/import.chunk", s.adminToken, {
      job_id: jobId,
      offset: 0,
      data_base64: zip.toString("base64"),
    });
    await post(s.app, "/api/v1/import.start", s.adminToken, {
      job_id: jobId,
      byte_size: zip.length,
    });
    const c = await post(s.app, "/api/v1/import.cancel", s.adminToken, { job_id: jobId });
    expect(c.status).toBe(200);
    const job = await waitFinished(s, s.adminToken, jobId);
    expect(job.state).toBe("cancelled");
    expect(existsSync(join(s.root, "graphs", "big"))).toBe(false);
    expect(existsSync(join(s.root, "import-staging", jobId))).toBe(false);
  });
});

describe("import a DB-version graph through the app", () => {
  it("detects the format and brings its images and favourites, like the CLI", async () => {
    const s = setup();
    const src = mkdtempSync(join(tmpdir(), "nooklet-import-dbgraph-"));
    writeFixtureDbGraph(src);
    // A zip of the graph folder, plus what must be left behind (shm, a backup copy).
    const files: Record<string, Uint8Array> = {};
    for (const rel of walk(src)) files[`My DB graph/${rel}`] = readFileSync(join(src, rel));
    files["My DB graph/db.sqlite-shm"] = new Uint8Array(8);
    files["My DB graph/backups/db.sqlite"] = new Uint8Array(8);
    const job = await upload(s, storeZip(files), { target: "new", graph_id: "dbgraph" });
    expect(job.state, job.message).toBe("done");

    const cliCtx = createServerContext(openDb({ path: ":memory:" }));
    const cli = await importLogseqGraph(cliCtx, src, {
      dataDir: mkdtempSync(join(tmpdir(), "nooklet-import-dbcli-")),
    });
    expect(cli.format).toBe("db");
    expect(job.result).toMatchObject({
      format: "db",
      pages: cli.pagesImported,
      journals: cli.journalsImported,
      blocks: cli.blocksImported,
      assets: cli.assetsImported,
      favorites: cli.favoritesMarked,
      verify: { ok: true },
    });
    expect(job.result.assets).toBeGreaterThan(0);
    expect(job.result.favorites).toBeGreaterThan(0);
    // The image block points at an imported asset in the new graph.
    const db = openDb({ path: graphDbPath(s.root, "dbgraph") });
    const image = db.get<{ content: string }>(
      "SELECT content FROM block WHERE content LIKE '![%' AND deleted_at IS NULL",
    );
    expect(image?.content).toMatch(/\]\(assets\/[0-9a-z]+\.png\)$/);
  });
});

describe("import into the current graph", () => {
  it("imports into an empty graph, even one with an untouched journal page", async () => {
    const s = setup();
    // Today's journal opened once: a page with one empty block. Not content.
    await post(s.app, "/api/v1/page.create", s.adminToken, { name: "2026-10-01" });
    const files = fixtureGraphFiles();
    const job = await upload(s, storeZip(files), { target: "current" });
    expect(job.state, job.message).toBe("done");
    const cli = await cliCounts(files);
    expect(job.result).toMatchObject({
      pages: cli.pagesImported,
      journals: cli.journalsImported,
      blocks: cli.blocksImported,
      verify: { ok: true },
    });
    expect(job.result.errors).toEqual([]);
    expect(job.graph).toBeNull();
  });

  it("refuses a graph that has content, and changes nothing", async () => {
    const s = setup();
    await post(s.app, "/api/v1/page.create", s.adminToken, {
      name: "Mine",
      markdown: "- something I wrote",
    });
    const before = s.serverCtx.driver.get<{ n: number }>("SELECT count(*) AS n FROM op")?.n;
    const r = await post(s.app, "/api/v1/import.begin", s.adminToken, { target: "current" });
    expect(r.status).toBe(409);
    expect(r.json.error.message).toMatch(/not empty/);
    const info = await post(s.app, "/api/v1/import.info", s.adminToken, {});
    expect(info.json.current_graph.empty).toBe(false);
    expect(s.serverCtx.driver.get<{ n: number }>("SELECT count(*) AS n FROM op")?.n).toBe(before);
  });
});

describe("import upload rules", () => {
  it("accepts a resent chunk, refuses a gap, and refuses a short start", async () => {
    const s = setup();
    const begun = await post(s.app, "/api/v1/import.begin", s.adminToken, {
      target: "new",
      graph_id: "chunks",
    });
    const job_id = begun.json.job_id;
    const data_base64 = Buffer.from("abcd").toString("base64");
    expect(
      (await post(s.app, "/api/v1/import.chunk", s.adminToken, { job_id, offset: 0, data_base64 }))
        .status,
    ).toBe(200);
    const again = await post(s.app, "/api/v1/import.chunk", s.adminToken, {
      job_id,
      offset: 0,
      data_base64,
    });
    expect(again.json.bytes_received).toBe(4);
    const gap = await post(s.app, "/api/v1/import.chunk", s.adminToken, {
      job_id,
      offset: 10,
      data_base64,
    });
    expect(gap.status).toBe(400);
    const short = await post(s.app, "/api/v1/import.start", s.adminToken, { job_id, byte_size: 8 });
    expect(short.status).toBe(400);
  });

  it("enforces the upload limit, declared or not", async () => {
    const s = setup({ maxUploadBytes: 10 });
    const declared = await post(s.app, "/api/v1/import.begin", s.adminToken, {
      target: "new",
      graph_id: "x",
      byte_size: 11,
    });
    expect(declared.status).toBe(413);
    const begun = await post(s.app, "/api/v1/import.begin", s.adminToken, {
      target: "new",
      graph_id: "x",
    });
    const over = await post(s.app, "/api/v1/import.chunk", s.adminToken, {
      job_id: begun.json.job_id,
      offset: 0,
      data_base64: Buffer.alloc(12).toString("base64"),
    });
    expect(over.status).toBe(413);
    const st = await post(s.app, "/api/v1/import.status", s.adminToken, {
      job_id: begun.json.job_id,
    });
    expect(st.json.state).toBe("failed");
  });

  it("runs one import at a time", async () => {
    const s = setup();
    const first = await post(s.app, "/api/v1/import.begin", s.adminToken, {
      target: "new",
      graph_id: "one",
    });
    expect(first.status).toBe(200);
    const second = await post(s.app, "/api/v1/import.begin", s.adminToken, {
      target: "new",
      graph_id: "two",
    });
    expect(second.status).toBe(409);
    // ...and an admin of another graph cannot see or steer this graph's job.
    const other = setup();
    const peek = await post(other.app, "/api/v1/import.status", other.adminToken, {
      job_id: first.json.job_id,
    });
    expect(peek.status).toBe(404);
  });
});
