// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JournalDayEntry } from "../data/types.js";
import { JournalDayOutline } from "./JournalDayOutline.js";

let treeMounts = 0;
vi.mock("../editor/BlockTree.js", () => ({
  BlockTree: (props: { pageId: string }) => {
    treeMounts++;
    return <div data-testid="block-tree">tree:{props.pageId}</div>;
  },
}));

// Stands in for the draft: "start" is a committed first line, "fail" a write that did not land.
vi.mock("./VirtualJournalDay.js", () => ({
  VirtualJournalDay: (props: { day: number; onStarted?: (started: boolean) => void }) => (
    <div data-testid="virtual-day">
      <button type="button" onClick={() => props.onStarted?.(true)}>
        start
      </button>
      <button type="button" onClick={() => props.onStarted?.(false)}>
        fail
      </button>
    </div>
  ),
  JournalDayLoading: () => <div data-testid="day-loading" />,
}));

afterEach(() => {
  cleanup();
  treeMounts = 0;
});

const DAY = 20260722;
const page = {
  id: "p-day",
  graphId: "default",
  name: "2026-07-22",
  key: "2026-07-22",
  journalDay: DAY,
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  nameHlc: "",
  deletedHlc: null,
};

function renderOutline(initial: JournalDayEntry | undefined) {
  const [entry, setEntry] = createSignal<JournalDayEntry | undefined>(initial);
  render(() => <JournalDayOutline day={DAY} entry={entry()} />);
  return setEntry;
}

describe("JournalDayOutline", () => {
  it("shows a loading row, not a draft, until the stream has answered for the day (B-410)", () => {
    const setEntry = renderOutline(undefined);
    expect(screen.getByTestId("day-loading")).toBeTruthy();
    expect(screen.queryByTestId("virtual-day")).toBeNull();

    setEntry({ day: DAY, page: null, blocks: [] });
    expect(screen.queryByTestId("day-loading")).toBeNull();
    expect(screen.getByTestId("virtual-day")).toBeTruthy();
  });

  it("keeps the draft, and the tree it started, when the stream then reports the day's page (B-411)", () => {
    const setEntry = renderOutline({ day: DAY, page: null, blocks: [] });
    fireEvent.click(screen.getByRole("button", { name: "start" }));

    // The stream's refetch sees the page the draft just wrote. Swapping in a second tree for it
    // unmounted the editor the caret was in.
    setEntry({ day: DAY, page, blocks: [{} as never] });
    setEntry({ day: DAY, page, blocks: [{} as never] });
    expect(screen.getByTestId("virtual-day")).toBeTruthy();
    expect(treeMounts).toBe(0);
  });

  it("shows the day's own tree when the page arrives from elsewhere while the draft is unused", () => {
    const setEntry = renderOutline({ day: DAY, page: null, blocks: [] });
    setEntry({ day: DAY, page, blocks: [{} as never] });
    expect(screen.queryByTestId("virtual-day")).toBeNull();
    expect(screen.getByTestId("block-tree").textContent).toBe("tree:p-day");
  });

  it("goes back to following the stream when the draft's write failed", () => {
    const setEntry = renderOutline({ day: DAY, page: null, blocks: [] });
    fireEvent.click(screen.getByRole("button", { name: "start" }));
    fireEvent.click(screen.getByRole("button", { name: "fail" }));
    setEntry({ day: DAY, page, blocks: [{} as never] });
    expect(screen.getByTestId("block-tree").textContent).toBe("tree:p-day");
  });
});
