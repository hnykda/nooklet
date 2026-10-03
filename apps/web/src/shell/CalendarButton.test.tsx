// @vitest-environment jsdom
/**
 * B-583: the calendar as a top-bar icon+popover, mirroring `live/ConsentBadge.test.tsx`'s shape
 * for the same kind of control. `views/Calendar.tsx`'s own grid logic (month paging, day math) is
 * unchanged and untested here; this covers what's new — the trigger, the popover, marking days
 * with content, and jumping to `/journals` from elsewhere.
 */
import { todayJournalDay } from "@nooklet/core";
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearPinnedJournalDay, pinnedJournalDay } from "../app/journal-nav.js";

const daysWithContentMock = vi.fn();
vi.mock("../data/store.js", () => ({
  useJournalDaysWithContent: (...args: unknown[]) => daysWithContentMock(...args),
}));

import { CalendarButton } from "./CalendarButton.js";

// Never hardcoded (see `JournalStreamView.test.tsx`'s own note): the popover opens on the month
// containing whatever day it is *now*. Day 1 and day 3 of that month exist regardless of what
// "now" is, so content/no-content cells can be picked without caring which month it is.
// `plainDay` must never be Today: picking Today deliberately clears the pin (`pinJournalDay`), so
// a fixed day 3 made the pin tests fail on the 3rd of every month (B-590). Day 4 also always exists.
const today = todayJournalDay();
const monthStart = Math.floor(today / 100) * 100 + 1;
const contentDay = monthStart;
const plainDay = today === monthStart + 2 ? monthStart + 3 : monthStart + 2;

function resource(days: Iterable<number>) {
  return Object.assign(() => new Set(days), { loading: false, error: undefined });
}

afterEach(() => {
  cleanup();
  clearPinnedJournalDay();
  daysWithContentMock.mockReset();
});

function renderAt(path: string) {
  const history = createMemoryHistory();
  history.set({ value: path });
  render(() => (
    <MemoryRouter history={history}>
      <Route path="*" component={CalendarButton} />
    </MemoryRouter>
  ));
  return history;
}

describe("CalendarButton", () => {
  it("is an icon-only top-bar button, closed until clicked", () => {
    daysWithContentMock.mockReturnValue(resource([]));
    renderAt("/journals");

    const button = screen.getByRole("button", { name: "Calendar" });
    expect(button.getAttribute("title")).toBe("Jump to a day");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.textContent).toBe("");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const dialog = screen.getByRole("dialog", { name: "Jump to a day" });
    expect(dialog).toBeTruthy();

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes the popover on Escape", () => {
    daysWithContentMock.mockReturnValue(resource([]));
    renderAt("/journals");
    fireEvent.click(screen.getByRole("button", { name: "Calendar" }));
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("marks only the days useJournalDaysWithContent reports (B-583)", () => {
    daysWithContentMock.mockReturnValue(resource([contentDay]));
    renderAt("/journals");
    fireEvent.click(screen.getByRole("button", { name: "Calendar" }));

    const dotted = screen.getByRole("button", { name: String(contentDay % 100) });
    expect(dotted.className).toContain("calendar-day-has-content");

    const plain = screen.getByRole("button", { name: String(plainDay % 100) });
    expect(plain.className).not.toContain("calendar-day-has-content");
  });

  it("wires the hook to the popover's own live range, moving as the visible month pages", () => {
    daysWithContentMock.mockReturnValue(resource([]));
    renderAt("/journals");
    fireEvent.click(screen.getByRole("button", { name: "Calendar" }));

    // `useJournalDaysWithContent` is called once, with accessors over a shared `range` signal —
    // not re-called per page — so the SAME accessors must report the new month once it pages.
    const [firstDay] = daysWithContentMock.mock.calls.at(-1) as [() => number, () => number];
    expect(firstDay()).toBe(monthStart);

    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    // YYYYMMDD integers only increase moving forward in the calendar, month or year boundary
    // included, so this holds regardless of which month "today" happens to fall in.
    expect(firstDay()).toBeGreaterThan(monthStart);
  });

  it("picking a day pins it, closes the popover, and jumps to /journals from elsewhere", async () => {
    daysWithContentMock.mockReturnValue(resource([]));
    const history = renderAt("/search");
    fireEvent.click(screen.getByRole("button", { name: "Calendar" }));
    fireEvent.click(screen.getByRole("button", { name: String(plainDay % 100) }));
    // solid-router's navigate() resolves via a microtask (it wraps the update in a transition).
    await new Promise((r) => setTimeout(r, 5));

    expect(pinnedJournalDay()).toBe(plainDay);
    expect(history.get()).toBe("/journals");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not navigate away when already on /journals", async () => {
    daysWithContentMock.mockReturnValue(resource([]));
    const history = renderAt("/journals");
    fireEvent.click(screen.getByRole("button", { name: "Calendar" }));
    fireEvent.click(screen.getByRole("button", { name: String(plainDay % 100) }));
    await Promise.resolve();

    expect(pinnedJournalDay()).toBe(plainDay);
    expect(history.get()).toBe("/journals");
  });
});
