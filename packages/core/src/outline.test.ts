import { describe, expect, it } from "vitest";
import { parseOutline, serializeOutline } from "./outline.js";

const roundTrip = (text: string) => serializeOutline(parseOutline(text));

describe("parseOutline", () => {
  it("parses nested tab-indented bullets", () => {
    const p = parseOutline("- a\n\t- b\n\t\t- c\n\t- d\n- e\n");
    expect(p.blocks.map((b) => b.content)).toEqual(["a", "e"]);
    expect(p.blocks[0]?.children.map((b) => b.content)).toEqual(["b", "d"]);
    expect(p.blocks[0]?.children[0]?.children[0]?.content).toBe("c");
  });

  it("parses 2-space and 4-space indented bullets", () => {
    for (const ind of ["  ", "    "]) {
      const p = parseOutline(`- a\n${ind}- b\n${ind}${ind}- c\n${ind}- d\n- e\n`);
      expect(p.blocks.map((b) => b.content)).toEqual(["a", "e"]);
      expect(p.blocks[0]?.children.map((b) => b.content)).toEqual(["b", "d"]);
      expect(p.blocks[0]?.children[0]?.children[0]?.content).toBe("c");
    }
  });

  it("handles over-indented children and irregular dedents", () => {
    const p = parseOutline("- a\n\t\t\t- b\n\t- c\n");
    expect(p.blocks[0]?.children.map((b) => b.content)).toEqual(["b", "c"]);
  });

  it("keeps continuation lines and blank lines inside a block", () => {
    const p = parseOutline("- first\n  second\n\n  fourth\n\n- next\n");
    expect(p.blocks[0]?.content).toBe("first\nsecond\n\nfourth");
    expect(p.blocks[1]?.content).toBe("next");
  });

  it("keeps continuation lines of nested blocks (tab + 2 spaces)", () => {
    const p = parseOutline("- a\n\t- b\n\t  more b\n\t\t- c\n");
    expect(p.blocks[0]?.children[0]?.content).toBe("b\nmore b");
    expect(p.blocks[0]?.children[0]?.children[0]?.content).toBe("c");
  });

  it("accepts a tab as the continuation marker", () => {
    const p = parseOutline("- a\n\tcontinued\n\t- b\n\t\tmore b\n");
    expect(p.blocks[0]?.content).toBe("a\ncontinued");
    expect(p.blocks[0]?.children[0]?.content).toBe("b\nmore b");
  });

  it("treats a leading id-only block as page properties", () => {
    const p = parseOutline("id:: 64f1a2b3-0000-4000-8000-000000000001\n\n- a\n");
    expect(p.properties).toEqual({ id: "64f1a2b3-0000-4000-8000-000000000001" });
    expect(p.blocks.map((b) => b.content)).toEqual(["a"]);
  });

  it("does not treat bullets inside fenced code as blocks", () => {
    const text = "- code:\n  ```md\n  - not a block\n  ```\n- after\n";
    const p = parseOutline(text);
    expect(p.blocks).toHaveLength(2);
    expect(p.blocks[0]?.content).toBe("code:\n```md\n- not a block\n```");
  });

  it("handles a fence opened on the bullet line", () => {
    const p = parseOutline("- ```js\n  const x = 1;\n  ```\n\t- child\n");
    expect(p.blocks[0]?.content).toBe("```js\nconst x = 1;\n```");
    expect(p.blocks[0]?.children[0]?.content).toBe("child");
  });

  it("extracts block properties, id and collapsed", () => {
    const p = parseOutline(
      "- text\n  id:: 64f1a2b3-0000-4000-8000-000000000001\n  collapsed:: true\n  type:: book\n\t- child\n",
    );
    const b = p.blocks[0];
    expect(b?.content).toBe("text");
    expect(b?.id).toBe("64f1a2b3-0000-4000-8000-000000000001");
    expect(b?.collapsed).toBe(true);
    expect(b?.properties).toEqual({ type: "book" });
  });

  it("does not treat property-like lines inside fences as properties", () => {
    const p = parseOutline("- ```yaml\n  key:: value\n  ```\n");
    expect(p.blocks[0]?.properties).toEqual({});
    expect(p.blocks[0]?.content).toBe("```yaml\nkey:: value\n```");
  });

  it("parses task markers and priority", () => {
    const p = parseOutline(
      "- TODO buy milk\n- DOING [#A] work\n- DONE\n- LATER x\n- NOW y\n- WAITING z\n- CANCELLED q\n- TODOS are not markers\n",
    );
    expect(p.blocks.map((b) => [b.marker, b.priority, b.content])).toEqual([
      ["TODO", null, "buy milk"],
      ["DOING", "A", "work"],
      ["DONE", null, ""],
      ["LATER", null, "x"],
      ["NOW", null, "y"],
      ["WAITING", null, "z"],
      ["CANCELED", null, "q"],
      [null, null, "TODOS are not markers"],
    ]);
  });

  it("parses page properties from a pre-block", () => {
    const p = parseOutline("title:: My Page\ntags:: a, b\n\n- first\n");
    expect(p.properties).toEqual({ title: "My Page", tags: "a, b" });
    expect(p.blocks.map((b) => b.content)).toEqual(["first"]);
  });

  it("parses page properties from a bulleted pre-block", () => {
    const p = parseOutline("- title:: My Page\n  alias:: mp\n- first\n");
    expect(p.properties).toEqual({ title: "My Page", alias: "mp" });
    expect(p.blocks.map((b) => b.content)).toEqual(["first"]);
  });

  it("parses YAML front matter", () => {
    const p = parseOutline("---\ntitle: Front\ntags: x\n---\n- a\n");
    expect(p.properties).toEqual({ title: "Front", tags: "x" });
    expect(p.blocks.map((b) => b.content)).toEqual(["a"]);
  });

  it("treats non-bulleted paragraphs as blocks", () => {
    const p = parseOutline("Just a paragraph\nwith two lines\n\n- a bullet\n");
    expect(p.blocks.map((b) => b.content)).toEqual([
      "Just a paragraph\nwith two lines",
      "a bullet",
    ]);
  });

  it("parses empty bullets", () => {
    const p = parseOutline("-\n- \n- x\n");
    expect(p.blocks.map((b) => b.content)).toEqual(["", "", "x"]);
  });

  it("handles CRLF", () => {
    const p = parseOutline("- a\r\n\t- b\r\n");
    expect(p.blocks[0]?.children[0]?.content).toBe("b");
  });

  // B-266: the owner's graph has `SCHEDULED: <2023-2-17 Fri>` — month and day without zero
  // padding, which mldoc reads (`Scanf.sscanf s "%d-%d-%d"`). They stayed in the text as literal
  // lines, with no schedule. An hour without padding was worse: the line was consumed and the
  // reducer then refused `2026-09-14 9:05`, so the schedule vanished entirely.
  it("reads org timestamps without zero padding, and stores them padded", () => {
    const p = parseOutline(
      "- DONE Mirek\n  SCHEDULED: <2023-2-17 Fri>\n- LATER call\n  DEADLINE: <2022-12-8 Thu 9:05 .+1w>\n",
    );
    expect(p.blocks[0]).toMatchObject({
      content: "Mirek",
      marker: "DONE",
      properties: { scheduled: "2023-02-17" },
    });
    expect(p.blocks[1]).toMatchObject({
      content: "call",
      properties: { deadline: "2022-12-08 09:05", repeat: "1w" },
    });
  });
});

describe("serializeOutline", () => {
  it("writes 2-space indent, markers, priorities, an id suffix and continuation lines", () => {
    const text =
      "- TODO [#B] task ^64f1a2b3000041\n  second line\n  - child\n    collapsed:: true\n    - grandchild\n";
    expect(roundTrip(text)).toBe(text);
  });

  it("still supports tab indentation as an explicit option", () => {
    const parsed = parseOutline("- a ^64f1a2b3000041\n  - b\n");
    expect(serializeOutline(parsed, { indent: "\t" })).toBe("- a ^64f1a2b3000041\n\t- b\n");
  });

  it("writes a lone-id first line before a fence (OUT-14)", () => {
    const text = "- ^64f1a2b3000041\n  ```js\n  const x = 1;\n  ```\n";
    expect(roundTrip(text)).toBe(text);
  });

  it("writes page properties", () => {
    const text = "title:: X\nalias:: y\n- a\n";
    expect(roundTrip(text)).toBe(text);
  });

  it("round-trips fences and blank lines", () => {
    const text = "- code\n  ```js\n  - dash\n  ```\n\n  after blank\n- b\n";
    const once = parseOutline(text);
    const twice = parseOutline(serializeOutline(once));
    expect(twice).toEqual(once);
  });

  it("writes empty blocks as a bare dash", () => {
    expect(
      serializeOutline({
        properties: {},
        blocks: [
          {
            content: "",
            marker: null,
            priority: null,
            properties: {},
            collapsed: false,
            children: [],
          },
        ],
      }),
    ).toBe("-\n");
  });
});
