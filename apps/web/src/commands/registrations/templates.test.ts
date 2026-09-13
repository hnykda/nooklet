import { describe, expect, it, vi } from "vitest";
import type { TemplateSummary } from "../../data/templates.js";
import { createFakeEditorHost } from "../hosts/editor-host.js";
import { createFakeStore } from "../hosts/store.js";
import type { CommandContext } from "../types.js";
import { DEFAULT_WHEN_CONTEXT } from "../types.js";
import { createTemplateCommands } from "./templates.js";

const daily: TemplateSummary = { id: "tpl-daily", name: "daily", journal: true };
const meeting: TemplateSummary = { id: "tpl-meeting", name: "Meeting", journal: false };

function setup(opts: {
  content?: string;
  pick?: (templates: TemplateSummary[]) => Promise<TemplateSummary | undefined>;
}) {
  const editor = createFakeEditorHost({ blockId: "b1", content: opts.content ?? "" });
  const data = {
    listTemplates: vi.fn(async () => [daily, meeting]),
    findTemplateByName: vi.fn(async (name: string) =>
      [daily, meeting].find((t) => t.name.toLowerCase() === name.toLowerCase()),
    ),
    insertTemplateAfter: vi.fn(async (_templateId: string, _blockId: string) => "new-root"),
    applyTemplateIntoBlock: vi.fn(async (_templateId: string, _blockId: string) => ({
      content: "Daily plan for [[Sep 12th, 2026]]",
    })),
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
  return { editor, data, pick, focusBlock, command, run };
}

describe("block.insertTemplate", () => {
  it("is an editor-scoped Insert command", () => {
    const { command } = setup({});
    expect(command.id).toBe("block.insertTemplate");
    expect(command.category).toBe("Insert");
    expect(command.when).toBe("editorFocused");
  });

  it("into an empty bullet: the template's first block becomes this block, written through the editor", async () => {
    const { editor, data, run, focusBlock } = setup({ content: "" });
    await run();
    expect(data.listTemplates).toHaveBeenCalledTimes(1);
    expect(data.applyTemplateIntoBlock).toHaveBeenCalledWith("tpl-daily", "b1");
    expect(data.insertTemplateAfter).not.toHaveBeenCalled();
    // The text went through `replaceRange` (the editor's buffer), caret at the end.
    expect(editor.state?.content).toBe("Daily plan for [[Sep 12th, 2026]]");
    expect(editor.state?.start).toBe("Daily plan for [[Sep 12th, 2026]]".length);
    expect(focusBlock).not.toHaveBeenCalled();
  });

  it("after a bullet with text: inserted as siblings, caret moves to the first new block", async () => {
    const { editor, data, run, focusBlock } = setup({ content: "already here" });
    await run();
    expect(data.insertTemplateAfter).toHaveBeenCalledWith("tpl-daily", "b1");
    expect(data.applyTemplateIntoBlock).not.toHaveBeenCalled();
    expect(editor.state?.content).toBe("already here");
    expect(focusBlock).toHaveBeenCalledWith("new-root");
  });

  it("an empty block with properties still takes the template into itself (B-154)", async () => {
    // The editor host's content is the editing text: an empty numbered item reads `\nlist:: number`.
    const { editor, data, run } = setup({ content: "\nlist:: number" });
    await run();
    expect(data.applyTemplateIntoBlock).toHaveBeenCalledWith("tpl-daily", "b1");
    expect(data.insertTemplateAfter).not.toHaveBeenCalled();
    // The template's text replaces the (empty) text; the block stays numbered, caret after the text.
    const text = "Daily plan for [[Sep 12th, 2026]]";
    expect(editor.state?.content).toBe(`${text}\nlist:: number`);
    expect(editor.state?.start).toBe(text.length);
  });

  it("a whitespace-only bullet counts as empty", async () => {
    const { data, run } = setup({ content: "   " });
    await run();
    expect(data.applyTemplateIntoBlock).toHaveBeenCalled();
  });

  it("takes the template by name from args and skips the picker", async () => {
    const pick = vi.fn(async () => undefined);
    const { data, run } = setup({ content: "x", pick });
    await run("MEETING");
    expect(pick).not.toHaveBeenCalled();
    expect(data.insertTemplateAfter).toHaveBeenCalledWith("tpl-meeting", "b1");
    await run({ name: "daily" });
    expect(data.insertTemplateAfter).toHaveBeenLastCalledWith("tpl-daily", "b1");
  });

  it("does nothing for an unknown name or a cancelled picker", async () => {
    const pick = vi.fn(async () => undefined);
    const { data, run } = setup({ content: "x", pick });
    await run("nope");
    await run();
    expect(pick).toHaveBeenCalledTimes(1);
    expect(data.insertTemplateAfter).not.toHaveBeenCalled();
    expect(data.applyTemplateIntoBlock).not.toHaveBeenCalled();
  });

  it("does nothing without a focused editor", async () => {
    const { editor, data, run } = setup({});
    editor.state = null;
    await run();
    expect(data.listTemplates).not.toHaveBeenCalled();
  });

  it("does not write into a block that stopped being the focused one meanwhile", async () => {
    const { editor, data, run } = setup({ content: "" });
    data.applyTemplateIntoBlock.mockImplementationOnce(async () => {
      // Focus moved to another block while the ops were being applied.
      editor.state = { blockId: "b2", content: "", start: 0, end: 0 };
      return { content: "late" };
    });
    await run();
    expect(editor.state?.content).toBe("");
  });
});
