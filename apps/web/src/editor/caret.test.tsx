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
