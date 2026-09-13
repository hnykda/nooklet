// @vitest-environment jsdom
/**
 * HistoryView's failure paths over the real `data/history.ts`: only the HTTP call and the worker's
 * listener registration are replaced. A failed first load used to stay on "Loading…" because
 * reading an errored resource re-throws (B-131).
 */
import { Route, Router } from "@solidjs/router";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  callOp: undefined as ((name: string, body: unknown) => Promise<unknown>) | undefined,
}));

vi.mock("../db/client.js", () => ({
  onChange: () => () => {},
  onSyncStatus: () => () => {},
}));
vi.mock("../data/api-client.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  callOp: (name: string, body: unknown) => fake.callOp?.(name, body),
}));

import { HistoryView } from "./HistoryView.js";

afterEach(() => {
  cleanup();
  fake.callOp = undefined;
});

function renderHistory() {
  return render(() => (
    <Router>
      <Route path="*" component={() => <HistoryView name={() => "Projects"} />} />
    </Router>
  ));
}

function historyPage(seqs: number[], hasMore: boolean) {
  return {
    page: "Projects",
    page_id: "p1",
    has_more: hasMore,
    cursor: hasMore ? String(seqs[seqs.length - 1]) : undefined,
    batches: seqs.map((seq) => ({
      batch_id: `b${seq}`,
      seq,
      at: "2026-09-13T08:00:00.000Z",
      origin: "api",
      actor: "agent",
      summary: `change ${seq}`,
      entries: [],
    })),
  };
}

describe("HistoryView when page.history fails (B-131)", () => {
  it("shows the error with Retry instead of Loading…, and Retry recovers", async () => {
    fake.callOp = async () => {
      throw new Error("could not reach server");
    };
    renderHistory();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not load the history: could not reach server");
    expect(screen.queryByText("Loading…")).toBeNull();

    fake.callOp = async () => historyPage([3, 2, 1], false);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("change 3")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
