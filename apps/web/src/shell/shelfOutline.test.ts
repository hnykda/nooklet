import { describe, expect, it } from "vitest";
import { blockTitle, type OutlineSource, outlineEntries } from "./shelfOutline.js";

const node = (id: string, content: string, children: OutlineSource[] = []): OutlineSource => ({
  id,
  content,
  children,
});

describe("blockTitle", () => {
  it("strips markdown and reads refs by name", () => {
    expect(blockTitle("## Meeting with [[Aurora]] about **launch** #q3")).toEqual({
      text: "Meeting with Aurora about launch #q3",
      level: 2,
    });
    expect(blockTitle("plain `code` and [a link](https://x.y)")).toEqual({
      text: "plain code and a link",
    });
  });

  it("takes the first line of a multi-line block", () => {
    expect(blockTitle("first line\nsecond line")).toEqual({ text: "first line" });
  });

  it("names a fence by its language", () => {
    expect(blockTitle("```ts\nlet x = 1\n```")).toEqual({ text: "```ts" });
  });
});

describe("outlineEntries", () => {
  it("lists every heading at any depth plus every top-level block, indented by depth", () => {
    const entries = outlineEntries([
      node("h1", "# Intro", [
        node("d1", "detail one"),
        node("h2", "## Sub heading", [node("deep", "deep detail")]),
      ]),
      node("top", "plain top", [node("child", "child")]),
    ]);
    expect(entries).toEqual([
      { id: "h1", text: "Intro", depth: 0, level: 1 },
      { id: "h2", text: "Sub heading", depth: 1, level: 2 },
      { id: "top", text: "plain top", depth: 0 },
    ]);
  });

  it("gives an empty block something to click on", () => {
    expect(outlineEntries([node("e", "")])).toEqual([{ id: "e", text: "…", depth: 0 }]);
  });
});
