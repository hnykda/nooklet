// @vitest-environment jsdom
/**
 * `resolveClickOffset` needs the browser's hit test, which jsdom does not have — so the hit test is
 * stubbed here to answer what Chromium was measured answering (B-325), and the mapping from that
 * answer to a source offset is what is under test. The real gesture is covered in
 * `e2e/tests/render-views.spec.ts`.
 */
import { classifyBlockContent } from "@nooklet/core";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { resolveClickOffset } from "./caret.js";
import { BlockContentView } from "./render/tokens.js";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, "caretRangeFromPoint");
});

function renderBlock(content: string): HTMLElement {
  const { container } = render(() => (
    <BlockContentView content={classifyBlockContent(content)} ctx={{ source: content }} />
  ));
  return container;
}

/** Make the (stubbed) hit test answer a caret at `offset` in `node` for any point. */
function hit(node: Node, offset: number): void {
  const range = document.createRange();
  range.setStart(node, offset);
  Object.defineProperty(document, "caretRangeFromPoint", {
    configurable: true,
    value: () => range,
  });
}

describe("resolveClickOffset", () => {
  it("a point between a paragraph's children on an empty line lands on that line (B-325)", () => {
    const container = renderBlock("alpha\n\ngamma");
    const p = container.querySelector("p") as HTMLElement;
    // [span alpha][br 5][br 6][span gamma]: before the second break is the empty line.
    hit(p, 2);
    expect(resolveClickOffset(container, 0, 0)).toBe(6);
    // Before the first break: the end of "alpha".
    hit(p, 1);
    expect(resolveClickOffset(container, 0, 0)).toBe(5);
    // After the last child: nothing follows, so the one before says where.
    hit(p, p.childNodes.length);
    expect(resolveClickOffset(container, 0, 0)).toBe(12);
  });

  it("a point inside a text node still resolves by the character under it", () => {
    const container = renderBlock("alpha\n\ngamma");
    const gamma = [...container.querySelectorAll("span")].find((s) => s.textContent === "gamma");
    hit(gamma?.firstChild as Node, 2);
    expect(resolveClickOffset(container, 0, 0)).toBe(9);
  });

  it("a point between children that carry no offsets is still unresolved", () => {
    const container = renderBlock("alpha\n\ngamma");
    hit(container, 0);
    expect(resolveClickOffset(container, 0, 0)).toBeNull();
  });
});

/** The text node whose text is `text`. */
function textNode(container: HTMLElement, text: string): Node {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent === text) return n;
  throw new Error(`no text node "${text}"`);
}

describe("resolveClickOffset at a line's edges (B-606)", () => {
  it("the end of a trailing link's text is after its `]]`", () => {
    const content = "plain text [[Balení]]";
    const container = renderBlock(content);
    hit(textNode(container, "Balení"), 6);
    expect(resolveClickOffset(container, 0, 0)).toBe(content.length);
  });

  it("the end of a trailing bold is after its closing `**`", () => {
    const content = "text **bold**";
    const container = renderBlock(content);
    hit(textNode(container, "bold"), 4);
    expect(resolveClickOffset(container, 0, 0)).toBe(content.length);
  });

  it("the start of a leading link is before its `[[`", () => {
    const container = renderBlock("[[Lead]] words");
    hit(textNode(container, "Lead"), 0);
    expect(resolveClickOffset(container, 0, 0)).toBe(0);
  });

  it("a character inside a link counts from after the `[[`", () => {
    const container = renderBlock("[[Lead]] words");
    hit(textNode(container, "Lead"), 2);
    expect(resolveClickOffset(container, 0, 0)).toBe(4); // `[[Le|ad]]`
  });

  it("the end of a link with text after it is unchanged: inside, before the `]]`", () => {
    const container = renderBlock("a [[Mid]] b");
    hit(textNode(container, "Mid"), 3);
    expect(resolveClickOffset(container, 0, 0)).toBe(7); // `a [[Mid|]] b`
  });

  it("the end of a link that ends a line of a multi-line block is that line's end", () => {
    const content = "see [[One]]\nsecond";
    const container = renderBlock(content);
    hit(textNode(container, "One"), 3);
    expect(resolveClickOffset(container, 0, 0)).toBe(content.indexOf("\n"));
  });
});
