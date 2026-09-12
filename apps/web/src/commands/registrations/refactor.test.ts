import { describe, expect, it } from "vitest";
import { createFakeStore } from "../hosts/store.js";
import { createCommandRegistry } from "../registry.js";
import { type CommandContext, DEFAULT_WHEN_CONTEXT } from "../types.js";
import { matchesWhen } from "../when/index.js";
import { createFakeRefactorHost, createRefactorCommands } from "./refactor.js";

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

function command(id: string, host: ReturnType<typeof createFakeRefactorHost>["host"]) {
  const c = createRefactorCommands({ refactor: host }).find((x) => x.id === id);
  if (!c) throw new Error(`no command ${id}`);
  return c;
}

describe("refactor commands", () => {
  it("every refactor command registers in the real registry", () => {
    // Building a command does not validate its id; registering it does (R2's closed set of core
    // areas), and the app registers at first render — so an id like `page.mergeInto` was a blank
    // screen, not a failing test (B-87). This is the test that would have caught it.
    const registry = createCommandRegistry();
    const { host } = createFakeRefactorHost();
    for (const command of createRefactorCommands({ refactor: host })) {
      expect(() => registry.register(command)).not.toThrow();
    }
    expect(
      registry
        .list()
        .map((c) => c.id)
        .sort(),
    ).toEqual(["block.moveToPage", "block.turnIntoPage", "edit.mergePage", "search.findReplace"]);
  });

  it("Turn into page acts on the focused block, else the first selected one", async () => {
    const { host, calls } = createFakeRefactorHost();
    const c = command("block.turnIntoPage", host);
    await c.run(ctx({ editorFocused: true, focusedBlockId: "b1", selectedBlockIds: ["b9"] }));
    await c.run(ctx({ blockSelected: true, selectedBlockIds: ["b2", "b3"] }));
    await c.run(ctx());
    expect(calls).toEqual([
      { method: "turnBlockIntoPage", args: ["b1"] },
      { method: "turnBlockIntoPage", args: ["b2"] },
    ]);
  });

  it("the block commands leave edit mode before the block goes (B-88), but not from selection mode", async () => {
    const execs: string[] = [];
    const editing = ctx({
      editorFocused: true,
      focusedBlockId: "b1",
      exec: async (id) => {
        execs.push(id);
      },
    });
    const { host, calls } = createFakeRefactorHost({ pick: "Elsewhere" });
    await command("block.turnIntoPage", host).run(editing);
    await command("block.moveToPage", host).run(editing);
    expect(execs).toEqual(["block.selectBlock", "block.selectBlock"]);
    expect(calls.map((c) => c.method)).toEqual([
      "turnBlockIntoPage",
      "pickPage",
      "moveBlockToPage",
    ]);

    const selected = ctx({
      blockSelected: true,
      selectedBlockIds: ["b2"],
      exec: async (id) => {
        execs.push(id);
      },
    });
    await command("block.turnIntoPage", host).run(selected);
    expect(execs).toHaveLength(2);
  });

  it("the block commands are offered only with a block to act on", () => {
    const { host } = createFakeRefactorHost();
    for (const id of ["block.turnIntoPage", "block.moveToPage"]) {
      const c = command(id, host);
      expect(matchesWhen(c.when, ctx())).toBe(false);
      expect(matchesWhen(c.when, ctx({ editorFocused: true }))).toBe(true);
      expect(matchesWhen(c.when, ctx({ blockSelected: true }))).toBe(true);
    }
  });

  it("Move to page… asks for a page and moves there; a dismissed picker moves nothing", async () => {
    const picked = createFakeRefactorHost({ pick: "Archive" });
    await command("block.moveToPage", picked.host).run(
      ctx({ editorFocused: true, focusedBlockId: "b1" }),
    );
    expect(picked.calls).toEqual([
      { method: "pickPage", args: [{ title: "Move to page", allowCreate: true }] },
      { method: "moveBlockToPage", args: ["b1", "Archive"] },
    ]);

    const dismissed = createFakeRefactorHost({ pick: null });
    await command("block.moveToPage", dismissed.host).run(
      ctx({ editorFocused: true, focusedBlockId: "b1" }),
    );
    expect(dismissed.calls.map((c) => c.method)).toEqual(["pickPage"]);
  });

  it("Merge this page into… merges the current page into the picked one, existing pages only", async () => {
    const { host, calls } = createFakeRefactorHost({ pick: "Acme Supply", page: "Acme" });
    await command("edit.mergePage", host).run(ctx());
    expect(calls).toEqual([
      { method: "pickPage", args: [{ title: 'Merge "Acme" into', allowCreate: false }] },
      { method: "mergePageInto", args: ["Acme", "Acme Supply"] },
    ]);
  });

  it("Merge does nothing off a page route", async () => {
    const { host, calls } = createFakeRefactorHost({ pick: "Acme Supply", page: null });
    await command("edit.mergePage", host).run(ctx());
    expect(calls).toEqual([]);
  });

  it("Find and replace… opens the view", async () => {
    const { host, calls } = createFakeRefactorHost();
    await command("search.findReplace", host).run(ctx());
    expect(calls).toEqual([{ method: "openFindReplace", args: [] }]);
  });
});
