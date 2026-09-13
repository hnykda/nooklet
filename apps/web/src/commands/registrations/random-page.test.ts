import { describe, expect, it } from "vitest";
import {
  createFakeRandomPageHost,
  createRandomPageCommands,
  pickRandomPage,
} from "./random-page.js";

const PAGES = [
  { id: "a", name: "Zahrada" },
  { id: "b", name: "Řeka" },
  { id: "c", name: "Projects/Aurora" },
];

describe("pickRandomPage", () => {
  it("spreads picks over every candidate", () => {
    expect(pickRandomPage(PAGES, null, () => 0)?.id).toBe("a");
    expect(pickRandomPage(PAGES, null, () => 0.5)?.id).toBe("b");
    expect(pickRandomPage(PAGES, null, () => 0.999)?.id).toBe("c");
    // A stub returning exactly 1 must not index past the end.
    expect(pickRandomPage(PAGES, null, () => 1)?.id).toBe("c");
  });

  it("never picks the page already on screen, matched the way page names are", () => {
    for (const r of [0, 0.3, 0.6, 0.99]) {
      expect(pickRandomPage(PAGES, "  zahrada ", () => r)?.id).not.toBe("a");
    }
  });

  it("is null when there is nowhere else to go", () => {
    expect(pickRandomPage([], null)).toBeNull();
    expect(pickRandomPage([{ id: "a", name: "Only" }], "Only")).toBeNull();
  });
});

describe("nav.randomPage", () => {
  it("opens the picked page, and does nothing when there is none", async () => {
    const host = createFakeRandomPageHost(PAGES, "Řeka");
    const [command] = createRandomPageCommands({ randomPage: host, random: () => 0.99 });
    expect(command?.id).toBe("nav.randomPage");
    await command?.run({} as never);
    expect(host.opened).toEqual(["c"]);

    const empty = createFakeRandomPageHost([], null);
    await createRandomPageCommands({ randomPage: empty })[0]?.run({} as never);
    expect(empty.opened).toEqual([]);
  });
});
