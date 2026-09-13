import { describe, expect, it } from "vitest";
import type { OutlineNode, ParsedPage } from "./model.js";
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

  // B-310: a task whose content opens with a fence. With ids, OUT-14 wrote the id alone and dropped
  // the marker; without ids, `- TODO ```js` never opened the fence on re-read, so the code's `- `
  // lines became child blocks and the content shrank to its first line.
  describe("a task block that opens with a fence (B-310)", () => {
    const node = (over: Partial<OutlineNode>): OutlineNode => ({
      content: "",
      marker: null,
      priority: null,
      properties: {},
      collapsed: false,
      children: [],
      ...over,
    });
    const fenceTask = (withIds: boolean): ParsedPage => ({
      properties: {},
      blocks: [
        node({
          ...(withIds ? { id: "1k7f3q9xz2hav4" } : {}),
          content: "```js\n- not a bullet\nfoo:: not a property\n```",
          marker: "TODO",
          priority: "A",
          properties: { foo: "bar" },
          children: [node({ ...(withIds ? { id: "1k7f3q9xz2hav5" } : {}), content: "child" })],
        }),
        node({ content: "next" }),
      ],
    });

    it("keeps the marker and priority in the mirror: head and id alone on line 1", () => {
      const page = fenceTask(true);
      const text = serializeOutline(page);
      expect(text).toBe(
        "- TODO [#A] ^1k7f3q9xz2hav4\n  foo:: bar\n  ```js\n  - not a bullet\n  foo:: not a property\n  ```\n  - child ^1k7f3q9xz2hav5\n- next\n",
      );
      expect(parseOutline(text)).toEqual(page);
    });

    it("keeps the fence whole without ids, properties after the closed fence", () => {
      const page = fenceTask(false);
      const text = serializeOutline(page, { ids: "none" });
      expect(text).toBe(
        "- TODO [#A] ```js\n  - not a bullet\n  foo:: not a property\n  ```\n  foo:: bar\n  - child\n- next\n",
      );
      expect(parseOutline(text)).toEqual(page);
    });

    it("writes the head alone before a fence that never closes, when there are properties", () => {
      const page: ParsedPage = {
        properties: {},
        blocks: [node({ content: "```js\ncode", marker: "LATER", properties: { foo: "bar" } })],
      };
      const text = serializeOutline(page, { ids: "none" });
      expect(text).toBe("- LATER\n  foo:: bar\n  ```js\n  code\n");
      expect(parseOutline(text)).toEqual(page);
    });

    it("writes a task without properties or ids as typed: `- TODO ```js`", () => {
      const page: ParsedPage = {
        properties: {},
        blocks: [node({ content: "```js\n- x\n```", marker: "DONE" }), node({ content: "next" })],
      };
      const text = serializeOutline(page, { ids: "none" });
      expect(text).toBe("- DONE ```js\n  - x\n  ```\n- next\n");
      expect(parseOutline(text)).toEqual(page);
    });

    it("still reads inline code after a marker as text, not as a fence", () => {
      const p = parseOutline("- TODO ```x``` later\n- next\n");
      expect(p.blocks.map((b) => [b.marker, b.content])).toEqual([
        ["TODO", "```x``` later"],
        [null, "next"],
      ]);
    });
  });

  // B-390: a line 1 holding nothing but `^id` (after any marker/priority) kept the id only when
  // another line followed, so every empty block in the mirror (`- ^id`) and the owner's one task
  // whose content opens with a blank line (`- LATER ^id` + text) came back with `^id` as text.
  describe("a block whose line 1 is only its id (B-390)", () => {
    const node = (over: Partial<OutlineNode>): OutlineNode => ({
      content: "",
      marker: null,
      priority: null,
      properties: {},
      collapsed: false,
      children: [],
      ...over,
    });

    it("round-trips empty blocks with ids, including a page's first block", () => {
      const page: ParsedPage = {
        properties: { title: "X" },
        blocks: [
          node({ id: "1k7f3q9xz2hav4" }),
          node({ id: "1k7f3q9xz2hav5", content: "a", children: [node({ id: "1k7f3q9xz2hav6" })] }),
          node({ id: "1k7f3q9xz2hav7", marker: "TODO" }),
          node({ id: "1k7f3q9xz2hav8", priority: "B", collapsed: true, properties: { k: "v" } }),
        ],
      };
      const text = serializeOutline(page);
      expect(text).toBe(
        "title:: X\n- ^1k7f3q9xz2hav4\n- a ^1k7f3q9xz2hav5\n  - ^1k7f3q9xz2hav6\n- TODO ^1k7f3q9xz2hav7\n- [#B] ^1k7f3q9xz2hav8\n  collapsed:: true\n  k:: v\n",
      );
      expect(parseOutline(text)).toEqual(page);
      // With no page properties the empty first block is still a block, not a pre-block.
      const bare: ParsedPage = { properties: {}, blocks: page.blocks.slice(0, 1) };
      expect(parseOutline(serializeOutline(bare))).toEqual(bare);
    });

    it("round-trips a content whose line 1 is empty, with and without a marker", () => {
      const page: ParsedPage = {
        properties: {},
        blocks: [
          node({ id: "1m287mdbgs5v8t", marker: "LATER", content: "\n> Hm, quoted" }),
          node({ id: "1k7f3q9xz2hav4", content: "\nsecond" }),
        ],
      };
      const text = serializeOutline(page);
      expect(text).toBe("- LATER ^1m287mdbgs5v8t\n  > Hm, quoted\n- ^1k7f3q9xz2hav4\n  second\n");
      expect(parseOutline(text)).toEqual(page);
    });

    it("keeps a page-level `id::` pre-block line a page property (OUT-15)", () => {
      const p = parseOutline("id:: 64f1a2b3-0000-4000-8000-000000000001\n\n- ^1k7f3q9xz2hav4\n");
      expect(p.properties).toEqual({ id: "64f1a2b3-0000-4000-8000-000000000001" });
      expect(p.blocks).toEqual([node({ id: "1k7f3q9xz2hav4" })]);
    });
  });

  // B-151: without an id to stand alone on line 1, property lines written straight after a
  // fence-opening line 1 landed inside the fence and came back as code.
  describe("a block that opens with a fence, without ids (B-151)", () => {
    const fenceBlock = (
      content: string,
      properties: Record<string, string>,
      collapsed = false,
    ) => ({
      properties: {},
      blocks: [
        { content, marker: null, priority: null, properties, collapsed, children: [] },
        {
          content: "next",
          marker: null,
          priority: null,
          properties: {},
          collapsed: false,
          children: [],
        },
      ],
    });

    it("keeps its properties, written after the closed fence", () => {
      const page = fenceBlock("```js\nfoo:: not a property\n```\nafter", { foo: "bar" }, true);
      const text = serializeOutline(page, { ids: "none" });
      expect(text).toBe(
        "- ```js\n  foo:: not a property\n  ```\n  after\n  collapsed:: true\n  foo:: bar\n- next\n",
      );
      expect(parseOutline(text)).toEqual(page);
    });

    it("keeps its properties when the fence never closes, on the bullet line before it", () => {
      // Alone on its page: an unclosed fence swallows every later bullet, whatever this fix does.
      const page = fenceBlock("```js\ncode\n- not a bullet", { foo: "bar", baz: "qux" });
      page.blocks.pop();
      const text = serializeOutline(page, { ids: "none" });
      expect(text).toBe("- foo:: bar\n  baz:: qux\n  ```js\n  code\n  - not a bullet\n");
      expect(parseOutline(text)).toEqual(page);
    });

    it("still writes a fence-first block without properties unchanged", () => {
      const page = fenceBlock("```js\ncode\n```", {});
      expect(serializeOutline(page, { ids: "none" })).toBe("- ```js\n  code\n  ```\n- next\n");
    });
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

// Verification of B-310/B-390 (core-ops-verify): every serializer branch (OUT-14 head-and-id line,
// B-151 placements, the plain line 1) against every head a block can carry, in both id modes, next
// to a child and a following sibling. The two fixes each changed which line 1 the parser skips; a
// matrix is what shows no other combination lost its marker, id, properties or text on the way.
describe("serialize -> parse is lossless across heads, ids, properties and content shapes", () => {
  const contents = [
    "",
    "text",
    "```x``` inline",
    "\nsecond line after an empty line 1",
    "text\n```js\n- in a fence\nk:: in a fence\n```",
    "```js\n- in a fence\nk:: in a fence\n```",
    "~~~\ncode\n~~~\nafter the fence",
    "```\nnever closes",
  ];
  const cases: Array<{ name: string; node: OutlineNode }> = [];
  for (const content of contents)
    for (const marker of [null, "TODO", "DONE"] as const)
      for (const priority of [null, "B"] as const)
        for (const properties of [{}, { k: "v", other: "w" }])
          for (const collapsed of [false, true])
            cases.push({
              name: JSON.stringify({ content, marker, priority, properties, collapsed }),
              node: { content, marker, priority, properties, collapsed, children: [] },
            });

  const withIds = (n: OutlineNode, ids: boolean, k: number): OutlineNode => {
    const out: OutlineNode = {
      ...n,
      children: n.children.map((c, i) => withIds(c, ids, k * 7 + i)),
    };
    if (ids) out.id = `1k7f3q9xz2h${String(100 + k).slice(-3)}`;
    return out;
  };

  for (const ids of [true, false]) {
    it(`round-trips ${cases.length} blocks ${ids ? "with" : "without"} ids`, () => {
      const failures: string[] = [];
      cases.forEach(({ name, node }, k) => {
        // A fence that never closes swallows every later line of the file, so that block goes last
        // and childless — the only place such a block can round-trip at all.
        const unclosed = node.content.startsWith("```\n");
        const child: OutlineNode = { ...node, content: "child", marker: null, children: [] };
        const block: OutlineNode = unclosed ? node : { ...node, children: [child] };
        const blocks = unclosed
          ? [{ ...child, content: "before" }, block]
          : [{ ...child, content: "", properties: {} }, block, { ...child, content: "next" }];
        for (const properties of [{}, { title: "Page" }]) {
          const page: ParsedPage = {
            properties,
            blocks: blocks.map((b, i) => withIds(b, ids, k * 10 + i)),
          };
          const text = serializeOutline(page, ids ? {} : { ids: "none" });
          if (JSON.stringify(parseOutline(text)) !== JSON.stringify(page)) {
            failures.push(`${name}\n${text}`);
          }
        }
      });
      expect(failures).toEqual([]);
    });
  }
});
