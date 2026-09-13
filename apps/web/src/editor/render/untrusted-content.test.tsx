// @vitest-environment jsdom
/**
 * Block text is untrusted (sync, import, MCP agents): what it may put into the rendered DOM
 * (docs/BUGS.md B-138). The e2e twin is `e2e/tests/untrusted-content.spec.ts`.
 */
import { classifyBlockContent } from "@nooklet/core";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { BlockContentView } from "./tokens.js";

afterEach(cleanup);

function renderContent(content: string) {
  const bc = classifyBlockContent(content);
  return render(() => <BlockContentView content={bc} ctx={{ source: content }} />);
}

describe("code fence info strings", () => {
  const classesOf = (el: Element | null | undefined): string[] =>
    (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

  it("only the first word names the language; the rest cannot add classes", () => {
    const { container } = renderContent("```js cmd-overlay vr-row\nconst x = 1;\n```");
    const code = container.querySelector("pre.vr-fence code");
    expect(classesOf(code)).toEqual(["language-js"]);
    // The raw info string is still there to read, as an inert attribute value.
    expect(container.querySelector("pre.vr-fence")?.getAttribute("data-lang")).toBe(
      "js cmd-overlay vr-row",
    );
  });

  it("the highlighted branch takes the same class", () => {
    const bc = classifyBlockContent("```js cmd-overlay\nx\n```");
    const { container } = render(() => (
      <BlockContentView
        content={bc}
        ctx={{ source: "", highlightCode: () => '<span class="tok">x</span>' }}
      />
    ));
    expect(classesOf(container.querySelector("pre.vr-fence code"))).toEqual([
      "language-js",
      "hljs",
    ]);
  });

  it("a first word that is not a language name is reduced to class-safe characters", () => {
    const { container } = renderContent('```c++"><b\nx\n```');
    expect(classesOf(container.querySelector("pre.vr-fence code"))).toEqual(["language-c++b"]);
  });
});
