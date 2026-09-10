/**
 * Shared test fixtures for the editor's pure-logic tests (`commands.test.ts`, `task.test.ts`,
 * `paste.test.ts`, `history.test.ts`, `tree.test.ts`). Not itself a `.test.ts` file, so vitest
 * never tries to run it as a test suite.
 */
import { orderBetween } from "@nooklet/core";
import { buildEditorTree } from "./tree.js";
import type { Clock, EditableBlock, EditorTree } from "./types.js";

export function makeBlock(
  overrides: Partial<EditableBlock> & Pick<EditableBlock, "id">,
): EditableBlock {
  return {
    parentId: null,
    order: "a0",
    content: "",
    marker: null,
    priority: null,
    collapsed: false,
    scheduled: null,
    deadline: null,
    repeat: null,
    doneAt: null,
    listNumber: false,
    ...overrides,
  };
}

/** A deterministic fake `Clock`: increasing fake HLC strings, no wall-clock dependency, so
 * op-sequence-sensitive assertions (`toMatchObject`, counting) are stable across runs. */
export function makeFakeClock(device = "aaaaaaaa"): Clock {
  let n = 0;
  return {
    device,
    next: () => `2026-09-10T00:00:00.000Z-${(n++).toString(16).padStart(4, "0")}-${device}`,
  };
}

export function tree(...blocks: EditableBlock[]): EditorTree {
  return buildEditorTree("page1", blocks);
}

/** `n` ascending order keys, for building a row of siblings without hand-computing fractions. */
export function orders(n: number): string[] {
  const out: string[] = [];
  let prev: string | null = null;
  for (let i = 0; i < n; i++) {
    const k = orderBetween(prev, null);
    out.push(k);
    prev = k;
  }
  return out;
}
