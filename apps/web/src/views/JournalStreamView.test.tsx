// @vitest-environment jsdom

import { todayJournalDay } from "@nooklet/core";
import { Route, Router } from "@solidjs/router";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JournalDayEntry } from "../data/types.js";

// Derived, never hardcoded: the virtual-today row is by definition whatever day it is *now*, so a
// literal here silently rots at the next midnight (it did — this test broke when the date rolled
// over mid-development).
const today = todayJournalDay();

// The local day, as a signal a test can move (the real clock is `day-clock.test.ts`'s subject).
const [clockDay, setClockDay] = createSignal(today);
vi.mock("../data/day-clock.js", () => ({ currentDay: () => clockDay() }));

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

// One agenda read for the whole stream; the section itself is `JournalAgenda.test.tsx`'s subject.
const useAgendaTasks = vi.fn(() => Object.assign(() => [], { loading: false, error: undefined }));
vi.mock("../data/agenda.js", () => ({ useAgendaTasks: () => useAgendaTasks() }));
vi.mock("./JournalAgenda.js", () => ({
  JournalAgenda: (props: { day: number; today: number }) => (
    <div data-testid="agenda">
      agenda:{props.day}/{props.today}
    </div>
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

afterEach(() => {
  cleanup();
  setClockDay(today);
  useAgendaTasks.mockClear();
});

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

  it("puts a Scheduled and deadline section under every day, from one shared read", async () => {
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
    const agendas = screen.getAllByTestId("agenda").map((el) => el.textContent);
    expect(agendas).toEqual([`agenda:${today}/${today}`, `agenda:20260909/${today}`]);
    expect(useAgendaTasks).toHaveBeenCalledTimes(1);
  });

  it("moves Today to the new day when the local day changes (B-170)", async () => {
    const tomorrow = today + 1; // only compared, never parsed as a date
    streamValue = [{ day: today, page: null, blocks: [] }];
    await renderStream();
    expect(screen.getByTestId("virtual-day").textContent).toBe(`virtual:${today}`);

    setClockDay(tomorrow);
    expect(screen.getByTestId("virtual-day").textContent).toBe(`virtual:${tomorrow}`);
    expect(screen.getAllByTestId("agenda")[0]?.textContent).toBe(`agenda:${tomorrow}/${tomorrow}`);
  });
});
