// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualJournalDay } from "./VirtualJournalDay.js";

const applyOp = vi.fn(async (..._args: unknown[]) => ({
  results: [],
  applied: 1,
  noop: 0,
  rejected: 0,
}));

vi.mock("../data/store.js", () => ({
  applyOp: (...args: unknown[]) => applyOp(...args),
}));

vi.mock("../editor/BlockTree.js", () => ({
  BlockTree: (props: { pageId: string }) => (
    <div data-testid="block-tree">materialized:{props.pageId}</div>
  ),
}));

afterEach(() => {
  cleanup();
  applyOp.mockClear();
});

describe("VirtualJournalDay", () => {
  it("renders an empty placeholder and creates nothing on mount (virtual-today rule)", () => {
    render(() => <VirtualJournalDay day={20260910} />);
    expect(screen.getByPlaceholderText("Start typing…")).toBeTruthy();
    expect(applyOp).not.toHaveBeenCalled();
  });

  it("does nothing on blur while still empty", () => {
    render(() => <VirtualJournalDay day={20260910} />);
    const textarea = screen.getByPlaceholderText("Start typing…");
    fireEvent.blur(textarea);
    expect(applyOp).not.toHaveBeenCalled();
  });

  it("materializes the page and its first block only once something is committed", async () => {
    render(() => <VirtualJournalDay day={20260910} />);
    const textarea = screen.getByPlaceholderText("Start typing…") as HTMLTextAreaElement;

    fireEvent.input(textarea, { target: { value: "Reviewed launch checklist" } });
    expect(applyOp).not.toHaveBeenCalled(); // typing alone must not write anything yet

    fireEvent.blur(textarea);
    await Promise.resolve();
    await Promise.resolve();

    expect(applyOp).toHaveBeenCalledTimes(2);
    const [pageOp, blockOp] = applyOp.mock.calls;
    expect(pageOp?.[1]).toMatchObject({ kind: "page.create", journalDay: 20260910 });
    expect(blockOp?.[1]).toMatchObject({
      kind: "block.create",
      content: "Reviewed launch checklist",
    });

    // Swaps to the real BlockTree immediately (optimistic, using the id it just minted).
    expect(await screen.findByTestId("block-tree")).toBeTruthy();
  });
});
