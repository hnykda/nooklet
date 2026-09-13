import { describe, expect, it, vi } from "vitest";
import { type CommandContext, DEFAULT_WHEN_CONTEXT, type ResolvedBinding } from "../types.js";
import { createDispatcher, type DispatchableKeyboardEvent } from "./dispatch.js";

function ctx(partial: Partial<CommandContext> = {}): CommandContext {
  return {
    ...DEFAULT_WHEN_CONTEXT,
    focusedBlockId: null,
    selectedBlockIds: [],
    surface: null,
    store: {
      getBlockTaskState: vi.fn(),
      setBlockProp: vi.fn(),
      setBlockProps: vi.fn(),
      setPropsOfBlocks: vi.fn(),
      applyOps: vi.fn(),
    },
    exec: vi.fn(async () => {}),
    ...partial,
  };
}

function event(
  key: string,
  mods: Partial<
    Pick<DispatchableKeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">
  > = {},
): DispatchableKeyboardEvent {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
    preventDefault: vi.fn(),
  };
}

describe("createDispatcher — R12 dispatch order", () => {
  it("step 1: composing always falls through, never preventDefault, never execs", () => {
    const dispatcher = createDispatcher({
      getBindings: () => [{ key: "A", command: "x.y", source: "base", order: 0 }],
    });
    const e = event("a");
    const c = ctx({ composing: true });
    const handled = dispatcher.handleKeyDown(e, c);
    expect(handled).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(c.exec).not.toHaveBeenCalled();
  });

  it("step 2: popup-open passthrough keys fall through even if a binding would otherwise match", () => {
    const dispatcher = createDispatcher({
      getBindings: () => [
        { key: "Escape", command: "block.selectBlock", source: "base", order: 0 },
      ],
    });
    for (const key of ["Escape", "Enter", "ArrowUp", "ArrowDown", "Tab"]) {
      const e = event(key);
      const c = ctx({ popupOpen: true });
      expect(dispatcher.handleKeyDown(e, c)).toBe(false);
      expect(e.preventDefault).not.toHaveBeenCalled();
      expect(c.exec).not.toHaveBeenCalled();
    }
  });

  it("step 2 asks popupTakesKey: a key the popup never receives is dispatched (B-203)", () => {
    const dispatcher = createDispatcher({
      getBindings: () => [
        { key: "Alt+Enter", command: "nav.followLink", source: "base", order: 0 },
        { key: "Enter", command: "block.split", source: "base", order: 1 },
      ],
      // The editor-fed rule: popup keys, but only without Cmd/Ctrl/Alt.
      popupTakesKey: (e) => ["Enter"].includes(e.key) && !e.altKey && !e.metaKey && !e.ctrlKey,
    });
    const altEnter = event("Enter", { altKey: true });
    const c = ctx({ popupOpen: true, editorFocused: true });
    expect(dispatcher.handleKeyDown(altEnter, c)).toBe(true);
    expect(c.exec).toHaveBeenCalledWith("nav.followLink", undefined);

    const enter = event("Enter");
    const c2 = ctx({ popupOpen: true, editorFocused: true });
    expect(dispatcher.handleKeyDown(enter, c2)).toBe(false);
    expect(c2.exec).not.toHaveBeenCalled();
  });

  it("a popup-open passthrough key that ISN'T in the special set still dispatches normally", () => {
    const dispatcher = createDispatcher({
      getBindings: () => [{ key: "Cmd+B", command: "format.bold", source: "base", order: 0 }],
    });
    const e = event("b", { metaKey: true });
    const c = ctx({ popupOpen: true, editorFocused: true });
    expect(dispatcher.handleKeyDown(e, c)).toBe(true);
    expect(c.exec).toHaveBeenCalledWith("format.bold", undefined);
  });

  it("step 3: resolves the token, execs the first when-true row's command, and preventDefaults", () => {
    const dispatcher = createDispatcher({
      getBindings: () => [
        { key: "Cmd+B", command: "format.bold", when: "editorFocused", source: "base", order: 0 },
      ],
    });
    const e = event("b", { metaKey: true });
    const c = ctx({ editorFocused: true });
    expect(dispatcher.handleKeyDown(e, c)).toBe(true);
    expect(e.preventDefault).toHaveBeenCalledOnce();
    expect(c.exec).toHaveBeenCalledWith("format.bold", undefined);
  });

  it("never matches edit.paste's Cmd+V: the native paste event must not be cancelled (R33, B-536)", () => {
    const dispatcher = createDispatcher({
      getBindings: () => [
        { key: "Cmd+V", command: "edit.paste", when: "editorFocused", source: "base", order: 0 },
      ],
    });
    const e = event("v", { metaKey: true });
    const c = ctx({ editorFocused: true });
    expect(dispatcher.handleKeyDown(e, c)).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(c.exec).not.toHaveBeenCalled();
  });

  it("skips a row whose `when` is false and falls through to step 4 if nothing else matches", () => {
    const dispatcher = createDispatcher({
      getBindings: () => [
        { key: "Cmd+B", command: "format.bold", when: "editorFocused", source: "base", order: 0 },
      ],
    });
    const e = event("b", { metaKey: true });
    const c = ctx({ editorFocused: false });
    expect(dispatcher.handleKeyDown(e, c)).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(c.exec).not.toHaveBeenCalled();
  });

  it("step 4: an unrecognized key with no matching row returns false", () => {
    const dispatcher = createDispatcher({ getBindings: () => [] });
    const e = event("F5");
    expect(dispatcher.handleKeyDown(e, ctx())).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("passes a row's `args` through to exec", () => {
    const dispatcher = createDispatcher({
      getBindings: () => [
        { key: "Cmd+B", command: "format.bold", source: "user", order: 0, args: { foo: 1 } },
      ],
    });
    const c = ctx();
    dispatcher.handleKeyDown(event("b", { metaKey: true }), c);
    expect(c.exec).toHaveBeenCalledWith("format.bold", { foo: 1 });
  });
});

describe("createDispatcher — resolution order among candidate rows sharing a key", () => {
  it("walks user rows in reverse array order before secondary, then base", () => {
    const bindings: ResolvedBinding[] = [
      { key: "Cmd+D", command: "base.cmd", source: "base", order: 0, when: "false" },
      { key: "Cmd+D", command: "secondary.cmd", source: "secondary", order: 1, when: "false" },
      { key: "Cmd+D", command: "user.first", source: "user", order: 2, when: "false" },
      { key: "Cmd+D", command: "user.second", source: "user", order: 3 }, // no `when` => always true, wins
    ];
    const dispatcher = createDispatcher({ getBindings: () => bindings });
    const c = ctx();
    const e = event("d", { metaKey: true });
    expect(dispatcher.handleKeyDown(e, c)).toBe(true);
    expect(c.exec).toHaveBeenCalledWith("user.second", undefined);
  });
});

describe("createDispatcher — chords (R63)", () => {
  it("completes a two-step chord within the window", () => {
    let t = 0;
    const dispatcher = createDispatcher({
      getBindings: () => [
        { key: "Cmd+K Cmd+S", command: "app.openSettings", source: "user", order: 0 },
      ],
      now: () => t,
    });
    const c = ctx();
    const e1 = event("k", { metaKey: true });
    expect(dispatcher.handleKeyDown(e1, c)).toBe(true); // waiting for step 2
    expect(e1.preventDefault).toHaveBeenCalledOnce();
    expect(c.exec).not.toHaveBeenCalled();

    t += 500;
    const e2 = event("s", { metaKey: true });
    expect(dispatcher.handleKeyDown(e2, c)).toBe(true);
    expect(e2.preventDefault).toHaveBeenCalledOnce();
    expect(c.exec).toHaveBeenCalledWith("app.openSettings", undefined);
  });

  it("cancels a pending chord once the 1500ms window elapses", () => {
    let t = 0;
    const dispatcher = createDispatcher({
      getBindings: () => [
        { key: "Cmd+K Cmd+S", command: "app.openSettings", source: "user", order: 0 },
      ],
      now: () => t,
    });
    const c = ctx();
    dispatcher.handleKeyDown(event("k", { metaKey: true }), c);
    t += 1501;
    const e2 = event("s", { metaKey: true });
    expect(dispatcher.handleKeyDown(e2, c)).toBe(false); // Cmd+S alone matches nothing
    expect(c.exec).not.toHaveBeenCalled();
  });

  it("a key that doesn't continue the pending chord cancels it and is tried fresh", () => {
    const bindings: ResolvedBinding[] = [
      { key: "Cmd+K Cmd+S", command: "app.openSettings", source: "user", order: 0 },
      { key: "Cmd+B", command: "format.bold", source: "base", order: 1 },
    ];
    const dispatcher = createDispatcher({ getBindings: () => bindings });
    const c = ctx({ editorFocused: true });
    dispatcher.handleKeyDown(event("k", { metaKey: true }), c);
    const e2 = event("b", { metaKey: true });
    expect(dispatcher.handleKeyDown(e2, c)).toBe(true);
    expect(c.exec).toHaveBeenCalledWith("format.bold", undefined);
    expect(c.exec).not.toHaveBeenCalledWith("app.openSettings", undefined);
  });

  it("resetChord() discards in-progress state", () => {
    const dispatcher = createDispatcher({
      getBindings: () => [
        { key: "Cmd+K Cmd+S", command: "app.openSettings", source: "user", order: 0 },
      ],
    });
    const c = ctx();
    dispatcher.handleKeyDown(event("k", { metaKey: true }), c);
    dispatcher.resetChord();
    const e2 = event("s", { metaKey: true });
    expect(dispatcher.handleKeyDown(e2, c)).toBe(false);
  });
});
