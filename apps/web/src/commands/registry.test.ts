import { describe, expect, it } from "vitest";
import { CommandRegistrationError, createCommandRegistry } from "./registry.js";
import type { Command } from "./types.js";

function cmd(overrides: Partial<Command> & Pick<Command, "id">): Command {
  return { title: overrides.id, category: "Block", defaultKeys: {}, run: () => {}, ...overrides };
}

describe("createCommandRegistry — register/get/list/unregister/has", () => {
  it("registers and retrieves a command", () => {
    const registry = createCommandRegistry();
    const c = cmd({ id: "block.indent" });
    registry.register(c);
    expect(registry.get("block.indent")).toBe(c);
    expect(registry.has("block.indent")).toBe(true);
    expect(registry.list()).toEqual([c]);
  });

  it("get() returns undefined for an unknown id", () => {
    expect(createCommandRegistry().get("nope.nope")).toBeUndefined();
  });

  it("unregister removes a command", () => {
    const registry = createCommandRegistry();
    registry.register(cmd({ id: "block.indent" }));
    registry.unregister("block.indent");
    expect(registry.has("block.indent")).toBe(false);
    expect(registry.list()).toEqual([]);
  });

  it("unregister of an unknown id is a no-op", () => {
    const registry = createCommandRegistry();
    expect(() => registry.unregister("nope.nope")).not.toThrow();
  });

  it("rejects registering the same id twice", () => {
    const registry = createCommandRegistry();
    registry.register(cmd({ id: "block.indent" }));
    expect(() => registry.register(cmd({ id: "block.indent" }))).toThrow(CommandRegistrationError);
  });
});

describe("createCommandRegistry — id shape validation (R2)", () => {
  it.each(["block.indent", "task.cycle", "nav.journals", "plugin.mermaid.insertDiagram"])(
    "accepts %s",
    (id) => {
      const registry = createCommandRegistry();
      expect(() => registry.register(cmd({ id }))).not.toThrow();
    },
  );

  it.each([
    "Block.indent", // area must start lowercase
    "block", // missing verb segment
    "block_indent", // no dot
    "block.in-dent", // hyphen not allowed
    "unknownarea.verb", // not a recognized core area
  ])("rejects %s", (id) => {
    const registry = createCommandRegistry();
    expect(() => registry.register(cmd({ id }))).toThrow(CommandRegistrationError);
  });

  it("the R2 regex's verb segment technically permits an uppercase-leading verb (spec's literal grammar, not a style rule)", () => {
    const registry = createCommandRegistry();
    expect(() => registry.register(cmd({ id: "block.Indent" }))).not.toThrow();
  });

  it("requires plugin ids to be prefixed plugin.<pluginId>.<verb>", () => {
    const registry = createCommandRegistry();
    expect(() => registry.register(cmd({ id: "plugin.mermaid.insertDiagram" }))).not.toThrow();
    expect(() => registry.register(cmd({ id: "plugin.mermaid" }))).toThrow(
      CommandRegistrationError,
    );
  });
});

describe("createCommandRegistry — `when` validated at registration time (R10)", () => {
  it("rejects a command whose `when` has a syntax error", () => {
    const registry = createCommandRegistry();
    expect(() => registry.register(cmd({ id: "block.indent", when: "editorFocused &&" }))).toThrow(
      CommandRegistrationError,
    );
  });

  it("rejects a command whose `when` bare-tests a non-boolean field", () => {
    const registry = createCommandRegistry();
    expect(() => registry.register(cmd({ id: "block.indent", when: "platform" }))).toThrow(
      CommandRegistrationError,
    );
  });

  it("accepts a valid `when`", () => {
    const registry = createCommandRegistry();
    expect(() =>
      registry.register(cmd({ id: "block.indent", when: "editorFocused && !hasSelection" })),
    ).not.toThrow();
  });

  it("accepts a command with no `when` at all (always enabled, R5)", () => {
    const registry = createCommandRegistry();
    expect(() => registry.register(cmd({ id: "app.toggleSidebar" }))).not.toThrow();
  });
});
