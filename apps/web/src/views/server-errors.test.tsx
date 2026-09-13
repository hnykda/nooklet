// @vitest-environment jsdom
/**
 * A view that shows a server failure shows all of it (B-330): the address a network failure tried,
 * and the server's `hint`. Each of these views once had its own formatter — Search and Find &
 * Replace an `errorText` that turned every network failure into "Could not reach the server." and
 * printed a rejection's message without its hint, History `err.message` — so `graph.replace`'s "fix
 * the pattern, or set regex: false…" never reached the person who typed the pattern.
 *
 * Only the HTTP edge is replaced: Find & Replace's `refactorApi`, Search's resource, History's
 * `callOp`. `../source-guards.test.ts` keeps new views from growing a formatter of their own.
 */
import { Route, Router } from "@solidjs/router";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createResource } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchInput, SearchResult } from "../data/api-client.js";

const fake = vi.hoisted(() => ({
  replace: undefined as ((input: unknown) => Promise<unknown>) | undefined,
  search: undefined as ((input: SearchInput) => Promise<SearchResult>) | undefined,
  callOp: undefined as ((name: string, body: unknown) => Promise<unknown>) | undefined,
}));

vi.mock("../db/client.js", () => ({
  forceSync: async () => {},
  onChange: () => () => {},
  onSyncStatus: () => () => {},
}));
vi.mock("../data/api-client.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  callOp: (name: string, body: unknown) => fake.callOp?.(name, body),
}));
vi.mock("../data/refactor-api.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../data/refactor-api.js")>();
  return {
    ...real,
    refactorApi: { ...real.refactorApi, replace: (input: unknown) => fake.replace?.(input) },
  };
});
vi.mock("../data/store.js", () => ({
  useSearchResults: (input: () => SearchInput | undefined) => {
    const [resource, { refetch }] = createResource(input, (i: SearchInput) => fake.search?.(i));
    return [resource, { refetch: () => void refetch() }];
  },
  useAllPages: () => Object.assign(() => [], { loading: false, error: undefined }),
}));

import { ApiError } from "../data/api-client.js";
import { FindReplaceView } from "./FindReplaceView.js";
import { HistoryView } from "./HistoryView.js";
import { SearchView } from "./SearchView.js";

afterEach(() => {
  cleanup();
  fake.replace = fake.search = fake.callOp = undefined;
  vi.restoreAllMocks();
});

const NETWORK = new ApiError("network", "could not reach http://127.0.0.1:6405 (Failed to fetch)");

describe("server failures keep their address and hint (B-330)", () => {
  it("Find & Replace shows the server's hint for a rejected preview", async () => {
    fake.replace = async () => {
      throw new ApiError(
        "invalid",
        "query is not a valid regular expression: Unterminated group",
        "fix the pattern, or set regex: false to search for the text literally",
      );
    };
    render(() => <FindReplaceView />);
    fireEvent.input(document.querySelector(".replace-query") as HTMLInputElement, {
      target: { value: "(" },
    });
    const alert = await screen.findByRole("alert", undefined, { timeout: 3000 });
    expect(alert.textContent).toContain("not a valid regular expression");
    expect(alert.textContent).toContain("set regex: false");
  });

  it("Search says which address it could not reach", async () => {
    fake.search = async () => {
      throw NETWORK;
    };
    render(() => (
      <Router>
        <Route path="*" component={SearchView} />
      </Router>
    ));
    fireEvent.input(screen.getByPlaceholderText("Search…"), { target: { value: "pangolin" } });
    const alert = await screen.findByRole("alert", undefined, { timeout: 3000 });
    expect(alert.textContent).toContain("Search failed.");
    expect(alert.textContent).toContain("could not reach http://127.0.0.1:6405");
  });

  it("History's Undo shows the server's hint when the undo is refused", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fake.callOp = async (name) => {
      if (name === "batch.undo") {
        throw new ApiError("conflict", "batch b1 was already undone", "undo its undo instead");
      }
      return {
        page: "Projects",
        page_id: "p1",
        has_more: false,
        batches: [
          {
            batch_id: "b1",
            seq: 1,
            at: "2026-09-13T08:00:00.000Z",
            origin: "api",
            actor: "agent",
            summary: "change 1",
            entries: [],
          },
        ],
      };
    };
    render(() => (
      <Router>
        <Route path="*" component={() => <HistoryView name={() => "Projects"} />} />
      </Router>
    ));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("batch b1 was already undone undo its undo instead");
  });
});
