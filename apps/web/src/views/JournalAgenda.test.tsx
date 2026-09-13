// @vitest-environment jsdom
/**
 * The "Scheduled and deadline" section as rendered: hidden when empty, grouped by page, overdue
 * dates called out, a row click goes to the task and a heading click to its page, and a failed
 * read hides the section instead of throwing into the journal stream. Which tasks qualify is
 * `agendaDay.test.ts`; the whole path against a real server is
 * `e2e/tests/journal-agenda.spec.ts`.
 */

import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgendaTask } from "../data/agenda.js";
import type { NavigateTarget } from "../data/types.js";

vi.mock("../editor/BlockRowView.js", () => ({ MARKER_GLYPH: { TODO: "☐", DOING: "◐" } }));

import { JournalAgenda } from "./JournalAgenda.js";

const TODAY = 20260913;

function task(over: Partial<AgendaTask>): AgendaTask {
  return {
    id: "t1",
    pageId: "p1",
    pageName: "Project",
    pageJournalDay: null,
    order: "a",
    content: "a task",
    marker: "TODO",
    priority: null,
    scheduledDay: null,
    scheduledTime: null,
    deadlineDay: null,
    deadlineTime: null,
    ...over,
  };
}

function resource(rows: AgendaTask[], error?: unknown) {
  return Object.assign(
    () => {
      if (error) throw error;
      return rows;
    },
    { error },
  );
}

afterEach(() => cleanup());

describe("JournalAgenda", () => {
  it("renders nothing when no task is scheduled or due that day", () => {
    const { container } = render(() => (
      <JournalAgenda
        day={20260920}
        today={TODAY}
        tasks={resource([task({ scheduledDay: TODAY })])}
        onNavigate={() => {}}
      />
    ));
    expect(container.innerHTML).toBe("");
  });

  it("lists tasks grouped by page, with overdue dates called out", () => {
    const tasks = [
      task({ id: "a", content: "write report", scheduledDay: TODAY, scheduledTime: "09:30" }),
      task({
        id: "b",
        pageId: "p2",
        pageName: "Home",
        content: "pay rent",
        marker: "DOING",
        priority: "A",
        deadlineDay: 20260910,
      }),
    ];
    const { container } = render(() => (
      <JournalAgenda day={TODAY} today={TODAY} tasks={resource(tasks)} onNavigate={() => {}} />
    ));
    expect(container.querySelector(".journal-agenda-title")?.textContent).toBe(
      "Scheduled and deadline",
    );
    const groups = [...container.querySelectorAll(".journal-agenda-group")];
    expect(groups.map((g) => g.querySelector(".journal-agenda-page")?.textContent)).toEqual([
      "Home",
      "Project",
    ]);

    const overdue = groups[0]?.querySelector(".journal-agenda-date");
    expect(overdue?.classList.contains("journal-agenda-date-overdue")).toBe(true);
    expect(overdue?.textContent).toBe("Deadline Sep 10th, 2026");
    expect(groups[0]?.querySelector(".vr-marker-DOING")).toBeTruthy();
    expect(groups[0]?.querySelector(".vr-priority-A")?.textContent).toBe("A");

    const today = groups[1]?.querySelector(".journal-agenda-date");
    expect(today?.classList.contains("journal-agenda-date-overdue")).toBe(false);
    expect(today?.textContent).toBe("Scheduled 09:30");
    expect(groups[1]?.querySelector(".journal-agenda-content")?.textContent).toBe("write report");
  });

  it("a row click navigates to the task, a heading click to its page", () => {
    const seen: NavigateTarget[] = [];
    const { container } = render(() => (
      <JournalAgenda
        day={TODAY}
        today={TODAY}
        tasks={resource([task({ id: "blk1", pageName: "Garden/Zahrada", scheduledDay: TODAY })])}
        onNavigate={(t) => seen.push(t)}
      />
    ));
    fireEvent.click(container.querySelector(".journal-agenda-row") as Element);
    fireEvent.click(container.querySelector(".journal-agenda-page") as Element);
    expect(seen).toEqual([
      { kind: "block", id: "blk1" },
      { kind: "page", name: "Garden/Zahrada" },
    ]);
    expect(container.querySelector(".journal-agenda-page")?.getAttribute("href")).toBe(
      "/page/Garden/Zahrada",
    );
  });

  it("a link inside a task goes where the link points, not to the task", () => {
    const seen: NavigateTarget[] = [];
    const { container } = render(() => (
      <JournalAgenda
        day={TODAY}
        today={TODAY}
        tasks={resource([task({ content: "call [[Jana]]", scheduledDay: TODAY })])}
        onNavigate={(t) => seen.push(t)}
      />
    ));
    fireEvent.click(container.querySelector(".journal-agenda-content a") as Element);
    expect(seen).toEqual([{ kind: "page", name: "Jana" }]);
  });

  it("hides itself when the read failed, instead of throwing into the stream", () => {
    const { container } = render(() => (
      <JournalAgenda
        day={TODAY}
        today={TODAY}
        tasks={resource([], new Error("no such table"))}
        onNavigate={() => {}}
      />
    ));
    expect(container.innerHTML).toBe("");
  });
});
