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

// `../data/journal-draft-store.ts` keys its copy by the open replica (B-619/B-611).
vi.mock("../db/client.js", () => ({ currentReplicaScope: () => "~" }));

// What the day's tree was drawn from before its first fetch (B-411).
let treeInitialOps: readonly Op[] | undefined;
vi.mock("../editor/BlockTree.js", () => ({
  BlockTree: (props: { pageId: string; initialOps?: readonly Op[] }) => {
    treeInitialOps = props.initialOps;
    return <div data-testid="block-tree">materialized:{props.pageId}</div>;
  },
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
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
    // One pool, sized from the template it was loaded with: its 2 blocks, the page, and room for
    // the typed rows (4, so a commit that waited on the worker rarely needs a second trip).
    expect(getOpClock.mock.calls).toEqual([[7]]);
  });

  it("once focus has prepared it, Enter writes the day and shows its tree in the same task (B-411)", async () => {
    const onStarted = vi.fn();
    render(() => <VirtualJournalDay day={20260910} onStarted={onStarted} />);
    const textarea = screen.getByPlaceholderText("Start typing…") as HTMLTextAreaElement;
    textarea.focus();
    fireEvent.focus(textarea);
    await settle(); // the template and the HLC pool, fetched on focus
    fireEvent.input(textarea, { target: { value: "first" } });

    fireEvent.keyDown(textarea, { key: "Enter" });
    // No await: a key typed next must already find the day's tree and the caret request.
    expect(applyOps).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("block-tree")).toBeTruthy();
    const ops = applyOps.mock.calls[0]?.[0] ?? [];
    expect(treeInitialOps).toEqual(ops);
    const blocks = creates(ops);
    expect(blocks.map((b) => b.payload.content)).toEqual(["first", ""]);
    expect(blockFocusRequest()).toBe(blocks[1]?.entity);
    expect(onStarted).toHaveBeenCalledWith(true);
    clearBlockFocusRequest();
  });

  it("keeps taking lines while the replica has not answered, and writes them all at once (B-411)", async () => {
    let answer: (v: null) => void = () => {};
    loadJournalTemplate.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    render(() => <VirtualJournalDay day={20260910} />);
    const textarea = screen.getByPlaceholderText("Start typing…") as HTMLTextAreaElement;
    textarea.focus();
    fireEvent.input(textarea, { target: { value: "first" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.input(textarea, { target: { value: "second" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.input(textarea, { target: { value: "thi" } });
    // Still the draft, with the closed lines shown above the one being typed.
    expect(applyOps).not.toHaveBeenCalled();
    expect(screen.queryByTestId("block-tree")).toBeNull();
    expect(screen.getByText("first")).toBeTruthy();
    expect(screen.getByText("second")).toBeTruthy();
    expect(textarea.value).toBe("thi");

    answer(null);
    await vi.waitFor(() => expect(applyOps).toHaveBeenCalledTimes(1));
    const blocks = creates(applyOps.mock.calls[0]?.[0] ?? []);
    expect(blocks.map((b) => b.payload.content)).toEqual(["first", "second", "thi"]);
    // The caret goes where the typing was: the end of the last line.
    expect(blockFocusRequest()).toBe(blocks[2]?.entity);
    expect(await screen.findByTestId("block-tree")).toBeTruthy();
    clearBlockFocusRequest();
  });

  it("leaves the caret request alone when torn down after starting the day", async () => {
    const { unmount } = render(() => <VirtualJournalDay day={20260910} />);
    const textarea = screen.getByPlaceholderText("Start typing…") as HTMLTextAreaElement;
    textarea.focus();
    fireEvent.input(textarea, { target: { value: "first" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await settle();
    const nextId = blockFocusRequest();
    expect(nextId).toBeDefined();
    unmount();
    expect(blockFocusRequest()).toBe(nextId);
    expect(appendToJournalDay).not.toHaveBeenCalled();
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

  // B-131: the placeholder was swapped for the real tree before anything was written, so a failure
  // on the way left an empty outline for a page that did not exist and the typed line was gone.
  it("keeps the typed line and says why when the journal template cannot be loaded (B-131)", async () => {
    loadJournalTemplate.mockRejectedValue(new Error("worker gone"));
    render(() => <VirtualJournalDay day={20260910} />);
    const textarea = screen.getByPlaceholderText("Start typing…") as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "Reviewed launch checklist" } });
    fireEvent.blur(textarea);
    await settle();

    expect(applyOps).not.toHaveBeenCalled();
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not start this day: worker gone",
    );
    expect(screen.queryByTestId("block-tree")).toBeNull();
    const back = screen.getByPlaceholderText("Start typing…") as HTMLTextAreaElement;
    expect(back.value).toBe("Reviewed launch checklist");
  });

  it("keeps the typed line, drops its caret request, and can try again when the write fails (B-131)", async () => {
    applyOps.mockRejectedValueOnce(new Error("disk full"));
    const onStarted = vi.fn();
    render(() => <VirtualJournalDay day={20260910} onStarted={onStarted} />);
    const textarea = screen.getByPlaceholderText("Start typing…") as HTMLTextAreaElement;
    textarea.focus();
    fireEvent.input(textarea, { target: { value: "first" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await settle();

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not start this day: disk full",
    );
    expect(screen.queryByTestId("block-tree")).toBeNull();
    // The section is told the draft is back, so it does not keep a tree for a page that is not there.
    expect(onStarted.mock.calls).toEqual([[true], [false]]);
    // No caret request left behind for a block that was never created.
    expect(blockFocusRequest()).toBeUndefined();
    const back = screen.getByPlaceholderText("Start typing…") as HTMLTextAreaElement;
    expect(back.value).toBe("first");

    // The next commit goes through, and the error line goes away.
    fireEvent.keyDown(back, { key: "Enter" });
    await settle();
    expect(applyOps).toHaveBeenCalledTimes(2);
    expect(await screen.findByTestId("block-tree")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    clearBlockFocusRequest();
  });
});

describe("VirtualJournalDay keeps typed lines until they are ops (B-619)", () => {
  const DAY = 20261003;
  const KEY = `nooklet.journal-draft.v1:~:${DAY}`;

  it("a line Enter closed while the worker is still busy survives the page going away", async () => {
    // The worker never answers `prepare` (its template + HLC pool): the busy-replica window.
    loadJournalTemplate.mockImplementation(() => new Promise(() => {}));
    const { unmount } = render(() => <VirtualJournalDay day={DAY} />);
    const textarea = screen.getByPlaceholderText("Start typing…");
    fireEvent.focus(textarea);
    fireEvent.input(textarea, { target: { value: "LOCAL NOTE" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await settle();
    expect(applyOps).not.toHaveBeenCalled();
    // Synchronously stored: this is what an unload leaves behind.
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual(["LOCAL NOTE", ""]);
    unmount();

    // The next page load: the draft comes back and is written, with an idle worker this time.
    loadJournalTemplate.mockReset();
    loadJournalTemplate.mockResolvedValue(null);
    render(() => <VirtualJournalDay day={DAY} />);
    await vi.waitFor(() => expect(applyOps).toHaveBeenCalledTimes(1));
    const written = creates(applyOps.mock.calls[0]?.[0] ?? []).map((op) => op.payload.content);
    expect(written).toEqual(["LOCAL NOTE", ""]);
    // Handed to `applyOps` (whose B-247 copy takes over), so the draft's own copy is gone.
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("text typed without Enter is kept too, and nothing is stored for an empty draft", () => {
    loadJournalTemplate.mockImplementation(() => new Promise(() => {}));
    render(() => <VirtualJournalDay day={DAY} />);
    const textarea = screen.getByPlaceholderText("Start typing…");
    expect(localStorage.getItem(KEY)).toBeNull();
    fireEvent.input(textarea, { target: { value: "half a thought" } });
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual(["half a thought"]);
    fireEvent.input(textarea, { target: { value: "" } });
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
