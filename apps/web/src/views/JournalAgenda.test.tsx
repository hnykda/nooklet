// @vitest-environment jsdom
/**
 * The "Scheduled and deadline" section as rendered: hidden when empty, grouped by page, overdue
 * dates called out, a row click goes to the task and a heading click to its page, and a failed
 * read hides the section instead of throwing into the journal stream. Which tasks qualify is
 * `agendaDay.test.ts`; the whole path against a real server is
 * `e2e/tests/journal-agenda.spec.ts`.
 */

import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
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
    // B-321: an agenda entry must not look like the task's outliner row to a
    // `[data-block-id]` lookup — on the journal stream Today's agenda sits above older days'
    // rows, so the shelf's reveal and the agent flash landed here instead.
    expect(container.querySelector("[data-block-id]")).toBeNull();
    expect(
      (container.querySelector(".journal-agenda-item") as HTMLElement).dataset.agendaBlockId,
    ).toBe("blk1");
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

  it("a web link inside a task opens the link, not the task (B-175)", () => {
    const seen: NavigateTarget[] = [];
    const { container } = render(() => (
      <JournalAgenda
        day={TODAY}
        today={TODAY}
        tasks={resource([task({ content: "read https://example.com/x", scheduledDay: TODAY })])}
        onNavigate={(t) => seen.push(t)}
      />
    ));
    const link = container.querySelector(".journal-agenda-content a.vr-autolink") as Element;
    expect(link.getAttribute("href")).toBe("https://example.com/x");
    // `dispatchEvent` answers false when a handler called preventDefault — the browser would then
    // not follow the link.
    expect(fireEvent.click(link)).toBe(true);
    expect(fireEvent.keyDown(link, { key: "Enter" })).toBe(true);
    expect(seen).toEqual([]);
  });

  it("keeps every row across a refetch, updating a changed one in place (B-176)", () => {
    // Fresh objects on every call — what each refetch of the real resource hands back.
    const snapshot = (secondContent: string, withThird = false): AgendaTask[] => [
      task({ id: "a", content: "first", scheduledDay: TODAY }),
      task({ id: "b", order: "b", content: secondContent, scheduledDay: TODAY }),
      task({ id: "c", pageId: "p2", pageName: "Home", content: "third", deadlineDay: 20260901 }),
      ...(withThird
        ? [task({ id: "d", pageId: "p2", pageName: "Home", content: "new", deadlineDay: TODAY })]
        : []),
    ];
    const [rows, setRows] = createSignal(snapshot("second"));
    const tasks = Object.assign(() => rows(), { error: undefined });
    const { container } = render(() => (
      <JournalAgenda day={TODAY} today={TODAY} tasks={tasks} onNavigate={() => {}} />
    ));
    const rowEls = () => [...container.querySelectorAll<HTMLElement>(".journal-agenda-row")];
    const before = rowEls();
    expect(before.map((r) => r.textContent)).toEqual([
      expect.stringContaining("third"),
      expect.stringContaining("first"),
      expect.stringContaining("second"),
    ]);
    before[2]?.focus();
    expect(document.activeElement).toBe(before[2]);

    const contentNodes = () =>
      rowEls().map((r) => [...(r.querySelector(".journal-agenda-content")?.childNodes ?? [])]);
    const contentBefore = contentNodes();
    setRows(snapshot("second"));
    expect(rowEls().every((el, i) => el === before[i])).toBe(true);
    // Nothing changed, so nothing inside a row was re-rendered either.
    expect(contentNodes()).toEqual(contentBefore);
    expect(
      contentNodes()
        .flat()
        .every((n, i) => n === contentBefore.flat()[i]),
    ).toBe(true);
    // A keyboard user on a row keeps their place when an unrelated write lands.
    expect(document.activeElement).toBe(before[2]);

    setRows(snapshot("second, edited", true));
    const after = rowEls();
    expect(after).toHaveLength(4);
    expect(after[0]).toBe(before[0]);
    expect(after.includes(before[1] as HTMLElement)).toBe(true);
    expect(after.includes(before[2] as HTMLElement)).toBe(true);
    expect(before[2]?.textContent).toContain("second, edited");
    expect(document.activeElement).toBe(before[2]);

    // A whole group and a row of the other one go away; what is left stays put.
    setRows(snapshot("second, edited").filter((t) => t.id === "b"));
    expect(rowEls()).toEqual([before[2]]);
    expect(container.querySelectorAll(".journal-agenda-group")).toHaveLength(1);
    setRows([]);
    expect(container.innerHTML).toBe("");
  });

  it("a dated block that is not a task gets a bullet, not a checkbox, on its own day only", () => {
    const note = task({ id: "n", marker: null, content: "dentist", scheduledDay: 20260910 });
    const onItsDay = render(() => (
      <JournalAgenda day={20260910} today={TODAY} tasks={resource([note])} onNavigate={() => {}} />
    ));
    const row = onItsDay.container.querySelector(".journal-agenda-row");
    expect(row?.querySelector(".journal-agenda-bullet")).toBeTruthy();
    expect(row?.querySelector(".vr-marker")).toBeNull();
    expect(row?.querySelector("[aria-label^='Task']")).toBeNull();
    expect(row?.querySelector(".journal-agenda-content")?.textContent).toBe("dentist");
    onItsDay.unmount();

    const onToday = render(() => (
      <JournalAgenda day={TODAY} today={TODAY} tasks={resource([note])} onNavigate={() => {}} />
    ));
    expect(onToday.container.innerHTML).toBe("");
  });

  it("holds overdue rows past ten behind 'Show all N overdue', and folds them back", () => {
    const tasks = [
      ...Array.from({ length: 12 }, (_, i) =>
        task({
          id: `late${i}`,
          order: `a${String(i).padStart(2, "0")}`,
          content: `late ${i}`,
          scheduledDay: 20260801 + i,
        }),
      ),
      task({ id: "today", order: "b", content: "due today", deadlineDay: TODAY }),
    ];
    const { container } = render(() => (
      <JournalAgenda day={TODAY} today={TODAY} tasks={resource(tasks)} onNavigate={() => {}} />
    ));
    const contents = () =>
      [...container.querySelectorAll(".journal-agenda-content")].map((c) => c.textContent);
    const toggle = () => container.querySelector<HTMLButtonElement>(".journal-agenda-more");

    expect(contents()).toEqual([...Array.from({ length: 10 }, (_, i) => `late ${i}`), "due today"]);
    expect(toggle()?.textContent).toBe("Show all 12 overdue");
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle() as HTMLButtonElement);
    expect(contents()).toEqual([...Array.from({ length: 12 }, (_, i) => `late ${i}`), "due today"]);
    expect(toggle()?.textContent).toBe("Show fewer overdue");
    expect(toggle()?.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(toggle() as HTMLButtonElement);
    expect(contents()).toHaveLength(11);
  });

  it("shows no toggle with ten overdue or fewer", () => {
    const tasks = Array.from({ length: 10 }, (_, i) =>
      task({ id: `l${i}`, order: `a${i}`, content: `late ${i}`, deadlineDay: 20260901 }),
    );
    const { container } = render(() => (
      <JournalAgenda day={TODAY} today={TODAY} tasks={resource(tasks)} onNavigate={() => {}} />
    ));
    expect(container.querySelectorAll(".journal-agenda-item")).toHaveLength(10);
    expect(container.querySelector(".journal-agenda-more")).toBeNull();
  });
});
