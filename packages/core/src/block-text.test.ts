import { describe, expect, it } from "vitest";
import {
  blockTextPayloads,
  contentOffsetToEditText,
  editTextOffsetToContent,
  joinBlockText,
  samePropertySet,
  splitBlockText,
} from "./block-text.js";
import { parseOutline } from "./outline.js";

describe("splitBlockText", () => {
  it("takes property lines out of the content (B-101: `/property` text becomes a property)", () => {
    expect(splitBlockText("start here \nkey:: bar")).toEqual({
      content: "start here ",
      properties: { key: "bar" },
    });
  });

  it("agrees with parseOutline on what a property line is, wherever it sits", () => {
    const text = "first\nfoo:: bar\nsecond\nMy_Key:: v\nthird";
    const parsed = parseOutline(`- ${text.replaceAll("\n", "\n  ")}`).blocks[0];
    const split = splitBlockText(text);
    expect(split.content).toBe(parsed?.content);
    expect(split.properties).toEqual(parsed?.properties);
    expect(split.properties).toEqual({ foo: "bar", "my-key": "v" });
  });

  it("leaves a key:: value line inside a fence alone", () => {
    const text = "```yaml\nfoo:: bar\n```\nreal:: yes";
    expect(splitBlockText(text)).toEqual({
      content: "```yaml\nfoo:: bar\n```",
      properties: { real: "yes" },
    });
  });

  it("keeps reserved and heading lines as content text", () => {
    const text = "task\nscheduled:: 2026-09-20\nid:: abc\nheading:: 2\ncollapsed:: true\nx:: 1";
    expect(splitBlockText(text)).toEqual({
      content: "task\nscheduled:: 2026-09-20\nid:: abc\nheading:: 2\ncollapsed:: true",
      properties: { x: "1" },
    });
  });

  it("does not trim what is being typed", () => {
    expect(splitBlockText("a \n")).toEqual({ content: "a \n", properties: {} });
    expect(splitBlockText("")).toEqual({ content: "", properties: {} });
  });

  it("a property as the only line leaves empty content", () => {
    expect(splitBlockText("list:: number")).toEqual({
      content: "",
      properties: { list: "number" },
    });
  });
});

describe("joinBlockText", () => {
  const cases: Array<[string, Record<string, string>]> = [
    ["one line", { foo: "bar" }],
    ["line one\nline two", { a: "1", b: "2" }],
    ["", { list: "number" }],
    ["\nstarts empty", { k: "v" }],
    ["```js\ncode\n```", { lang: "js" }],
    ["```js\nnever closed", { k: "v" }],
    ["no props at all", {}],
  ];

  it.each(cases)("round-trips %j", (content, properties) => {
    const text = joinBlockText(content, properties);
    const back = splitBlockText(text);
    expect(back.content).toBe(content);
    expect(samePropertySet(back.properties, properties)).toBe(true);
  });

  it("writes properties right after line 1, the file's own shape", () => {
    expect(joinBlockText("title\nbody", { foo: "bar" })).toBe("title\nfoo:: bar\nbody");
  });

  it("puts a fenced block's properties after the fence, not inside it (B-151)", () => {
    expect(joinBlockText("```js\ncode\n```", { k: "v" })).toBe("```js\ncode\n```\nk:: v");
    expect(joinBlockText("```js\nnever closed", { k: "v" })).toBe("k:: v\n```js\nnever closed");
  });

  it("leaves out keys that editing text does not carry", () => {
    expect(joinBlockText("x", { heading: "2", list: "number" })).toBe("x\nlist:: number");
  });
});

describe("offset mapping", () => {
  const content = "ab\ncd";
  const text = joinBlockText(content, { k: "v" }); // "ab\nk:: v\ncd"

  it("maps every content offset into the text and back", () => {
    for (let offset = 0; offset <= content.length; offset++) {
      const t = contentOffsetToEditText(text, offset);
      expect(text.slice(0, t).replace("k:: v\n", "")).toBe(content.slice(0, offset));
      expect(editTextOffsetToContent(text, t)).toBe(offset);
    }
  });

  it("a caret inside a property line maps to the end of the content line above it", () => {
    const inProp = text.indexOf("k::") + 2;
    expect(editTextOffsetToContent(text, inProp)).toBe(2);
  });

  it("is the identity for a block without properties", () => {
    for (const offset of [0, 1, 3, 5]) {
      expect(contentOffsetToEditText(content, offset)).toBe(offset);
      expect(editTextOffsetToContent(content, offset)).toBe(offset);
    }
  });

  it("an empty block whose only line is a property maps to 0", () => {
    expect(contentOffsetToEditText("list:: number", 0)).toBe(0);
    expect(editTextOffsetToContent("list:: number", 6)).toBe(0);
  });
});

describe("blockTextPayloads", () => {
  it("writes a real property instead of literal text (B-101)", () => {
    expect(
      blockTextPayloads({ content: "start here ", properties: {} }, "start here \nstatus:: done"),
    ).toEqual([{ kind: "block.prop", key: "status", value: "done" }]);
  });

  it("removes a deleted line's property and changes an edited value", () => {
    expect(
      blockTextPayloads({ content: "x", properties: { a: "1", b: "2" } }, "x!\nb:: 3"),
    ).toEqual([
      { kind: "block.text", content: "x!" },
      { kind: "block.prop", key: "a", value: null },
      { kind: "block.prop", key: "b", value: "3" },
    ]);
  });

  it("nothing moved, nothing written", () => {
    expect(blockTextPayloads({ content: "x", properties: { a: "1" } }, "x\na:: 1")).toEqual([]);
  });

  it("never deletes a key the text could not have shown", () => {
    expect(blockTextPayloads({ content: "x", properties: { heading: "2" } }, "x")).toEqual([]);
  });
});
