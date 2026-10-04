// @vitest-environment jsdom
/**
 * `/capture?text=…&url=…&title=…` pre-fills the capture screen (ADR 033): the route is where every
 * `nooklet://capture` link and the PWA share target end up, so this is the pre-fill contract.
 */
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../data/bootstrap.js", () => ({ deviceHasNoGraph: () => false }));

import { CaptureRoute } from "./CaptureRoute.js";

afterEach(() => cleanup());

function renderAt(path: string): HTMLTextAreaElement {
  const history = createMemoryHistory();
  history.set({ value: path });
  render(() => (
    <MemoryRouter history={history}>
      <Route path="/capture" component={CaptureRoute} />
    </MemoryRouter>
  ));
  return screen.getByPlaceholderText("Capture a thought…") as HTMLTextAreaElement;
}

describe("CaptureRoute pre-fill", () => {
  it("shared text", () => {
    expect(renderAt("/capture?text=walk%20the%20dog").value).toBe("walk the dog");
  });

  it("a link with a title becomes [title](url)", () => {
    expect(renderAt("/capture?url=https%3A%2F%2Fexample.com%2Fa&title=An%20article").value).toBe(
      "[An article](https://example.com/a)",
    );
  });

  it("a bare link is the URL", () => {
    expect(renderAt("/capture?url=https%3A%2F%2Fexample.com%2Fa").value).toBe(
      "https://example.com/a",
    );
  });

  it("no params: an empty screen", () => {
    expect(renderAt("/capture").value).toBe("");
  });
});
