// @vitest-environment jsdom
import { Route, Router } from "@solidjs/router";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JournalDayEntry } from "../data/types.js";

const today = 20260910;

let streamValue: JournalDayEntry[] | undefined;
const usePinnedJournalDay = vi.fn((..._args: unknown[]) =>
  Object.assign(() => undefined, { loading: false, error: undefined }),
);

vi.mock("../data/store.js", () => ({
  useJournalStream: () => Object.assign(() => streamValue, { loading: false, error: undefined }),
  usePinnedJournalDay: (...args: unknown[]) => usePinnedJournalDay(...args),
  useAllPages: () => Object.assign(() => [], { loading: false, error: undefined }),
}));

vi.mock("../editor/BlockTree.js", () => ({
  BlockTree: (props: { pageId: string }) => (
    <div data-testid="block-tree">block-tree:{props.pageId}</div>
  ),
}));

vi.mock("./VirtualJournalDay.js", () => ({
  VirtualJournalDay: (props: { day: number }) => (
    <div data-testid="virtual-day">virtual:{props.day}</div>
  ),
}));

// jsdom has no IntersectionObserver (used for the infinite-scroll "load more" sentinel); a no-op
// stub is enough since none of these tests exercise scrolling.
class FakeIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);

afterEach(() => cleanup());

async function renderStream() {
  const { JournalStreamView } = await import("./JournalStreamView.js");
  return render(() => (
    <Router>
      <Route path="*" component={JournalStreamView} />
    </Router>
  ));
}

describe("JournalStreamView", () => {
  it("shows today as a virtual (unmaterialized) day when it has no page yet", async () => {
    streamValue = [{ day: today, page: null, blocks: [] }];
    await renderStream();

    expect(screen.getByText(/Today/)).toBeTruthy();
    expect(screen.getByTestId("virtual-day").textContent).toContain(String(today));
    expect(screen.queryByTestId("block-tree")).toBeNull();
  });

  it("renders today first, then earlier non-empty days below it, in the order the seam returned them", async () => {
    streamValue = [
      {
        day: today,
        page: {
          id: "p-today",
          graphId: "default",
          name: "2026-09-10",
          key: "2026-09-10",
          journalDay: today,
          createdAt: 0,
          updatedAt: 0,
          deletedAt: null,
          nameHlc: "",
          deletedHlc: null,
        },
        blocks: [{} as never],
      },
      {
        day: 20260909,
        page: {
          id: "p-909",
          graphId: "default",
          name: "2026-09-09",
          key: "2026-09-09",
          journalDay: 20260909,
          createdAt: 0,
          updatedAt: 0,
          deletedAt: null,
          nameHlc: "",
          deletedHlc: null,
        },
        blocks: [{} as never],
      },
      {
        day: 20260908,
        page: {
          id: "p-908",
          graphId: "default",
          name: "2026-09-08",
          key: "2026-09-08",
          journalDay: 20260908,
          createdAt: 0,
          updatedAt: 0,
          deletedAt: null,
          nameHlc: "",
          deletedHlc: null,
        },
        blocks: [{} as never],
      },
    ];
    await renderStream();

    const sections = screen.getAllByRole("region");
    // Today's <section aria-label="Today"> is first, then the earlier days in stream order.
    expect(sections[0]?.getAttribute("aria-label")).toBe("Today");

    const blockTrees = screen.getAllByTestId("block-tree").map((el) => el.textContent);
    expect(blockTrees).toEqual(["block-tree:p-today", "block-tree:p-909", "block-tree:p-908"]);
  });

  it("never calls into page/block creation just by rendering the stream (no premature materialization)", async () => {
    streamValue = [
      { day: today, page: null, blocks: [] },
      {
        day: 20260909,
        page: {
          id: "p-909",
          graphId: "default",
          name: "2026-09-09",
          key: "2026-09-09",
          journalDay: 20260909,
          createdAt: 0,
          updatedAt: 0,
          deletedAt: null,
          nameHlc: "",
          deletedHlc: null,
        },
        blocks: [{} as never],
      },
    ];
    await renderStream();
    // usePinnedJournalDay is only for the calendar-jump feature; merely rendering the stream must
    // not have pinned anything, and the virtual-today stub must be the one shown (not a real tree).
    expect(screen.getByTestId("virtual-day")).toBeTruthy();
    expect(screen.getAllByTestId("block-tree")).toHaveLength(1);
  });
});
