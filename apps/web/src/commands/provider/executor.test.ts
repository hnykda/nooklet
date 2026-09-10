import { describe, expect, it } from "vitest";
import { createFakeStore } from "../hosts/store.js";
import { createMruStore } from "../ranking/mru.js";
import { createCommandRegistry } from "../registry.js";
import { type Command, DEFAULT_WHEN_CONTEXT } from "../types.js";
import { createCommandContext } from "./executor.js";

function baseCtx() {
  return {
    ...DEFAULT_WHEN_CONTEXT,
    focusedBlockId: "b1",
    selectedBlockIds: [],
    surface: null,
    store: createFakeStore(),
  };
}

describe("createCommandContext / exec", () => {
  it("runs the target command with the base context", async () => {
    const registry = createCommandRegistry();
    let received: unknown;
    const command: Command = {
      id: "app.toggleSidebar",
      title: "Toggle sidebar",
      category: "App",
      defaultKeys: {},
      run: (ctx) => {
        received = ctx.focusedBlockId;
      },
    };
    registry.register(command);
    const ctx = createCommandContext(baseCtx(), registry, createMruStore());
    await ctx.exec("app.toggleSidebar");
    expect(received).toBe("b1");
  });

  it("passes args through to the invoked command", async () => {
    const registry = createCommandRegistry();
    let received: unknown;
    registry.register({
      id: "app.toggleSidebar",
      title: "x",
      category: "App",
      defaultKeys: {},
      run: (ctx) => {
        received = ctx.args;
      },
    });
    const ctx = createCommandContext(baseCtx(), registry, createMruStore());
    await ctx.exec("app.toggleSidebar", { foo: 1 });
    expect(received).toEqual({ foo: 1 });
  });

  it("records MRU on successful run", async () => {
    const registry = createCommandRegistry();
    registry.register({
      id: "app.toggleSidebar",
      title: "x",
      category: "App",
      defaultKeys: {},
      run: () => {},
    });
    const mru = createMruStore();
    const ctx = createCommandContext(baseCtx(), registry, mru);
    await ctx.exec("app.toggleSidebar");
    expect(mru.indexOf("command", "app.toggleSidebar")).toBe(0);
  });

  it("does not record MRU when the command throws", async () => {
    const registry = createCommandRegistry();
    registry.register({
      id: "app.toggleSidebar",
      title: "x",
      category: "App",
      defaultKeys: {},
      run: () => {
        throw new Error("boom");
      },
    });
    const mru = createMruStore();
    const ctx = createCommandContext(baseCtx(), registry, mru);
    await expect(ctx.exec("app.toggleSidebar")).rejects.toThrow("boom");
    expect(mru.indexOf("command", "app.toggleSidebar")).toBe(Number.POSITIVE_INFINITY);
  });

  it("silently no-ops for an unknown command id", async () => {
    const registry = createCommandRegistry();
    const ctx = createCommandContext(baseCtx(), registry, createMruStore());
    await expect(ctx.exec("nope.nope")).resolves.toBeUndefined();
  });

  it("exec is available to a command's own run() (nested exec)", async () => {
    const registry = createCommandRegistry();
    const calls: string[] = [];
    registry.register({
      id: "app.a",
      title: "a",
      category: "App",
      defaultKeys: {},
      run: async (ctx) => {
        calls.push("a");
        await ctx.exec("app.b");
      },
    });
    registry.register({
      id: "app.b",
      title: "b",
      category: "App",
      defaultKeys: {},
      run: () => {
        calls.push("b");
      },
    });
    const ctx = createCommandContext(baseCtx(), registry, createMruStore());
    await ctx.exec("app.a");
    expect(calls).toEqual(["a", "b"]);
  });
});
