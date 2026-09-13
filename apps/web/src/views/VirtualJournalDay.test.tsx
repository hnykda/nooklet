// @vitest-environment jsdom
import type { Op, TemplateNode } from "@nooklet/core";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blockFocusRequest, clearBlockFocusRequest } from "../editor/focus-request.js";
import { VirtualJournalDay } from "./VirtualJournalDay.js";

const applyOps = vi.fn(async (_ops: Op[]) => ({
  results: [],
  applied: 1,
  noop: 0,
  rejected: 0,
}));

// A deterministic clock with the same contract as `data/store.ts#getOpClock`: a finite pool,
// exhausted with a throw — so a batch that mints more ops than it asked for fails loudly here.
const getOpClock = vi.fn(async (poolSize = 16) => {
  let i = 0;
  return {
    next: () => {
      if (i >= poolSize) throw new Error(`clock pool of ${poolSize} exhausted`);
      return `${String(1_000 + i++).padStart(13, "0")}-0000-test`;
    },
    device: "test",
  };
});

vi.mock("../data/store.js", () => ({
  applyOps: (ops: Op[]) => applyOps(ops),
  getOpClock: (n?: number) => getOpClock(n),
}));

const appendToJournalDay = vi.fn(
  async (_day: number, _content: string): Promise<string | null> => null,
);

vi.mock("../data/journal-day.js", () => ({
  appendToJournalDay: (day: number, content: string) => appendToJournalDay(day, content),
}));

const loadJournalTemplate = vi.fn(
  async (): Promise<{ node: TemplateNode; count: number } | null> => null,
);

vi.mock("../data/templates.js", async () => {
  const actual =
    await vi.importActual<typeof import("../data/templates.js")>("../data/templates.js");
  return {
    ...actual,
    loadJournalTemplate: () => loadJournalTemplate(),
  };
});

vi.mock("../editor/BlockTree.js", () => ({
  BlockTree: (props: { pageId: string }) => (
    <div data-testid="block-tree">materialized:{props.pageId}</div>
  ),
}));

afterEach(() => {
  cleanup();
  applyOps.mockClear();
  getOpClock.mockClear();
  appendToJournalDay.mockClear();
  loadJournalTemplate.mockReset();
  loadJournalTemplate.mockResolvedValue(null);
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

type Create = Extract<Op["payload"], { kind: "block.create" }>;
function creates(ops: Op[]): Array<Op & { payload: Create }> {
  return ops.filter((op): op is Op & { payload: Create } => op.payload.kind === "block.create");
}

describe("VirtualJournalDay", () => {
  it("renders an empty placeholder and creates nothing on mount (virtual-today rule)", () => {
    render(() => <VirtualJournalDay day={20260910} />);
    expect(screen.getByPlaceholderText("Start typing…")).toBeTruthy();
    expect(applyOps).not.toHaveBeenCalled();
  });

  it("does nothing on blur while still empty", () => {
    render(() => <VirtualJournalDay day={20260910} />);
    const textarea = screen.getByPlaceholderText("Start typing…");
    fireEvent.blur(textarea);
    expect(applyOps).not.toHaveBeenCalled();
  });

  it("materializes the page and its first block only once something is committed", async () => {
    render(() => <VirtualJournalDay day={20260910} />);
    const textarea = screen.getByPlaceholderText("Start typing…") as HTMLTextAreaElement;

    fireEvent.input(textarea, { target: { value: "Reviewed launch checklist" } });
    expect(applyOps).not.toHaveBeenCalled(); // typing alone must not write anything yet

    fireEvent.blur(textarea);
    await settle();

    // One batch: the page and the block together.
    expect(applyOps).toHaveBeenCalledTimes(1);
    const ops = applyOps.mock.calls[0]?.[0] ?? [];
    expect(ops.map((op) => op.payload.kind)).toEqual(["page.create", "block.create"]);
    expect(ops[0]?.payload).toMatchObject({ kind: "page.create", journalDay: 20260910 });
    expect(ops[1]?.payload).toMatchObject({
      kind: "block.create",
      content: "Reviewed launch checklist",
    });
    // Every op came from the one clock (`getOpClock`), never a second HLC source.
    expect(new Set(ops.map((op) => op.device))).toEqual(new Set(["test"]));

    // Swaps to the real BlockTree immediately (optimistic, using the id it just minted).
    expect(await screen.findByTestId("block-tree")).toBeTruthy();
  });

  it("Enter also creates the next empty sibling, after the typed block", async () => {
    render(() => <VirtualJournalDay day={20260910} />);
    const textarea = screen.getByPlaceholderText("Start typing…") as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "first" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await settle();

    const blocks = creates(applyOps.mock.calls[0]?.[0] ?? []);
    expect(blocks.map((b) => b.payload.content)).toEqual(["first", ""]);
    const [typedOrder = "", nextOrder = ""] = blocks.map((b) => b.payload.place.order);
    expect(typedOrder < nextOrder).toBe(true);
  });

  it("starts a new day with the journal template, the typed text after it (ADR 019)", async () => {
    loadJournalTemplate.mockResolvedValue({
      node: {
        content: "Plan for <% today %>",
        marker: null,
        priority: null,
        collapsed: false,
        properties: { template: "daily", "journal-template": "true" },
        children: [
          {
            content: "Gratitude",
            marker: null,
            priority: null,
            collapsed: false,
            properties: {},
            children: [],
          },
        ],
      },
      count: 2,
    });

    render(() => <VirtualJournalDay day={20260910} />);
    const textarea = screen.getByPlaceholderText("Start typing…") as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "call mom" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await settle();

    expect(applyOps).toHaveBeenCalledTimes(1);
    const ops = applyOps.mock.calls[0]?.[0] ?? [];
    expect(ops[0]?.payload.kind).toBe("page.create");
    const blocks = creates(ops);
    expect(blocks.map((b) => b.payload.content)).toEqual([
      "Plan for [[Sep 10th, 2026]]",
      "Gratitude",
      "call mom",
      "",
    ]);
    const pageId = ops[0]?.entity;
    // The template root, the typed block and the empty sibling are top-level, in that order; the
    // template's child hangs off the template root's NEW id; nothing carries `template::`.
    const [root, child, typed, next] = blocks;
    expect(root?.payload.place).toMatchObject({ pageId, parentId: null });
    expect(child?.payload.place.parentId).toBe(root?.entity);
    expect(typed?.payload.place.parentId).toBeNull();
    expect(next?.payload.place.parentId).toBeNull();
    const [rootOrder = "", typedOrder = "", nextOrder = ""] = [root, typed, next].map(
      (b) => b?.payload.place.order ?? "",
    );
    expect(rootOrder < typedOrder && typedOrder < nextOrder).toBe(true);
    expect(root?.payload.properties).toBeUndefined();
    // The pool was sized for the template (2) plus page + typed + next (3).
    expect(getOpClock).toHaveBeenCalledWith(5);
  });

  async function materializeWithEnter() {
    const rendered = render(() => <VirtualJournalDay day={20260910} />);
    const textarea = screen.getByPlaceholderText("Start typing…") as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "first" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await settle();
    const nextId = blockFocusRequest();
    expect(nextId).toBeDefined();
    await screen.findByTestId("block-tree");
    return { ...rendered, nextId: nextId as string };
  }

  it("hands its focus request back if it is torn down after the request was claimed (B-107)", async () => {
    const { unmount, nextId } = await materializeWithEnter();
    // Our optimistic tree claims the request (its editor has not necessarily taken focus yet) …
    clearBlockFocusRequest();
    // … then the stream swaps in its own tree for the page and unmounts us.
    unmount();
    expect(blockFocusRequest()).toBe(nextId);
  });

  it("leaves a still-pending request alone on teardown", async () => {
    const { unmount, nextId } = await materializeWithEnter();
    unmount();
    expect(blockFocusRequest()).toBe(nextId);
    clearBlockFocusRequest();
  });

  it("asks for nothing on teardown after a blur commit, which never asked for the caret", async () => {
    const { unmount } = render(() => <VirtualJournalDay day={20260910} />);
    const textarea = screen.getByPlaceholderText("Start typing…") as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "first" } });
    fireEvent.blur(textarea);
    await settle();
    expect(blockFocusRequest()).toBeUndefined();
    unmount();
    expect(blockFocusRequest()).toBeUndefined();
    expect(appendToJournalDay).not.toHaveBeenCalled();
  });
});

describe("VirtualJournalDay torn down with text nobody committed (B-243)", () => {
  it("appends it to the day the replica now has, and puts the caret after it", async () => {
    appendToJournalDay.mockResolvedValueOnce("appended-block");
    const { unmount } = render(() => <VirtualJournalDay day={20260910} />);
    const textarea = screen.getByPlaceholderText("Start typing…") as HTMLTextAreaElement;
    textarea.focus();
    fireEvent.input(textarea, { target: { value: "ztracený text" } });
    // The first sync says the day exists: the stream swaps this draft out, no blur, no Enter.
    unmount();
    await settle();

    expect(appendToJournalDay).toHaveBeenCalledWith(20260910, "ztracený text");
    // Nothing creates a second page for a day that already has one.
    expect(applyOps).not.toHaveBeenCalled();
    expect(blockFocusRequest()).toBe("appended-block");
    clearBlockFocusRequest();
  });

  it("does not take the caret anywhere if the draft did not have it", async () => {
    appendToJournalDay.mockResolvedValueOnce("appended-block");
    const { unmount } = render(() => <VirtualJournalDay day={20260910} />);
    const textarea = screen.getByPlaceholderText("Start typing…") as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "typed, then looked away" } });
    unmount();
    await settle();
    expect(appendToJournalDay).toHaveBeenCalledTimes(1);
    expect(blockFocusRequest()).toBeUndefined();
  });

  it("creates the day the normal way when the replica still has no page for it", async () => {
    appendToJournalDay.mockResolvedValueOnce(null);
    const { unmount } = render(() => <VirtualJournalDay day={20260910} />);
    const textarea = screen.getByPlaceholderText("Start typing…") as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "still mine" } });
    unmount();
    await settle();
    expect(applyOps).toHaveBeenCalledTimes(1);
    const ops = applyOps.mock.calls[0]?.[0] ?? [];
    expect(ops.map((op) => op.payload.kind)).toEqual(["page.create", "block.create"]);
    expect(ops[1]?.payload).toMatchObject({ content: "still mine" });
  });

  it("an empty draft leaves nothing behind", async () => {
    const { unmount } = render(() => <VirtualJournalDay day={20260910} />);
    unmount();
    await settle();
    expect(appendToJournalDay).not.toHaveBeenCalled();
    expect(applyOps).not.toHaveBeenCalled();
  });
});
