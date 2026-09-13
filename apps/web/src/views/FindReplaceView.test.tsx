// @vitest-environment jsdom
/**
 * Find & Replace promises that what the preview shows is exactly what Replace all writes. The
 * preview request is debounced (250 ms) and asynchronous, so Replace all must neither send the
 * debounced input while the fields have moved on, nor act while the preview on screen is for an
 * older input (B-134). `graph.replace` is mocked; the real call is covered by `replace.spec.ts`.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReplaceInput, ReplaceResult } from "../data/refactor-api.js";

const fake = vi.hoisted(() => ({
  calls: [] as ReplaceInput[],
  hold: false,
  held: [] as Array<() => void>,
}));

function resultFor(i: ReplaceInput): ReplaceResult {
  return {
    matches: [
      { blockId: "b1", page: "P", before: "foo here", after: `${i.replacement} here`, count: 1 },
    ],
    blocksMatched: 1,
    occurrences: 1,
    truncated: false,
    batchId: i.dryRun ? undefined : "batch-1",
  };
}

vi.mock("../data/refactor-api.js", () => ({
  refactorApi: {
    replace: (i: ReplaceInput) => {
      fake.calls.push(i);
      if (!fake.hold || !i.dryRun) return Promise.resolve(resultFor(i));
      return new Promise<ReplaceResult>((resolve) => fake.held.push(() => resolve(resultFor(i))));
    },
    undoBatch: async () => ({}),
  },
}));
vi.mock("../db/client.js", () => ({ forceSync: async () => {} }));

import { FindReplaceView } from "./FindReplaceView.js";

afterEach(() => {
  cleanup();
  fake.calls.length = 0;
  fake.hold = false;
  fake.held.length = 0;
});

const writes = () => fake.calls.filter((c) => !c.dryRun);
const previews = () => fake.calls.filter((c) => c.dryRun);
const replaceAll = () => screen.getByRole("button", { name: "Replace all" }) as HTMLButtonElement;

async function previewed(query: string, replacement: string): Promise<void> {
  fireEvent.input(document.querySelector(".replace-query") as HTMLInputElement, {
    target: { value: query },
  });
  fireEvent.input(document.querySelector(".replace-replacement") as HTMLInputElement, {
    target: { value: replacement },
  });
  await waitFor(() => expect(replaceAll().disabled).toBe(false));
}

describe("Replace all writes what the fields say (B-134)", () => {
  it("does not write the debounced replacement when the field changed a moment ago", async () => {
    render(() => <FindReplaceView />);
    await previewed("foo", "bar");

    // Change the replacement and press Replace all before the 250 ms debounce has fired.
    fireEvent.input(document.querySelector(".replace-replacement") as HTMLInputElement, {
      target: { value: "baz" },
    });
    fireEvent.click(replaceAll());
    await new Promise((r) => setTimeout(r, 0));
    expect(writes().map((w) => w.replacement)).not.toContain("bar");

    // Once the preview has caught up, Replace all writes exactly that.
    await waitFor(() => expect(previews().at(-1)?.replacement).toBe("baz"));
    await waitFor(() => expect(replaceAll().disabled).toBe(false));
    fireEvent.click(replaceAll());
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ query: "foo", replacement: "baz", dryRun: false });
  });

  it("does not write a flag the preview on screen was not computed with", async () => {
    render(() => <FindReplaceView />);
    await previewed("foo", "bar");

    fireEvent.change(document.querySelector(".replace-case") as HTMLInputElement, {
      target: { checked: true },
    });
    fireEvent.click(replaceAll());
    await new Promise((r) => setTimeout(r, 0));
    expect(writes().filter((w) => !w.caseSensitive)).toHaveLength(0);
  });

  it("is disabled while the preview for the current fields is still loading", async () => {
    render(() => <FindReplaceView />);
    await previewed("foo", "bar");

    fake.hold = true;
    fireEvent.input(document.querySelector(".replace-replacement") as HTMLInputElement, {
      target: { value: "baz" },
    });
    // The debounce fires and the new preview request goes out, but has not answered: the old
    // preview ("bar here") is still what the page shows.
    await waitFor(() => expect(fake.held).toHaveLength(1));
    expect(replaceAll().disabled).toBe(true);
    fireEvent.click(replaceAll());
    await new Promise((r) => setTimeout(r, 0));
    expect(writes()).toHaveLength(0);

    fake.held[0]?.();
    await waitFor(() => expect(replaceAll().disabled).toBe(false));
  });
});
