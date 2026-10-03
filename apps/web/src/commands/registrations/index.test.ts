import { describe, expect, it } from "vitest";
import { createFakeEditorHost } from "../hosts/editor-host.js";
import { createFakeAppHost, createFakeNavigationHost } from "../hosts/nav-host.js";
import { createFakeStore } from "../hosts/store.js";
import { createPaletteController } from "../palette/palette-controller.js";
import { createCommandRegistry } from "../registry.js";
import { type CommandContext, DEFAULT_WHEN_CONTEXT, type WhenContext } from "../types.js";
import { compileWhen } from "../when/compile.js";
import { evaluateWhen } from "../when/evaluate.js";
import { createFakeDatePickerHost } from "./date-picker-host.js";
import { createCoreCommands } from "./index.js";
import { createTaskCommands } from "./task.js";

function makeDeps() {
  return {
    editor: createFakeEditorHost(),
    navigation: createFakeNavigationHost(),
    app: createFakeAppHost(),
    palette: createPaletteController(),
    datePicker: createFakeDatePickerHost(),
  };
}

describe("createCoreCommands", () => {
  it("produces a large, fully-populated core command set with no duplicate ids", () => {
    const commands = createCoreCommands(makeDeps());
    expect(commands.length).toBeGreaterThan(70);
    const ids = commands.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every command registers without error (valid id shape + valid `when`)", () => {
    const registry = createCommandRegistry();
    const commands = createCoreCommands(makeDeps());
    for (const c of commands) {
      expect(() => registry.register(c)).not.toThrow();
    }
    expect(registry.list()).toHaveLength(commands.length);
  });

  it("covers every core area named in R2", () => {
    const commands = createCoreCommands(makeDeps());
    const areas = new Set(commands.map((c) => c.id.split(".")[0]));
    for (const area of ["block", "task", "nav", "search", "format", "edit", "app", "sync"]) {
      expect(areas).toContain(area);
    }
  });
});

describe("createCoreCommands — spot-check real behavior end-to-end", () => {
  it("task.cycle advances null -> TODO via the fake store", async () => {
    const store = createFakeStore({ b1: {} });
    const deps = { ...makeDeps() };
    const commands = createCoreCommands(deps);
    const cycle = commands.find((c) => c.id === "task.cycle");
    expect(cycle).toBeDefined();
    await cycle?.run({
      editorFocused: true,
      blockSelected: false,
      hasSelection: false,
      selectionCount: 0,
      isTask: false,
      isCollapsed: false,
      hasChildren: false,
      atLineStart: false,
      atLineEnd: false,
      onFirstVisualLine: false,
      onLastVisualLine: false,
      caretInLink: false,
      popupOpen: false,
      composing: false,
      zoomed: false,
      pageView: false,
      platform: "mac",
      mobile: false,
      focusedBlockId: "b1",
      selectedBlockIds: [],
      surface: null,
      store,
      exec: async () => {},
    });
    expect(store.props.get("b1")?.marker).toBe("TODO");
  });

  it("format.bold wraps the current selection via the fake editor host", () => {
    const deps = makeDeps();
    deps.editor.state = { blockId: "b1", content: "hello", start: 0, end: 5 };
    const commands = createCoreCommands(deps);
    const bold = commands.find((c) => c.id === "format.bold");
    bold?.run({
      editorFocused: true,
      blockSelected: false,
      hasSelection: true,
      selectionCount: 0,
      isTask: false,
      isCollapsed: false,
      hasChildren: false,
      atLineStart: false,
      atLineEnd: false,
      onFirstVisualLine: false,
      onLastVisualLine: false,
      caretInLink: false,
      popupOpen: false,
      composing: false,
      zoomed: false,
      pageView: false,
      platform: "mac",
      mobile: false,
      focusedBlockId: "b1",
      selectedBlockIds: [],
      surface: null,
      store: createFakeStore(),
      exec: async () => {},
    });
    expect(deps.editor.state?.content).toBe("**hello**");
  });

  it("a structural command (block.indent) delegates to the editor host untouched", () => {
    const deps = makeDeps();
    const commands = createCoreCommands(deps);
    const indent = commands.find((c) => c.id === "block.indent");
    const ctx = {
      editorFocused: true,
      blockSelected: false,
      hasSelection: false,
      selectionCount: 0,
      isTask: false,
      isCollapsed: false,
      hasChildren: false,
      atLineStart: false,
      atLineEnd: false,
      onFirstVisualLine: false,
      onLastVisualLine: false,
      caretInLink: false,
      popupOpen: false,
      composing: false,
      zoomed: false,
      pageView: false,
      platform: "mac" as const,
      mobile: false,
      focusedBlockId: "b1",
      selectedBlockIds: [],
      surface: null,
      store: createFakeStore(),
      exec: async () => {},
    };
    indent?.run(ctx);
    expect(deps.editor.structuralCalls).toEqual([{ id: "block.indent", ctx }]);
  });

  it("palette.open toggles the palette controller open, then closed", () => {
    const deps = makeDeps();
    const commands = createCoreCommands(deps);
    const open = commands.find((c) => c.id === "palette.open");
    const ctx = {
      editorFocused: false,
      blockSelected: false,
      hasSelection: false,
      selectionCount: 0,
      isTask: false,
      isCollapsed: false,
      hasChildren: false,
      atLineStart: false,
      atLineEnd: false,
      onFirstVisualLine: false,
      onLastVisualLine: false,
      caretInLink: false,
      popupOpen: false,
      composing: false,
      zoomed: false,
      pageView: false,
      platform: "mac" as const,
      mobile: false,
      focusedBlockId: null,
      selectedBlockIds: [],
      surface: null,
      store: createFakeStore(),
      exec: async () => {},
    };
    open?.run(ctx);
    expect(deps.palette.isOpen()).toBe(true);
    open?.run(ctx);
    expect(deps.palette.isOpen()).toBe(false);
  });
});

describe("the date commands date one block (B-345)", () => {
  // They open ONE picker for ONE block (`targetBlockId` is the first selected id). Offered for a
  // multi-selection, they dated the first block and left the others as they were, silently.
  const base = {
    editorFocused: false,
    blockSelected: false,
    selectionCount: 0,
  } as unknown as WhenContext;
  for (const id of ["task.setScheduled", "task.setDeadline"]) {
    it(`${id} is enabled while editing or with one block selected, not with several`, () => {
      const cmd = createCoreCommands(makeDeps()).find((c) => c.id === id);
      const when = compileWhen(cmd?.when ?? "false");
      expect(evaluateWhen(when, { ...base, editorFocused: true })).toBe(true);
      expect(evaluateWhen(when, { ...base, blockSelected: true, selectionCount: 1 })).toBe(true);
      expect(evaluateWhen(when, { ...base, blockSelected: true, selectionCount: 2 })).toBe(false);
    });
  }
});

function taskCtx(
  store: ReturnType<typeof createFakeStore>,
  over: Partial<CommandContext> = {},
): CommandContext {
  return {
    ...DEFAULT_WHEN_CONTEXT,
    focusedBlockId: null,
    selectedBlockIds: [],
    surface: null,
    store,
    exec: async () => {},
    ...over,
  };
}

function taskCommand(id: string) {
  const cmd = createCoreCommands(makeDeps()).find((c) => c.id === id);
  if (!cmd) throw new Error(`no ${id}`);
  return cmd;
}

describe("task commands started back to back (B-282)", () => {
  // The dispatcher does not await a command before running the next key. Both runs used to read
  // the marker before either wrote, and both wrote TODO.
  it("two task.cycle runs started together advance the marker twice", async () => {
    const store = createFakeStore({ b1: {} });
    const cycle = taskCommand("task.cycle");
    const ctx = taskCtx(store, { editorFocused: true, focusedBlockId: "b1" });
    await Promise.all([cycle.run(ctx), cycle.run(ctx)]);
    expect(store.props.get("b1")?.marker).toBe("DOING");
  });

  it("a cycle queued behind one that throws still runs", async () => {
    const store = createFakeStore({ b1: {} });
    const cycle = taskCommand("task.cycle");
    const ctx = taskCtx(store, { editorFocused: true, focusedBlockId: "b1" });
    const failing = {
      ...store,
      getBlockTaskState: async () => {
        throw new Error("replica gone");
      },
    };
    const first = cycle.run({ ...ctx, store: failing });
    const second = cycle.run(ctx);
    await expect(first).rejects.toThrow("replica gone");
    await second;
    expect(store.props.get("b1")?.marker).toBe("TODO");
  });
});

describe("the marker commands act on every selected block, in one write (B-346)", () => {
  function spyStore(initial: Record<string, Record<string, string | null>>) {
    const store = createFakeStore(initial);
    const calls: string[] = [];
    const setPropsOfBlocks = store.setPropsOfBlocks;
    store.setPropsOfBlocks = async (writes) => {
      calls.push(writes.map((w) => w.blockId).join(","));
      await setPropsOfBlocks(writes);
    };
    store.setBlockProp = async () => {
      throw new Error("one block at a time is one undo step per block");
    };
    return { store, calls };
  }
  const selected = {
    blockSelected: true,
    selectionCount: 3,
    selectedBlockIds: ["b1", "b2", "b3"],
  };

  it("Mark TODO marks all three", async () => {
    const { store, calls } = spyStore({ b1: {}, b2: { marker: "DONE" }, b3: {} });
    await taskCommand("task.setMarkerTodo").run(taskCtx(store, selected));
    expect(calls).toEqual(["b1,b2,b3"]);
    expect(["b1", "b2", "b3"].map((id) => store.props.get(id)?.marker)).toEqual([
      "TODO",
      "TODO",
      "TODO",
    ]);
  });

  it("Mark DONE completes each block from its own dates (R35)", async () => {
    const { store, calls } = spyStore({
      b1: { marker: "TODO" },
      b2: { marker: "DOING", scheduled: "2026-09-01", repeat: "1w" },
      b3: {},
    });
    await taskCommand("task.setMarkerDone").run(taskCtx(store, selected));
    expect(calls).toEqual(["b1,b2,b3"]);
    expect(store.props.get("b1")?.marker).toBe("DONE");
    expect(store.props.get("b1")?.done).toBeTruthy();
    // The repeating one is rescheduled and reopened, not left DONE.
    expect(store.props.get("b2")?.marker).toBe("TODO");
    expect(store.props.get("b2")?.scheduled).not.toBe("2026-09-01");
    expect(store.props.get("b3")?.marker).toBe("DONE");
  });

  it("Clear task marker clears every selected task and writes nothing for the rest", async () => {
    const { store, calls } = spyStore({
      b1: { marker: "TODO" },
      b2: {},
      b3: { marker: "WAITING" },
    });
    await taskCommand("task.clearMarker").run(taskCtx(store, selected));
    expect(calls).toEqual(["b1,b3"]);
    expect(["b1", "b2", "b3"].map((id) => store.props.get(id)?.marker ?? null)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("while editing, only the edited block is written", async () => {
    const { store, calls } = spyStore({ b1: {}, b2: {} });
    await taskCommand("task.setMarkerDoing").run(
      taskCtx(store, { editorFocused: true, focusedBlockId: "b2" }),
    );
    expect(calls).toEqual(["b2"]);
    expect(store.props.get("b1")?.marker).toBeUndefined();
  });

  it("Clear task marker is offered for a block selection, where isTask is false", () => {
    const when = compileWhen(taskCommand("task.clearMarker").when ?? "false");
    const base = DEFAULT_WHEN_CONTEXT;
    expect(evaluateWhen(when, { ...base, blockSelected: true, selectionCount: 3 })).toBe(true);
    expect(evaluateWhen(when, { ...base, editorFocused: true, isTask: true })).toBe(true);
    expect(evaluateWhen(when, { ...base, editorFocused: true, isTask: false })).toBe(false);
  });
});

describe("task commands follow the graph's task workflow (B-608)", () => {
  function nowCommand(id: string) {
    const cmd = createTaskCommands({
      datePicker: createFakeDatePickerHost(),
      workflow: () => "now",
    }).find((c) => c.id === id);
    if (!cmd) throw new Error(`no ${id}`);
    return cmd;
  }

  it("task.cycle under `now`: none → LATER → NOW → DONE (stamped) → none", async () => {
    const store = createFakeStore({ b1: {} });
    const cycle = nowCommand("task.cycle");
    const ctx = taskCtx(store, { editorFocused: true, focusedBlockId: "b1" });
    const seen: (string | null | undefined)[] = [];
    for (let i = 0; i < 4; i++) {
      await cycle.run(ctx);
      seen.push(store.props.get("b1")?.marker);
      if (i === 2) expect(store.props.get("b1")?.done).toMatch(/Z$/);
    }
    expect(seen).toEqual(["LATER", "NOW", "DONE", null]);
  });

  it("task.cycle under `todo` (the default) still starts at TODO", async () => {
    const store = createFakeStore({ b1: {} });
    await taskCommand("task.cycle").run(
      taskCtx(store, { editorFocused: true, focusedBlockId: "b1" }),
    );
    expect(store.props.get("b1")?.marker).toBe("TODO");
  });

  it("task.toggleDone on DONE under `now` reopens as LATER", async () => {
    const store = createFakeStore({ b1: { marker: "DONE" } });
    await nowCommand("task.toggleDone").run(
      taskCtx(store, { editorFocused: true, focusedBlockId: "b1" }),
    );
    expect(store.props.get("b1")?.marker).toBe("LATER");
  });

  it("Mark LATER / Mark NOW exist and write their marker", async () => {
    const store = createFakeStore({ b1: {}, b2: {} });
    await taskCommand("task.setMarkerLater").run(
      taskCtx(store, { editorFocused: true, focusedBlockId: "b1" }),
    );
    await taskCommand("task.setMarkerNow").run(
      taskCtx(store, { editorFocused: true, focusedBlockId: "b2" }),
    );
    expect(store.props.get("b1")?.marker).toBe("LATER");
    expect(store.props.get("b2")?.marker).toBe("NOW");
  });
});
