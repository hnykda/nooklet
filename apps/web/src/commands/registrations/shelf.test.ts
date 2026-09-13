import { describe, expect, it } from "vitest";
import { createFakeStore } from "../hosts/store.js";
import { createCommandRegistry } from "../registry.js";
import { type CommandContext, DEFAULT_WHEN_CONTEXT } from "../types.js";
import { matchesWhen } from "../when/index.js";
import { createFakeShelfHost, createShelfCommands } from "./shelf.js";

function ctx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    ...DEFAULT_WHEN_CONTEXT,
    focusedBlockId: null,
    selectedBlockIds: [],
    surface: null,
    store: createFakeStore(),
    exec: async () => {},
    ...overrides,
  };
}

describe("shelf commands (B-160)", () => {
  it("register under core areas — an unknown area throws at boot and blanks the app (B-87)", () => {
    const registry = createCommandRegistry();
    for (const c of createShelfCommands({ shelf: createFakeShelfHost() })) {
      expect(() => registry.register(c)).not.toThrow();
    }
  });

  it("block.openOnShelf shelves the focused block, or the first selected one", async () => {
    const shelf = createFakeShelfHost();
    const cmd = createShelfCommands({ shelf }).find((c) => c.id === "block.openOnShelf");
    expect(matchesWhen(cmd?.when, ctx())).toBe(false);

    const editing = ctx({ editorFocused: true, focusedBlockId: "b1" });
    expect(matchesWhen(cmd?.when, editing)).toBe(true);
    await cmd?.run(editing);

    const selecting = ctx({ blockSelected: true, selectedBlockIds: ["b2", "b3"] });
    expect(matchesWhen(cmd?.when, selecting)).toBe(true);
    await cmd?.run(selecting);

    expect(shelf.calls).toEqual([
      { method: "openBlock", arg: "b1" },
      { method: "openBlock", arg: "b2" },
    ]);
  });

  it("nav.openPageOnShelf asks the host for the current page", async () => {
    const shelf = createFakeShelfHost();
    const cmd = createShelfCommands({ shelf }).find((c) => c.id === "nav.openPageOnShelf");
    await cmd?.run(ctx());
    expect(shelf.calls).toEqual([{ method: "openCurrentPage" }]);
  });
});
