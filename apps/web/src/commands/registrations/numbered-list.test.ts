import { describe, expect, it } from "vitest";
import { createFakeEditorHost } from "../hosts/editor-host.js";
import { createNumberedListCommands, toggleNumberedList } from "./numbered-list.js";

function apply(content: string, caret: number): { text: string; caret: number } {
  const r = toggleNumberedList(content, caret);
  return {
    text: content.slice(0, r.from) + r.text + content.slice(r.to),
    caret: r.from + (r.caretOffset as number),
  };
}

describe("toggleNumberedList (B-100)", () => {
  it("adds list:: number under line 1, caret staying on its character", () => {
    expect(apply("one", 3)).toEqual({ text: "one\nlist:: number", caret: 3 });
    expect(apply("title\nbody", 8)).toEqual({ text: "title\nlist:: number\nbody", caret: 22 });
  });

  it("removes it again, with its newline", () => {
    expect(apply("one\nlist:: number", 3)).toEqual({ text: "one", caret: 3 });
    expect(apply("title\na:: 1\nlist:: number\nbody", 29)).toEqual({
      text: "title\na:: 1\nbody",
      caret: 15,
    });
    // An empty numbered item's buffer is "\nlist:: number" (core joinBlockText).
    expect(apply("\nlist:: number", 0)).toEqual({ text: "", caret: 0 });
  });

  it("turns another list style into a numbered one instead of removing it", () => {
    expect(apply("x\nlist:: bullet", 1).text).toBe("x\nlist:: number");
  });

  it("ignores a list:: line inside a code fence", () => {
    expect(apply("```yaml\nlist:: number\n```", 0).text).toBe(
      "```yaml\nlist:: number\n```\nlist:: number",
    );
  });

  it("the command edits the focused block through the editor host", () => {
    const editor = createFakeEditorHost({ content: "item", start: 4, end: 4 });
    const [command] = createNumberedListCommands({ editor });
    void command?.run({} as never);
    expect(editor.state?.content).toBe("item\nlist:: number");
    expect(editor.state?.start).toBe(4);
  });
});
