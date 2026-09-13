/**
 * The client plugin host (ADR 023) against fakes for every slot: what the built-in plugins
 * register lands in the registry, the slash rows and the renderer map; everything is taken back
 * on `stop()` or a failed activation; and what the host does not implement fails loudly.
 */
import type { Page } from "@nooklet/core";
import type { ClientPluginContext, ClientPluginModule } from "@nooklet/plugin-api";
import { describe, expect, it, vi } from "vitest";
import { createFakeEditorHost } from "../commands/hosts/editor-host.js";
import { createCommandRegistry } from "../commands/registry.js";
import { type CommandContext, DEFAULT_WHEN_CONTEXT, type SlashItem } from "../commands/types.js";
import { BUILTIN_CLIENT_PLUGINS } from "./builtins.js";
import {
  type BuiltinClientPlugin,
  type ClientPluginHostDeps,
  createClientPluginHost,
  pluginCommandId,
} from "./host.js";

const PAGE: Page = {
  id: "p0000000000001",
  name: "Zahrada",
  key: "zahrada",
  journalDay: null,
  properties: {},
  createdAt: 1,
  updatedAt: 1,
};

const silent = { info() {}, warn() {}, error() {}, debug() {} };

function setup(overrides: Partial<ClientPluginHostDeps> = {}) {
  const registry = createCommandRegistry();
  const editor = createFakeEditorHost({ content: "before  after", start: 7, end: 7 });
  const slashRows: SlashItem[] = [];
  const renderers = new Map<string, unknown>();
  const statusItems: Array<{ pluginId: string; item: { id: string } }> = [];
  const disposed: string[] = [];
  const deps: ClientPluginHostDeps = {
    registry,
    editor,
    navigate: vi.fn(),
    pageNameForId: async () => "Zahrada",
    pagePath: (name) => `/page/${name}`,
    currentPage: () => PAGE,
    baseUrl: () => "http://nooklet.test",
    getToken: () => "tok_123",
    hostVersion: "0.1.0",
    platform: "desktop",
    theme: () => "light",
    contributeSlashItem(item) {
      slashRows.push(item);
      return () => {
        slashRows.splice(slashRows.indexOf(item), 1);
        disposed.push(`slash:${item.label}`);
      };
    },
    registerFenceRenderer(lang, renderer) {
      renderers.set(lang, renderer);
      return () => {
        renderers.delete(lang);
        disposed.push(`fence:${lang}`);
      };
    },
    addStatusItem(entry) {
      statusItems.push(entry);
      return () => {
        statusItems.splice(statusItems.indexOf(entry), 1);
        disposed.push(`status:${entry.item.id}`);
      };
    },
    logger: silent,
    ...overrides,
  };
  return { deps, registry, editor, slashRows, renderers, statusItems, disposed };
}

function plugin(
  id: string,
  activate: ClientPluginModule["activate"],
  api = "1",
): BuiltinClientPlugin {
  return { manifest: { version: "0.1.0", nooklet: { id, api } }, module: { activate } };
}

function commandContext(): CommandContext {
  return {
    ...DEFAULT_WHEN_CONTEXT,
    editorFocused: true,
    focusedBlockId: "b1",
    selectedBlockIds: [],
    surface: null,
    store: {} as CommandContext["store"],
    exec: async () => {},
  };
}

describe("the built-in client halves (B-103)", () => {
  it("activate and register /mermaid, the mermaid fence renderer and the word-count status item", async () => {
    const t = setup();
    const host = createClientPluginHost(t.deps);
    await host.start(BUILTIN_CLIENT_PLUGINS);

    expect(host.list()).toEqual([
      { id: "mermaid", status: "active" },
      { id: "word-count", status: "active" },
    ]);
    expect(t.slashRows).toEqual([
      {
        label: "Mermaid diagram",
        command: "plugin.mermaid.slashMermaid",
        keywords: ["diagram", "graph", "chart", "flowchart"],
      },
    ]);
    expect(t.registry.get("plugin.mermaid.slashMermaid")?.when).toBe("editorFocused");
    expect([...t.renderers.keys()]).toEqual(["mermaid"]);
    expect(t.statusItems.map((s) => `${s.pluginId}/${s.item.id}`)).toEqual([
      "word-count/word-count",
    ]);
  });

  it("/mermaid inserts the starter diagram at the caret through the editor host", async () => {
    const t = setup();
    await createClientPluginHost(t.deps).start(BUILTIN_CLIENT_PLUGINS);

    await t.registry.get("plugin.mermaid.slashMermaid")?.run(commandContext());

    expect(t.editor.state?.content).toBe("before ```mermaid\ngraph TD\n  A --> B\n``` after");
    // Inside the fence, at the end of "  A --> B" — not after the closing ``` (B-185).
    const caret = "before ```mermaid\ngraph TD\n  A --> B".length;
    expect([t.editor.state?.start, t.editor.state?.end]).toEqual([caret, caret]);
  });
});

describe("lifecycle", () => {
  it("stop() disposes every registration in reverse order and calls deactivate()", async () => {
    const t = setup();
    const deactivate = vi.fn();
    const host = createClientPluginHost(t.deps);
    const demo = plugin("demo", (ctx) => {
      ctx.registerSlashCommand({ id: "one", label: "One", run() {} });
      ctx.registerCodeBlockRenderer("demo", { html: () => "<b>demo</b>" });
      ctx.registerStatusItem({ id: "status", mount() {} });
    });
    await host.start([{ ...demo, module: { ...demo.module, deactivate } }]);
    expect(t.registry.has("plugin.demo.slashOne")).toBe(true);

    await host.stop();

    expect(t.disposed).toEqual(["status:status", "fence:demo", "slash:One"]);
    expect(t.registry.has("plugin.demo.slashOne")).toBe(false);
    expect(t.slashRows).toEqual([]);
    expect(deactivate).toHaveBeenCalledOnce();
  });

  it("a throwing activate() leaves nothing registered and does not stop the next plugin", async () => {
    const t = setup();
    const host = createClientPluginHost(t.deps);
    await host.start([
      plugin("broken", (ctx) => {
        ctx.registerCodeBlockRenderer("broken", { html: () => "" });
        throw new Error("boom");
      }),
      plugin("fine", (ctx) => {
        ctx.registerCodeBlockRenderer("fine", { html: () => "" });
      }),
    ]);

    expect(host.list()).toEqual([
      { id: "broken", status: "error", error: "boom" },
      { id: "fine", status: "active" },
    ]);
    expect([...t.renderers.keys()]).toEqual(["fine"]);
  });

  it("refuses a plugin written against an API major it does not support", async () => {
    const t = setup();
    const activate = vi.fn();
    const host = createClientPluginHost(t.deps);
    await host.start([plugin("future", activate, "2")]);
    expect(activate).not.toHaveBeenCalled();
    expect(host.list()[0]?.status).toBe("error");
  });
});

describe("what the host does not implement fails loudly", () => {
  it.each<[string, (ctx: ClientPluginContext) => unknown]>([
    ["registerPanel()", (ctx) => ctx.registerPanel({ id: "p", title: "P", mount() {} })],
    ["ctx.data", (ctx) => ctx.data.blocks],
    ['ctx.on("block.updated")', (ctx) => ctx.on("block.updated", () => {})],
    ["settings.get()", (ctx) => ctx.settings.get()],
  ])("%s throws, naming itself", async (what, use) => {
    const t = setup();
    const host = createClientPluginHost(t.deps);
    await host.start([plugin("curious", (ctx) => void use(ctx))]);
    expect(host.list()[0]?.status).toBe("error");
    expect(host.list()[0]?.error).toContain(`${what} is not supported`);
  });
});

describe("events", () => {
  it("delivers page.opened / page.changed to subscribers until disposed", async () => {
    const t = setup();
    const seen: string[] = [];
    let subscription: { dispose(): void } | undefined;
    const host = createClientPluginHost(t.deps);
    await host.start([
      plugin("listener", (ctx) => {
        ctx.on("page.opened", ({ page }) => seen.push(`opened:${page.name}`));
        subscription = ctx.on("page.changed", ({ page }) => seen.push(`changed:${page?.name}`));
      }),
    ]);

    host.emit("page.opened", { page: PAGE });
    host.emit("page.changed", { page: PAGE });
    host.emit("page.changed", { page: null });
    subscription?.dispose();
    host.emit("page.changed", { page: PAGE });

    expect(seen).toEqual(["opened:Zahrada", "changed:Zahrada", "changed:undefined"]);
  });
});

describe("rpc.call", () => {
  it("POSTs the arguments to the plugin's own server half with the app's token", async () => {
    const fetchMock = vi.fn(async () => Response.json({ wordCount: 3 }));
    const t = setup({ fetch: fetchMock as unknown as typeof fetch });
    let result: unknown;
    await createClientPluginHost(t.deps).start([
      plugin("word-count", async (ctx) => {
        result = await ctx.rpc.call("count", "Zahrada");
      }),
    ]);

    expect(result).toEqual({ wordCount: 3 });
    expect(fetchMock).toHaveBeenCalledWith("http://nooklet.test/api/plugins/word-count/rpc/count", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok_123" },
      body: '["Zahrada"]',
    });
  });

  it("rejects on a non-2xx reply instead of handing the plugin an error body as data", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 401 }));
    const t = setup({ fetch: fetchMock as unknown as typeof fetch });
    const host = createClientPluginHost(t.deps);
    await host.start([plugin("word-count", (ctx) => ctx.rpc.call("count", "x").then(() => {}))]);
    expect(host.list()[0]?.error).toContain("HTTP 401");
  });
});

describe("pluginCommandId", () => {
  it("camelCases kebab-case plugin and item ids into a registry-valid id", () => {
    expect(pluginCommandId("word-count", "slash-mermaid")).toBe("plugin.wordCount.slashMermaid");
    expect(() =>
      createCommandRegistry().register({
        id: pluginCommandId("word-count", "slash-mermaid"),
        title: "t",
        category: "c",
        defaultKeys: {},
        run() {},
      }),
    ).not.toThrow();
  });
});
