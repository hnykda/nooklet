import type { OutlineNode } from "@nooklet/core";
import { describe, expect, it } from "vitest";
import { parseSingleBlockGrammar, renderSingleBlockText } from "./outline-bridge.js";
import { OpError } from "./registry.js";

type BlockText = Parameters<typeof renderSingleBlockText>[0];

const block = (over: Partial<BlockText>): BlockText => ({
  content: "",
  marker: null,
  priority: null,
  properties: {},
  collapsed: false,
  ...over,
});

/** The fields `block.update` writes from a parsed single-block text. */
const fields = (node: OutlineNode) => ({
  content: node.content,
  marker: node.marker,
  priority: node.priority,
  properties: node.properties,
});

// B-172: `renderSingleBlockText` writes continuation and property lines flush-left (that is the
// `before` text agents match `old_str` against), but `parseSingleBlockGrammar` only put `- ` in
// front of line 1 — so line 2 onwards parsed as stray top-level blocks and every block with a
// property line or a second line was refused: "content must describe exactly one block".
describe("single-block text round trip (B-172)", () => {
  const cases: Array<[string, BlockText]> = [
    [
      "a task with a property line",
      block({ content: "buy milk", marker: "TODO", properties: { scheduled: "2026-09-13" } }),
    ],
    [
      "a DONE task with done:: and a priority",
      block({
        content: "file taxes",
        marker: "DONE",
        priority: "A",
        properties: { done: "2026-09-12T10:00:00.000Z", scheduled: "2026-09-10" },
      }),
    ],
    ["multi-line content", block({ content: "first line\nsecond line\n\nfourth line" })],
    [
      "multi-line content with properties and an indented line",
      block({ content: "notes\n    indented code\nend", properties: { type: "book" } }),
    ],
    [
      "a code fence after line 1, holding a bullet and a property-looking line",
      block({
        content: "snippet:\n```md\n- not a child\nkey:: not a property\n```",
        properties: { lang: "md" },
      }),
    ],
    [
      "a block that opens with a code fence, with properties (B-151)",
      block({ content: "```js\nconst x = 1;\n```", properties: { foo: "bar" } }),
    ],
    ["a collapsed block", block({ content: "parent", collapsed: true })],
    // As the first (only) bullet of a text, a block with no content and only property lines is
    // what the parser reads as a page-properties pre-block (OUT-2): it came back as no block.
    [
      "an empty block with only properties, collapsed",
      block({ content: "", properties: { type: "book" }, collapsed: true }),
    ],
  ];

  for (const [name, b] of cases) {
    it(`parses its own rendering back unchanged: ${name}`, () => {
      const text = renderSingleBlockText(b);
      expect(fields(parseSingleBlockGrammar(text, "flush"))).toEqual({
        content: b.content,
        marker: b.marker,
        priority: b.priority,
        properties: b.properties,
      });
      expect(parseSingleBlockGrammar(text, "flush").collapsed).toBe(b.collapsed);
    });
  }

  it("renders continuation and property lines flush-left, as `before` shows them", () => {
    expect(
      renderSingleBlockText(
        block({
          content: "buy milk\nand bread",
          marker: "TODO",
          properties: { scheduled: "2026-09-13" },
        }),
      ),
    ).toBe("TODO buy milk\nscheduled:: 2026-09-13\nand bread");
  });

  it("flips a marker by substring on a task with a property line", () => {
    const text = renderSingleBlockText(
      block({ content: "buy milk", marker: "TODO", properties: { scheduled: "2026-09-13" } }),
    );
    expect(fields(parseSingleBlockGrammar(text.replace("TODO", "DONE"), "flush"))).toEqual({
      content: "buy milk",
      marker: "DONE",
      priority: null,
      properties: { scheduled: "2026-09-13" },
    });
  });

  it("reads `content` in page_read's indented shape too (auto)", () => {
    const node = parseSingleBlockGrammar(
      "TODO buy milk\n  scheduled:: 2026-09-13\n  and bread\n\n  ```js\n  - x\n  ```",
      "auto",
    );
    expect(fields(node)).toEqual({
      content: "buy milk\nand bread\n\n```js\n- x\n```",
      marker: "TODO",
      priority: null,
      properties: { scheduled: "2026-09-13" },
    });
  });

  it("reads flush `content` as flush under auto, keeping an indented line that is not alone", () => {
    const node = parseSingleBlockGrammar("notes\nscheduled:: 2026-09-13\n  indented", "auto");
    expect(fields(node)).toEqual({
      content: "notes\n  indented",
      marker: null,
      priority: null,
      properties: { scheduled: "2026-09-13" },
    });
  });

  it("the flush form never strips an indent the content really has", () => {
    const b = block({ content: "intro\n  every later line indented\n  like this" });
    const text = renderSingleBlockText(b);
    expect(parseSingleBlockGrammar(text, "flush").content).toBe(b.content);
  });

  it("still refuses a nested bullet, flush or indented", () => {
    for (const text of ["parent\n- child", "parent\n  - child"]) {
      for (const form of ["flush", "auto"] as const) {
        let err: unknown;
        try {
          parseSingleBlockGrammar(text, form);
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(OpError);
        expect((err as OpError).message).toMatch(/block_update edits one block/);
      }
    }
  });
});
