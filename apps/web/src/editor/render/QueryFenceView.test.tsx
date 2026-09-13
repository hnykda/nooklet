// @vitest-environment jsdom
/**
 * A ```query fence whose evaluation fails, over the REAL `useQueryResults` resource — only the
 * worker call underneath it rejects. `render-seams.test.tsx` mocks the resource away, which is why
 * it never saw that `results.latest` re-throws on error and the fence sat on "Running query…"
 * (B-131).
 */
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/client.js", () => ({
  queryAs: async () => {
    throw new Error("worker gone");
  },
}));
vi.mock("../../data/store.js", () => ({
  stampedFor: <T,>(value: T) => ({ value, version: 0 }),
}));

import QueryFenceView from "./QueryFenceView.js";

afterEach(() => cleanup());

describe("QueryFenceView when the evaluation rejects (B-131)", () => {
  it('says "Query failed" with the reason instead of "Running query…" forever', async () => {
    const { container } = render(() => <QueryFenceView code="task:TODO" ctx={{ source: "" }} />);
    await waitFor(() => {
      expect(container.querySelector(".vr-query-error")?.textContent).toBe(
        "Query failed: worker gone",
      );
    });
    expect(container.textContent).not.toContain("Running query…");
  });
});
