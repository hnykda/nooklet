import { describe, expect, it } from "vitest";
import { GRAPH_NAMES, generateGraphName } from "./graph-names.js";

describe("B-644: generateGraphName", () => {
  it("the curated list is about a hundred short, unique, ASCII names", () => {
    expect(GRAPH_NAMES.length).toBeGreaterThanOrEqual(90);
    expect(new Set(GRAPH_NAMES.map((n) => n.toLowerCase())).size).toBe(GRAPH_NAMES.length);
    for (const name of GRAPH_NAMES) {
      expect(name).toMatch(/^[A-Za-z]+( [A-Za-z]+)?$/);
      expect(name.length).toBeLessThanOrEqual(20);
      // " 2"-style suffixes are how a taken name is numbered; a curated one must not look like one.
      expect(name).not.toMatch(/\d/);
    }
    expect(GRAPH_NAMES).not.toContain("This device");
  });

  it("never returns a name already taken while curated names are left", () => {
    const taken: string[] = [];
    for (let i = 0; i < GRAPH_NAMES.length; i++) {
      const name = generateGraphName(taken);
      expect(GRAPH_NAMES).toContain(name);
      expect(taken).not.toContain(name);
      taken.push(name);
    }
    expect(new Set(taken).size).toBe(GRAPH_NAMES.length);
  });

  it("treats case and spacing as the same name", () => {
    const allButOne = GRAPH_NAMES.slice(1).map((n) => `  ${n.toUpperCase().replace(" ", "   ")} `);
    expect(generateGraphName(allButOne)).toBe(GRAPH_NAMES[0]);
  });

  it("numbers a name once every curated one is taken: 2, then 3, skipping numbers in use", () => {
    const random = () => 0; // always the first curated name
    const first = GRAPH_NAMES[0] as string;
    const taken = [...GRAPH_NAMES];
    expect(generateGraphName(taken, random)).toBe(`${first} 2`);
    taken.push(`${first} 2`);
    expect(generateGraphName(taken, random)).toBe(`${first} 3`);
    taken.push(`${first} 4`);
    expect(generateGraphName(taken, random)).toBe(`${first} 3`);
    taken.push(`${first} 3`);
    expect(generateGraphName(taken, random)).toBe(`${first} 5`);
  });

  it('ignores names outside the list (a renamed graph, an old "This device")', () => {
    const name = generateGraphName(["This device", "Work notes"], () => 0);
    expect(name).toBe(GRAPH_NAMES[0]);
  });

  it("a random() just below 1 still stays in range", () => {
    expect(GRAPH_NAMES).toContain(generateGraphName([], () => 0.9999999999));
  });
});
