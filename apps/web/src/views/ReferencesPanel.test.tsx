// @vitest-environment jsdom
/**
 * The linked-references heading count (refs-count, owner decision 2026-10-03): Logseq's number —
 * blocks that link the page themselves — and "F of T" under a filter. The counting rule is
 * `referenceNesting.test.ts#countDirectReferences`; this checks the panel wires it to the heading.
 * The panel against a real server is `e2e/tests/references-*.spec.ts`.
 */
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BacklinkRef, BacklinksResult } from "../data/api-client.js";
import type { ReferenceTrees } from "../data/reference-trees.js";
import type { ReferenceFilter } from "./referenceGrouping.js";

const state: {
  result: BacklinksResult;
  error: unknown;
  hasServer: boolean;
  trees: ReferenceTrees | undefined;
  filter: ReferenceFilter;
} = {
  result: emptyResult(),
  error: undefined,
  hasServer: true,
  trees: undefined,
  filter: { include: [], exclude: [] },
};

function emptyResult(): BacklinksResult {
  return {
    target: "T",
    linked: [],
    linkedTotal: 0,
    linkedDirectTotal: 0,
    unlinked: [],
    unlinkedTruncated: false,
    taggedPages: [],
    taggedTotal: 0,
  };
}

vi.mock("../data/store.js", () => {
  const resource = Object.defineProperties(
    () => {
      if (state.error !== undefined) throw state.error;
      return state.result;
    },
    { loading: { get: () => false }, error: { get: () => state.error } },
  );
  return { useLinkedReferences: () => [resource, { refetch: () => {} }] };
});
vi.mock("../data/bootstrap.js", () => ({
  hasSyncTarget: () => state.hasServer,
  apiBaseUrl: () => "",
  authToken: () => undefined,
}));
vi.mock("../data/reference-trees.js", () => ({
  useReferenceListTrees: () => () => state.trees,
}));
vi.mock("./ReferenceItem.js", () => ({ ReferenceGroups: () => null }));
vi.mock("./TaggedPages.js", () => ({ TaggedPages: () => null }));
vi.mock("./referenceFilters.js", () => ({
  loadReferenceFilter: () => state.filter,
  saveReferenceFilter: () => {},
  loadReferenceSort: () => "recent",
  saveReferenceSort: () => {},
}));

import { ReferencesPanel } from "./ReferencesPanel.js";

afterEach(cleanup);

const ref = (id: string, page: string, text: string, direct: boolean): BacklinkRef => ({
  id,
  page,
  text,
  direct,
  updatedAt: "2026-10-01T00:00:00.000Z",
});

// Page "Mon": `a` links T with child `a1` (inherits; mentions #work) and grandchild `a2` (links T).
// Page "Tue": `b` links T and #home, child `b1` mentions #work but only inherits T.
const linked = [
  ref("a", "Mon", "call about [[T]]", true),
  ref("a1", "Mon", "notes #work", false),
  ref("a2", "Mon", "again [[T]]", true),
  ref("b", "Tue", "[[T]] #home", true),
  ref("b1", "Tue", "follow up #work", false),
];

beforeEach(() => {
  state.result = { ...emptyResult(), linked, linkedTotal: 5, linkedDirectTotal: 3 };
  state.trees = {
    status: "ok",
    requested: new Set(linked.map((r) => r.id)),
    ancestors: new Map([
      ["a", []],
      ["a1", ["a"]],
      ["a2", ["a1", "a"]],
      ["b", []],
      ["b1", ["b"]],
    ]),
    nodes: new Map(),
    ancestorText: new Map(),
  } as unknown as ReferenceTrees;
  state.filter = { include: [], exclude: [] };
  state.error = undefined;
  state.hasServer = true;
});

function heading(container: HTMLElement): string | null | undefined {
  return container.querySelector(".linked-references .references-toggle .reference-count")
    ?.textContent;
}

describe("ReferencesPanel linked heading count", () => {
  it("counts blocks that link the page directly, across pages, not every block", () => {
    const { container } = render(() => <ReferencesPanel target="T" onNavigate={() => {}} />);
    expect(heading(container)).toBe("3");
  });

  it("filtered: 'F of T', a direct block counting when a block under it passes", () => {
    // #work is only on `a1` and `b1`, neither direct: their direct ancestors `a` and `b` count
    // (Logseq adds a passing block's parents back); `a2`, direct but failing, does not → 2 of 3.
    state.filter = { include: ["work"], exclude: [] };
    const { container } = render(() => <ReferencesPanel target="T" onNavigate={() => {}} />);
    expect(heading(container)).toBe("2 of 3");
  });

  it("filtered by exclusion", () => {
    // Excluding Mon leaves only page Tue's blocks: b (direct) and b1 → 1 of 3.
    state.filter = { include: [], exclude: ["mon"] };
    const { container } = render(() => <ReferencesPanel target="T" onNavigate={() => {}} />);
    expect(heading(container)).toBe("1 of 3");
  });

  it("unfiltered uses the server's direct total when the fetch stopped short", () => {
    state.result = { ...state.result, linkedTotal: 9000, linkedDirectTotal: 812 };
    const { container } = render(() => <ReferencesPanel target="T" onNavigate={() => {}} />);
    expect(heading(container)).toBe("812");
  });

  it("the unlinked heading still counts every mention", () => {
    state.result = {
      ...state.result,
      unlinked: [ref("u1", "Wed", "T here", false), ref("u2", "Wed", "and T", false)],
    };
    const { container } = render(() => <ReferencesPanel target="T" onNavigate={() => {}} />);
    expect(
      container.querySelector(".unlinked-references .references-toggle .reference-count")
        ?.textContent,
    ).toBe("2");
  });
});

describe("ReferencesPanel failure and local-only (B-641)", () => {
  it("says so, with Retry, when neither the device nor a server could answer", () => {
    // References come from the replica now; this is left only for a replica that could not
    // build its reference index (and no server to fall back on). The e2e that used to cover it
    // (a refused `page.backlinks`) now shows the device answering instead.
    state.error = new Error("local_refs_unavailable");
    const { container } = render(() => <ReferencesPanel target="T" onNavigate={() => {}} />);
    expect(container.querySelector(".references-error")?.textContent).toContain(
      "Couldn't load references",
    );
    expect(container.querySelector(".references-retry")).not.toBeNull();
  });

  it("offers Link all only when there is a server to run it", () => {
    state.result = {
      ...state.result,
      unlinked: [{ id: "u", page: "Wed", text: "T in passing" }],
    };
    const withServer = render(() => <ReferencesPanel target="T" onNavigate={() => {}} />);
    expect(withServer.container.querySelector(".references-link-all")).not.toBeNull();
    cleanup();
    state.hasServer = false;
    const localOnly = render(() => <ReferencesPanel target="T" onNavigate={() => {}} />);
    expect(localOnly.container.querySelector(".references-link-all")).toBeNull();
    // The mentions themselves are still there: they come from the device.
    expect(localOnly.container.querySelector(".unlinked-references")).not.toBeNull();
  });
});
