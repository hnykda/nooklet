/**
 * End-to-end plugin host tests: discover -> bundle -> activate a real (fixture) plugin against a
 * real app + registry, and confirm the two things the task calls out explicitly:
 *
 *  1. a plugin's registered op really appears in the HTTP API and the MCP tool list;
 *  2. deactivating a plugin disposes EVERY kind of registration it made — routes 404, ops
 *     unregister (from both the registry and the live HTTP route), MCP tools disappear, and jobs
 *     stop ticking.
 */
import { describe, expect, it } from "vitest";
import {
  makePluginTestSetup,
  mcpRpc,
  post,
  tmpDir,
  writePluginFixture,
} from "./plugin-test-helpers.js";

const ECHO_OP_PLUGIN = `
import { defineOp, OpError } from "@nooklet/plugin-api";
import { z } from "zod";

export default {
  async activate(ctx) {
    ctx.ops.register(defineOp({
      name: "test.echo",
      summary: "Echo test op",
      description: "Echoes back the given text, for plugin-loader tests.",
      input: z.object({ text: z.string() }).strict(),
      output: z.object({ text: z.string() }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      scopes: ["read"],
      expose: { http: true, mcp: true },
      render: (o) => o.text,
      async handler(input) {
        if (input.text === "fail") {
          throw new OpError("not_found", "text was 'fail'", "try something else");
        }
        return { text: input.text };
      },
    }));
  },
};
`;

async function setupEchoPlugin() {
  const root = tmpDir("nooklet-host-test-echo-");
  writePluginFixture(
    root,
    "echo-plugin",
    { id: "echo-plugin", api: "1", server: "./src/server.ts" },
    {
      "src/server.ts": ECHO_OP_PLUGIN,
    },
  );
  return makePluginTestSetup([root]);
}

describe("plugin ops appear in HTTP + MCP", () => {
  it("mounts the op at POST /api/v1/<name>", async () => {
    const setup = await setupEchoPlugin();
    const { status, json } = await post(setup.app, "/api/v1/test.echo", setup.readToken, {
      text: "hello",
    });
    expect(status).toBe(200);
    expect(json).toEqual({ text: "hello" });
  });

  it("appears in MCP tools/list and works over tools/call", async () => {
    const setup = await setupEchoPlugin();
    const list = await mcpRpc(setup.app, setup.readToken, "tools/list", {});
    const names = list.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("test_echo");

    const call = await mcpRpc(setup.app, setup.readToken, "tools/call", {
      name: "test_echo",
      arguments: { text: "via mcp" },
    });
    expect(call.body.result.isError).toBeFalsy();
    expect(call.body.result.structuredContent).toEqual({ text: "via mcp" });
  });

  it("bridges a plugin-thrown OpError to the right HTTP status/code (not a generic 500)", async () => {
    const setup = await setupEchoPlugin();
    const { status, json } = await post(setup.app, "/api/v1/test.echo", setup.readToken, {
      text: "fail",
    });
    expect(status).toBe(404);
    expect(json.error.code).toBe("not_found");
    expect(json.error.hint).toBe("try something else");
  });

  it("an op missing required OpDef fields is that plugin's error, and the server still starts (B-402)", async () => {
    // Plugins are bundled by esbuild, which does not type-check, so nothing stopped this op —
    // no `summary`, `annotations` or `scopes` — from reaching the registry. Mounting its route read
    // `annotations.readOnlyHint` and took `nooklet serve` (and the desktop app) down at startup.
    const root = tmpDir("nooklet-host-test-incomplete-op-");
    writePluginFixture(
      root,
      "incomplete",
      { id: "incomplete", api: "1", server: "./src/server.ts" },
      {
        "src/server.ts": `
import { defineOp } from "@nooklet/plugin-api";
import { z } from "zod";
export default {
  activate(ctx) {
    ctx.ops.register(defineOp({ name: "incomplete.say", description: "hi", input: z.object({}),
      output: z.object({ hi: z.string() }), scope: "read", handler: async () => ({ hi: "there" }) }));
  },
};
`,
      },
    );
    writePluginFixture(
      root,
      "good",
      { id: "good", api: "1", server: "./src/server.ts" },
      { "src/server.ts": ECHO_OP_PLUGIN },
    );
    const setup = await makePluginTestSetup([root]);

    const incomplete = setup.host.list().find((p) => p.id === "incomplete");
    expect(incomplete?.status).toBe("error");
    expect(incomplete?.error).toMatch(/incomplete\.say/);
    expect(incomplete?.error).toMatch(/summary/);
    expect(incomplete?.error).toMatch(/annotations/);
    expect(incomplete?.error).toMatch(/scopes/);
    expect(setup.registry.get("incomplete.say")).toBeUndefined();
    const { status } = await post(setup.app, "/api/v1/test.echo", setup.readToken, { text: "hi" });
    expect(status).toBe(200);
  });

  it("a REST alias missing its method or path is that plugin's error, and the server still starts (B-406)", async () => {
    // Every top-level field is there, so B-402's check alone let these through, and mounting the
    // alias read `path.replace` / Hono's `method.toUpperCase` at startup, outside any plugin guard.
    const root = tmpDir("nooklet-host-test-incomplete-alias-");
    const aliasPlugin = (op: string, http: string) => `
import { defineOp } from "@nooklet/plugin-api";
import { z } from "zod";
export default {
  activate(ctx) {
    ctx.ops.register(defineOp({ name: "${op}", summary: "Say", description: "hi", input: z.object({}),
      output: z.object({ hi: z.string() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      scopes: ["read"], expose: { http: ${http} }, handler: async () => ({ hi: "there" }) }));
  },
};
`;
    writePluginFixture(
      root,
      "nopath",
      { id: "nopath", api: "1", server: "./src/server.ts" },
      { "src/server.ts": aliasPlugin("nopath.say", `{ method: "GET" }`) },
    );
    writePluginFixture(
      root,
      "nomethod",
      { id: "nomethod", api: "1", server: "./src/server.ts" },
      { "src/server.ts": aliasPlugin("nomethod.say", `{ path: "/nomethod/say" }`) },
    );
    writePluginFixture(
      root,
      "good",
      { id: "good", api: "1", server: "./src/server.ts" },
      { "src/server.ts": ECHO_OP_PLUGIN },
    );
    const setup = await makePluginTestSetup([root]);

    for (const id of ["nopath", "nomethod"]) {
      const plugin = setup.host.list().find((p) => p.id === id);
      expect(plugin?.status).toBe("error");
      expect(plugin?.error).toMatch(/expose\.http's method and path/);
      expect(setup.registry.get(`${id}.say`)).toBeUndefined();
    }
    const { status } = await post(setup.app, "/api/v1/test.echo", setup.readToken, { text: "hi" });
    expect(status).toBe(200);
  });

  it("an unsupported api major is a per-plugin error that never aborts the server", async () => {
    const root = tmpDir("nooklet-host-test-badapi-");
    writePluginFixture(
      root,
      "future",
      { id: "future", api: "2", server: "./s.ts" },
      {
        "s.ts": "export default { activate() {} };\n",
      },
    );
    writePluginFixture(
      root,
      "good",
      { id: "good", api: "1", server: "./src/server.ts" },
      {
        "src/server.ts": ECHO_OP_PLUGIN,
      },
    );
    const setup = await makePluginTestSetup([root]);
    const { status } = await post(setup.app, "/api/v1/test.echo", setup.readToken, { text: "hi" });
    expect(status).toBe(200);
    const list = setup.host.list();
    expect(list.find((p) => p.id === "good")?.status).toBe("active");
  });
});

const KITCHEN_SINK_PLUGIN = `
import { defineOp } from "@nooklet/plugin-api";
import { z } from "zod";

export default {
  async activate(ctx) {
    ctx.ops.register(defineOp({
      name: "test.kitchensink",
      summary: "kitchen sink op",
      description: "op for disposal testing",
      input: z.object({}).strict(),
      output: z.object({ ok: z.boolean() }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      scopes: ["read"],
      expose: { http: true, mcp: true },
      render: (o) => String(o.ok),
      handler: async () => ({ ok: true }),
    }));

    ctx.registerRoute("GET", "/ping", async () => new Response("pong"), { auth: "none" });

    ctx.registerMcpTool(
      "raw-tool",
      { description: "raw mcp tool for disposal testing" },
      async () => ({ content: [{ type: "text", text: "raw-ok" }] }),
    );

    let ticks = 0;
    ctx.registerJob({
      id: "ticker",
      every: "20ms",
      runOnStart: true,
      async run() {
        ticks++;
        ctx.kv.set("ticks", ticks);
      },
    });

    let onCount = 0;
    ctx.on("block.created", () => {
      onCount++;
      ctx.kv.set("on-count", onCount);
    });

    let beforeCount = 0;
    ctx.beforeWrite(() => {
      beforeCount++;
      ctx.kv.set("before-count", beforeCount);
    });
  },
};
`;

function kvValue(setup: Awaited<ReturnType<typeof makePluginTestSetup>>, key: string): number {
  const row = setup.serverCtx.driver.get<{ value_json: string }>(
    "SELECT value_json FROM plugin_kv WHERE plugin_id = ? AND key = ?",
    ["kitchen-sink", key],
  );
  return row ? (JSON.parse(row.value_json) as number) : 0;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("deactivating a plugin disposes every registration", () => {
  it("routes 404, ops unregister, MCP tools disappear, and jobs stop", async () => {
    const root = tmpDir("nooklet-host-test-kitchensink-");
    writePluginFixture(
      root,
      "kitchen-sink",
      { id: "kitchen-sink", api: "1", server: "./src/server.ts" },
      { "src/server.ts": KITCHEN_SINK_PLUGIN },
    );
    const setup = await makePluginTestSetup([root]);

    // --- before deactivation: everything works -------------------------------------------
    const pingBefore = await setup.app.request("/api/plugins/kitchen-sink/ping");
    expect(pingBefore.status).toBe(200);
    expect(await pingBefore.text()).toBe("pong");

    expect(setup.registry.get("test.kitchensink")).toBeDefined();
    const opBefore = await post(setup.app, "/api/v1/test.kitchensink", setup.readToken, {});
    expect(opBefore.status).toBe(200);

    const listBefore = await mcpRpc(setup.app, setup.readToken, "tools/list", {});
    const namesBefore = listBefore.body.result.tools.map((t: { name: string }) => t.name);
    expect(namesBefore).toContain("test_kitchensink");
    expect(namesBefore).toContain("kitchen-sink_raw-tool");

    // Trigger the "on"/"beforeWrite" handlers with a real write through the SAME ServerContext
    // the plugin registered against.
    const { makeOp, newId } = await import("@nooklet/core");
    const pageId = newId();
    const blockId = newId();
    const { serverApplyOps } = await import("../apply-ops.js");
    serverApplyOps(
      setup.serverCtx,
      [
        makeOp(setup.serverCtx.hlc.next(), "d1", pageId, {
          kind: "page.create",
          name: "Disposal Test",
          journalDay: null,
          createdAt: Date.now(),
        }),
        makeOp(setup.serverCtx.hlc.next(), "d1", blockId, {
          kind: "block.create",
          place: { pageId, parentId: null, order: "a0" },
          content: "hi",
          createdAt: Date.now(),
        }),
      ],
      { origin: "user", actor: "tester" },
    );

    await sleep(80); // let the 20ms job tick a few times

    const ticksBefore = kvValue(setup, "ticks");
    const onCountBefore = kvValue(setup, "on-count");
    const beforeCountBefore = kvValue(setup, "before-count");
    expect(ticksBefore).toBeGreaterThan(0);
    expect(onCountBefore).toBeGreaterThan(0);
    expect(beforeCountBefore).toBeGreaterThan(0);

    // --- deactivate ------------------------------------------------------------------------
    await setup.host.deactivate("kitchen-sink");

    const pingAfter = await setup.app.request("/api/plugins/kitchen-sink/ping");
    expect(pingAfter.status).toBe(404);

    expect(setup.registry.get("test.kitchensink")).toBeUndefined();
    const opAfter = await post(setup.app, "/api/v1/test.kitchensink", setup.readToken, {});
    expect(opAfter.status).toBe(404);

    const listAfter = await mcpRpc(setup.app, setup.readToken, "tools/list", {});
    const namesAfter = listAfter.body.result.tools.map((t: { name: string }) => t.name);
    expect(namesAfter).not.toContain("test_kitchensink");
    expect(namesAfter).not.toContain("kitchen-sink_raw-tool");

    await sleep(80); // the job must NOT have ticked again
    expect(kvValue(setup, "ticks")).toBe(ticksBefore);

    // A further write must not invoke the disposed on()/beforeWrite() handlers.
    serverApplyOps(
      setup.serverCtx,
      [
        makeOp(setup.serverCtx.hlc.next(), "d1", newId(), {
          kind: "block.create",
          place: { pageId, parentId: null, order: "a1" },
          content: "after dispose",
          createdAt: Date.now(),
        }),
      ],
      { origin: "user", actor: "tester" },
    );
    expect(kvValue(setup, "on-count")).toBe(onCountBefore);
    expect(kvValue(setup, "before-count")).toBe(beforeCountBefore);
  });
});

const AUTHY_PLUGIN = `
import { Hono } from "hono";

export default {
  async activate(ctx) {
    ctx.rpc.expose("double", (n) => n * 2);
    ctx.registerRoute("GET", "/public", async () => new Response("public"), { auth: "none" });
    const sub = new Hono();
    sub.get("/secret", (c) => c.text("secret"));
    ctx.registerRoute(sub);
  },
};
`;

describe("plugin routes require a bearer token unless opted out (B-63)", () => {
  it("guards a mounted sub-app and rpc.expose; auth: 'none' stays open", async () => {
    const root = tmpDir("nooklet-host-test-authy-");
    writePluginFixture(
      root,
      "authy",
      { id: "authy", api: "1", server: "./src/server.ts" },
      { "src/server.ts": AUTHY_PLUGIN },
    );
    const setup = await makePluginTestSetup([root]);
    expect(setup.host.list().find((p) => p.id === "authy")?.status).toBe("active");
    const bearer = { authorization: `Bearer ${setup.readToken}` };

    // The sub-app: 401 without a token, the plugin's own response with one.
    expect((await setup.app.request("/api/plugins/authy/secret")).status).toBe(401);
    const secret = await setup.app.request("/api/plugins/authy/secret", { headers: bearer });
    expect(secret.status).toBe(200);
    expect(await secret.text()).toBe("secret");

    // RPC: the same rule — the client half holds the app's token, so nothing is lost.
    const rpcInit = {
      method: "POST",
      body: JSON.stringify([21]),
      headers: { "content-type": "application/json" },
    };
    expect((await setup.app.request("/api/plugins/authy/rpc/double", rpcInit)).status).toBe(401);
    const doubled = await setup.app.request("/api/plugins/authy/rpc/double", {
      ...rpcInit,
      headers: { ...rpcInit.headers, ...bearer },
    });
    expect(doubled.status).toBe(200);
    expect(await doubled.json()).toBe(42);

    // Explicitly public stays public.
    const pub = await setup.app.request("/api/plugins/authy/public");
    expect(pub.status).toBe(200);
    expect(await pub.text()).toBe("public");
  });
});
