import { describe, expect, it } from "vitest";
import { createFakeStore } from "../hosts/store.js";
import { createCommandRegistry } from "../registry.js";
import { type CommandContext, DEFAULT_WHEN_CONTEXT } from "../types.js";
import { matchesWhen } from "../when/index.js";
import {
  createFakePageActionsHost,
  createPageActionCommands,
  type PageActionsHost,
} from "./page-actions.js";

function ctx(over: Partial<CommandContext> = {}): CommandContext {
  return {
    ...DEFAULT_WHEN_CONTEXT,
    focusedBlockId: null,
    selectedBlockIds: [],
    surface: null,
    store: createFakeStore(),
    exec: async () => {},
    ...over,
  };
}

function command(id: string, host: PageActionsHost) {
  const c = createPageActionCommands({ pageActions: host }).find((x) => x.id === id);
  if (!c) throw new Error(`no command ${id}`);
  return c;
}

describe("page action commands", () => {
  it("every page action registers in the real registry and shows in the palette anywhere", () => {
    // Registering, not just building, is what validates R2's closed set of areas — a `page.` id
    // would throw here and blank the app at boot (B-87).
    const registry = createCommandRegistry();
    const { host } = createFakePageActionsHost();
    for (const c of createPageActionCommands({ pageActions: host })) {
      expect(() => registry.register(c)).not.toThrow();
      expect(matchesWhen(c.when, DEFAULT_WHEN_CONTEXT)).toBe(true);
      expect(matchesWhen(c.when, { ...DEFAULT_WHEN_CONTEXT, editorFocused: true })).toBe(true);
    }
    expect(
      registry
        .list()
        .map((c) => c.id)
        .sort(),
    ).toEqual([
      "app.copyPageMarkdown",
      "app.exportPageMarkdown",
      "app.printPage",
      "app.toggleFavorite",
    ]);
  });

  it("act on the routed page from the palette", async () => {
    const { host, calls } = createFakePageActionsHost({ page: "Projects/Aurora" });
    await command("app.copyPageMarkdown", host).run(ctx());
    await command("app.exportPageMarkdown", host).run(ctx());
    await command("app.toggleFavorite", host).run(ctx());
    expect(calls).toEqual([
      { method: "copyPageMarkdown", args: ["Projects/Aurora"] },
      { method: "exportPageMarkdown", args: ["Projects/Aurora"] },
      { method: "toggleFavorite", args: ["Projects/Aurora"] },
    ]);
  });

  it("args.page (the title row, an agent) wins over the route", async () => {
    const { host, calls } = createFakePageActionsHost({ page: "Routed" });
    await command("app.toggleFavorite", host).run(ctx({ args: { page: "Named" } }));
    // A malformed page arg falls back to the route rather than acting on "[object Object]".
    await command("app.toggleFavorite", host).run(ctx({ args: { page: 7 } }));
    expect(calls.map((c) => c.args[0])).toEqual(["Named", "Routed"]);
  });

  it("off a page the page commands do nothing, but Print still prints the view", async () => {
    const { host, calls } = createFakePageActionsHost({ page: null });
    for (const id of ["app.copyPageMarkdown", "app.exportPageMarkdown", "app.toggleFavorite"]) {
      await command(id, host).run(ctx());
    }
    await command("app.printPage", host).run(ctx());
    expect(calls).toEqual([{ method: "printPage", args: [] }]);
  });

  it("copy reaches the host in the same tick as run() — WebKit's clipboard gesture rule", () => {
    const { host, calls } = createFakePageActionsHost({ page: "P" });
    // No await: if run() awaited anything before calling the host, the clipboard write would
    // start outside the key/click that asked for it and WebKit would reject it.
    void command("app.copyPageMarkdown", host).run(ctx());
    expect(calls).toEqual([{ method: "copyPageMarkdown", args: ["P"] }]);
  });
});
