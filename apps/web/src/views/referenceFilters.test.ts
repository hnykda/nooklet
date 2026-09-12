// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  loadReferenceFilter,
  loadReferenceSort,
  saveReferenceFilter,
  saveReferenceSort,
} from "./referenceFilters.js";

beforeEach(() => {
  localStorage.clear();
});

describe("reference filter persistence", () => {
  it("remembers a filter per page and forgets an emptied one", () => {
    expect(loadReferenceFilter("aurora")).toEqual({ include: [], exclude: [] });
    saveReferenceFilter("aurora", { include: ["q3"], exclude: ["done"] });
    saveReferenceFilter("other", { include: ["x"], exclude: [] });
    expect(loadReferenceFilter("aurora")).toEqual({ include: ["q3"], exclude: ["done"] });
    expect(loadReferenceFilter("other")).toEqual({ include: ["x"], exclude: [] });

    // Clearing a page's filter removes its entry; clearing the last one removes the key, so a
    // long-lived graph does not accumulate hundreds of empty records.
    saveReferenceFilter("aurora", { include: [], exclude: [] });
    expect(loadReferenceFilter("aurora")).toEqual({ include: [], exclude: [] });
    expect(JSON.parse(localStorage.getItem("nooklet.referenceFilters") ?? "{}")).toEqual({
      other: { include: ["x"], exclude: [] },
    });
    saveReferenceFilter("other", { include: [], exclude: [] });
    expect(localStorage.getItem("nooklet.referenceFilters")).toBeNull();
  });

  it("survives a corrupt value", () => {
    localStorage.setItem("nooklet.referenceFilters", "{not json");
    expect(loadReferenceFilter("aurora")).toEqual({ include: [], exclude: [] });
    localStorage.setItem("nooklet.referenceFilters", JSON.stringify({ aurora: { include: 3 } }));
    expect(loadReferenceFilter("aurora")).toEqual({ include: [], exclude: [] });
  });

  it("keeps the sort as one preference, defaulting to recent", () => {
    expect(loadReferenceSort()).toBe("recent");
    saveReferenceSort("name");
    expect(loadReferenceSort()).toBe("name");
    localStorage.setItem("nooklet.referenceSort", "bogus");
    expect(loadReferenceSort()).toBe("recent");
  });
});
