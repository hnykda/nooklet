import { describe, expect, it } from "vitest";
import { activeEditorHost } from "../app/editor-host.js";
import type { CommandContext } from "../commands/types.js";
import {
  flushTyping,
  registerOutline,
  registerTypingFlush,
  runOnOutlines,
} from "./outline-registry.js";

describe("outline registry (B-97)", () => {
  it("hands Collapse all / Expand all to every mounted outline, and nothing else", () => {
    const seen: string[][] = [[], []];
    const offA = registerOutline((id) => seen[0]?.push(id));
    const offB = registerOutline((id) => seen[1]?.push(id));
    try {
      expect(runOnOutlines("block.collapseAll")).toBe(2);
      expect(runOnOutlines("block.expandAll")).toBe(2);
      // Undo, indent and friends belong to the focused tree only; fanning them out to every
      // journal day on screen would be a disaster.
      expect(runOnOutlines("edit.undo")).toBe(0);
      expect(runOnOutlines("block.indent")).toBe(0);
      expect(seen).toEqual([
        ["block.collapseAll", "block.expandAll"],
        ["block.collapseAll", "block.expandAll"],
      ]);
    } finally {
      offA();
      offB();
    }
    expect(runOnOutlines("block.collapseAll")).toBe(0);
  });

  it("with nothing focused, the editor host routes page-scoped commands to the outlines", () => {
    const seen: string[] = [];
    const off = registerOutline((id) => seen.push(id));
    try {
      // No BlockTree has registered as the active host, so this is the inert no-op host — the one
      // the palette talks to when nothing is being edited, which used to drop these on the floor.
      void activeEditorHost().runStructuralCommand("block.collapseAll", {} as CommandContext);
      void activeEditorHost().runStructuralCommand("block.split", {} as CommandContext);
    } finally {
      off();
    }
    expect(seen).toEqual(["block.collapseAll"]);
  });
});

describe("typing flush (B-192)", () => {
  it("runs every mounted tree's flush until it unregisters", () => {
    let a = 0;
    let b = 0;
    const offA = registerTypingFlush(() => a++);
    const offB = registerTypingFlush(() => b++);
    flushTyping();
    offA();
    flushTyping();
    offB();
    flushTyping();
    expect([a, b]).toEqual([1, 2]);
  });
});
