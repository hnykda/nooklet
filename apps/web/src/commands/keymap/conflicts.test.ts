import { describe, expect, it } from "vitest";
import type { ResolvedBinding } from "../types.js";
import { detectConflicts } from "./conflicts.js";

function row(
  overrides: Partial<ResolvedBinding> & Pick<ResolvedBinding, "key" | "command">,
): ResolvedBinding {
  return { source: "base", order: 0, ...overrides };
}

describe("detectConflicts — the spec's conflict-detection test table (R67)", () => {
  it("flags collapse/expand as conflicting when forced onto the same key (documented false positive, Open issue 8)", () => {
    const rows = [
      row({
        key: "Cmd+Up",
        command: "block.collapse",
        when: "(editorFocused || blockSelected) && hasChildren && !isCollapsed",
      }),
      row({
        key: "Cmd+Up",
        command: "block.expand",
        when: "(editorFocused || blockSelected) && hasChildren && isCollapsed",
      }),
    ];
    expect(detectConflicts(rows)).toEqual([
      { key: "Cmd+Up", commands: ["block.collapse", "block.expand"] },
    ]);
  });

  it("does not flag mergeWithPrevious vs deleteSelected on Backspace (editorFocused/blockSelected are provably disjoint)", () => {
    const rows = [
      row({
        key: "Backspace",
        command: "block.mergeWithPrevious",
        when: "editorFocused && atLineStart && !hasSelection",
      }),
      row({ key: "Backspace", command: "block.deleteSelected", when: "blockSelected" }),
    ];
    expect(detectConflicts(rows)).toEqual([]);
  });

  it("flags two always-on commands sharing a key with no exclusivity relationship", () => {
    const rows = [
      row({ key: "Cmd+Shift+D", command: "block.duplicate" }),
      row({ key: "Cmd+Shift+D", command: "plugin.foo.thing" }),
    ];
    expect(detectConflicts(rows)).toEqual([
      { key: "Cmd+Shift+D", commands: ["block.duplicate", "plugin.foo.thing"] },
    ]);
  });
});

describe("detectConflicts — general behavior", () => {
  it("does not flag a key used by only one command", () => {
    const rows = [row({ key: "Enter", command: "block.split" })];
    expect(detectConflicts(rows)).toEqual([]);
  });

  it("does not flag the same command appearing twice at one key (base + user row)", () => {
    const rows = [
      row({ key: "Cmd+B", command: "format.bold", source: "base" }),
      row({ key: "Cmd+B", command: "format.bold", source: "user", when: "editorFocused" }),
    ];
    expect(detectConflicts(rows)).toEqual([]);
  });

  it("reports multiple conflicting keys, sorted by key", () => {
    const rows = [
      row({ key: "Cmd+Shift+D", command: "block.duplicate" }),
      row({ key: "Cmd+Shift+D", command: "plugin.foo.thing" }),
      row({ key: "Cmd+A", command: "block.selectAll" }),
      row({ key: "Cmd+A", command: "plugin.bar.selectAllThing" }),
    ];
    expect(detectConflicts(rows).map((c) => c.key)).toEqual(["Cmd+A", "Cmd+Shift+D"]);
  });
});
