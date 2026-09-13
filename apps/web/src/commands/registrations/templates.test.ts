import { makeOp, type Op } from "@nooklet/core";
import { describe, expect, it, vi } from "vitest";
import type { TemplateSummary } from "../../data/templates.js";
import { createFakeEditorHost } from "../hosts/editor-host.js";
import { createFakeStore } from "../hosts/store.js";
import type { CommandContext } from "../types.js";
import { DEFAULT_WHEN_CONTEXT } from "../types.js";
import { createTemplateCommands } from "./templates.js";

const daily: TemplateSummary = { id: "tpl-daily", name: "daily", journal: true };
const meeting: TemplateSummary = { id: "tpl-meeting", name: "Meeting", journal: false };

let n = 0;
const op = (entity: string, content: string): Op =>
  makeOp(
    `2026-09-13T00:00:00.000Z-${(n++).toString(16).padStart(4, "0")}-dddddddd`,
    "dddddddd",
    entity,
    {
      kind: "block.text",
      content,
    },
  );

function setup(opts: {
  content?: string;
  pick?: (templates: TemplateSummary[]) => Promise<TemplateSummary | undefined>;
}) {
  const editor = createFakeEditorHost({ blockId: "b1", content: opts.content ?? "" });
  const afterOps = [op("new-root", "Daily plan")];
  const intoOps = [op("child", "Gratitude"), op("b1", "Daily plan for [[Sep 12th, 2026]]")];
  const data = {
    listTemplates: vi.fn(async () => [daily, meeting]),
    findTemplateByName: vi.fn(async (name: string) =>
      [daily, meeting].find((t) => t.name.toLowerCase() === name.toLowerCase()),
    ),
    templateAfterOps: vi.fn(async (_templateId: string, _blockId: string) => ({
      ops: afterOps,
      firstId: "new-root",
    })),
    templateIntoBlockOps: vi.fn(async (_templateId: string, _blockId: string) => ({
      ops: intoOps,
    })),
    applyOps: vi.fn(async (_ops: Op[]) => undefined),
  };
  const pick = opts.pick ?? vi.fn(async (list: TemplateSummary[]) => list[0]);
  const focusBlock = vi.fn();
  const [command] = createTemplateCommands({ editor, data, pick, focusBlock });
  if (!command) throw new Error("no command registered");
  const ctx = (args?: unknown): CommandContext => ({
    ...DEFAULT_WHEN_CONTEXT,
    editorFocused: true,
    focusedBlockId: "b1",
    selectedBlockIds: [],
    surface: null,
    store: createFakeStore(),
    exec: async () => {},
    args,
  });
  // The picker path is fire-and-forget (see the command's `run`), so a test lets the pick settle
  // before looking at what it did.
  const run = async (args?: unknown): Promise<void> => {
    await command.run(ctx(args));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { editor, data, pick, focusBlock, command, run, afterOps, intoOps };
}

describe("block.insertTemplate", () => {
  it("is an editor-scoped Insert command", () => {
    const { command } = setup({});
    expect(command.id).toBe("block.insertTemplate");
    expect(command.category).toBe("Insert");
    expect(command.when).toBe("editorFocused");
  });

  it("into an empty bullet: one batch through the editor, caret at the end of that bullet (B-108)", async () => {
    const { editor, data, run, focusBlock, intoOps } = setup({ content: "" });
    await run();
    expect(data.listTemplates).toHaveBeenCalledTimes(1);
    expect(data.templateIntoBlockOps).toHaveBeenCalledWith("tpl-daily", "b1");
    expect(data.templateAfterOps).not.toHaveBeenCalled();
    // Committed by the editor — so it is one undo step — and never written around it.
    expect(editor.committed).toEqual([
      { ops: intoOps, anchorId: "b1", focus: { blockId: "b1", caret: "end" } },
    ]);
    expect(data.applyOps).not.toHaveBeenCalled();
    // Not through `replaceRange` any more: the text is an op in the batch, the editor syncs to it.
    expect(editor.state?.content).toBe("");
    expect(focusBlock).not.toHaveBeenCalled();
  });

  it("after a bullet with text: one batch through the editor, caret to the first new block (B-108)", async () => {
    const { editor, data, run, focusBlock, afterOps } = setup({ content: "already here" });
    await run();
    expect(data.templateAfterOps).toHaveBeenCalledWith("tpl-daily", "b1");
    expect(data.templateIntoBlockOps).not.toHaveBeenCalled();
    expect(editor.committed).toEqual([
      { ops: afterOps, anchorId: "b1", focus: { blockId: "new-root", caret: "end" } },
    ]);
    expect(data.applyOps).not.toHaveBeenCalled();
    expect(editor.state?.content).toBe("already here");
    expect(focusBlock).not.toHaveBeenCalled();
  });

  it("applies the ops itself when no editor takes the batch, and still moves the caret", async () => {
    const after = setup({ content: "already here" });
    after.editor.acceptCommits = false;
    await after.run();
    expect(after.data.applyOps).toHaveBeenCalledWith(after.afterOps);
    expect(after.focusBlock).toHaveBeenCalledWith("new-root");

    const into = setup({ content: "" });
    into.editor.acceptCommits = false;
    await into.run();
    expect(into.data.applyOps).toHaveBeenCalledWith(into.intoOps);
  });

  it("an empty block with properties still takes the template into itself (B-154)", async () => {
    // The editor host's content is the editing text: an empty numbered item reads `\nlist:: number`.
    const { data, run } = setup({ content: "\nlist:: number" });
    await run();
    expect(data.templateIntoBlockOps).toHaveBeenCalledWith("tpl-daily", "b1");
    expect(data.templateAfterOps).not.toHaveBeenCalled();
  });

  it("a whitespace-only bullet counts as empty", async () => {
    const { data, run } = setup({ content: "   " });
    await run();
    expect(data.templateIntoBlockOps).toHaveBeenCalled();
  });

  it("takes the template by name from args and skips the picker", async () => {
    const pick = vi.fn(async () => undefined);
    const { data, run } = setup({ content: "x", pick });
    await run("MEETING");
    expect(pick).not.toHaveBeenCalled();
    expect(data.templateAfterOps).toHaveBeenCalledWith("tpl-meeting", "b1");
    await run({ name: "daily" });
    expect(data.templateAfterOps).toHaveBeenLastCalledWith("tpl-daily", "b1");
  });

  it("does nothing for an unknown name or a cancelled picker", async () => {
    const pick = vi.fn(async () => undefined);
    const { editor, data, run } = setup({ content: "x", pick });
    await run("nope");
    await run();
    expect(pick).toHaveBeenCalledTimes(1);
    expect(data.templateAfterOps).not.toHaveBeenCalled();
    expect(data.templateIntoBlockOps).not.toHaveBeenCalled();
    expect(editor.committed).toEqual([]);
  });

  it("does nothing without a focused editor", async () => {
    const { editor, data, run } = setup({});
    editor.state = null;
    await run();
    expect(data.listTemplates).not.toHaveBeenCalled();
  });

  it("does not pull the caret back into the bullet when focus moved on meanwhile", async () => {
    const { editor, data, run, intoOps } = setup({ content: "" });
    data.templateIntoBlockOps.mockImplementationOnce(async () => {
      // Focus moved to another block while the template was being read.
      editor.state = { blockId: "b2", content: "", start: 0, end: 0 };
      return { ops: intoOps };
    });
    await run();
    // Still inserted into b1 (the ops name it), but no caret target: b2 keeps the caret, and its
    // buffer is untouched.
    expect(editor.committed).toEqual([{ ops: intoOps, anchorId: "b1" }]);
    expect(editor.state?.content).toBe("");
  });
});
