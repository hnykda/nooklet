// @vitest-environment jsdom
/**
 * TrashView's failure path over the real `data/history.ts`: only the HTTP call and the worker's
 * listener registration are replaced. Reading an errored Solid resource re-throws, so an unguarded
 * `items()` anywhere in the view used to leave it on "Loading…" with the error unhandled (B-131).
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

import { TrashView } from "./TrashView.js";

afterEach(() => {
  cleanup();
  fake.callOp = undefined;
});

function renderTrash() {
  return render(() => (
    <Router>
      <Route path="*" component={TrashView} />
    </Router>
  ));
}

describe("TrashView when trash.list fails (B-131)", () => {
  it("shows the error with Retry instead of Loading…, and Retry recovers", async () => {
    fake.callOp = async () => {
      throw new Error("could not reach server");
    };
    renderTrash();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not load the trash: could not reach server");
    expect(screen.queryByText("Loading…")).toBeNull();

    fake.callOp = async () => ({ items: [], has_more: false });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("The trash is empty.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
