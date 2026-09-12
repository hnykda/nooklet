// @vitest-environment jsdom
/**
 * The two render seams wired in M7 (highlighted fences, KaTeX math) and the ```query fence's
 * rendered states, at the component level. The evaluator is mocked here — its SQL is covered by
 * `../../data/queries.test.ts`, the whole path by `e2e/tests/query.spec.ts`.
 */
import { classifyBlockContent } from "@nooklet/core";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryResults } from "../../data/queries.js";

const fake = vi.hoisted(() => ({ results: undefined as QueryResults | undefined }));
vi.mock("../../data/queries.js", () => ({
  useQueryResults: () => ({
    get latest() {
      return fake.results;
    },
    error: undefined,
    loading: false,
  }),
}));

import { _resetHighlightCache } from "./highlight.js";
import { _setMathForTests } from "./math.js";
import { BlockContentView, type RenderCtx } from "./tokens.js";

afterEach(() => {
  cleanup();
  _setMathForTests(undefined);
  _resetHighlightCache();
});

function renderContent(content: string, ctx: Partial<RenderCtx> = {}) {
  const bc = classifyBlockContent(content);
  return render(() => <BlockContentView content={bc} ctx={{ source: content, ...ctx }} />);
}

describe("code fences are highlighted lazily", () => {
  it("renders plain text first, then highlight.js spans once the grammar has loaded", async () => {
    const { container } = renderContent("```js\nconst x = 1;\n```");
    const code = container.querySelector("pre.vr-fence code") as HTMLElement;
    expect(code.textContent).toBe("const x = 1;");
    expect(code.querySelector("span")).toBeNull();
    await waitFor(() => {
      expect(container.querySelector("pre.vr-fence code .hljs-keyword")?.textContent).toBe("const");
    });
    expect(container.querySelector("pre.vr-fence code")?.textContent).toBe("const x = 1;");
  });

  it("leaves an unknown language as plain text", async () => {
    const { container } = renderContent("```whatever\nconst x = 1;\n```");
    await new Promise((r) => setTimeout(r, 30));
    expect(container.querySelector("pre.vr-fence code span")).toBeNull();
    expect(container.querySelector("pre.vr-fence")?.getAttribute("data-lang")).toBe("whatever");
  });

  it("a highlightCode override wins over the built-in highlighter", async () => {
    const { container } = renderContent("```js\nx\n```", {
      highlightCode: () => '<span class="tok">x</span>',
    });
    expect(container.querySelector("pre.vr-fence code")?.innerHTML).toBe(
      '<span class="tok">x</span>',
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(container.querySelector("pre.vr-fence code")?.innerHTML).toBe(
      '<span class="tok">x</span>',
    );
  });
});

describe("inline math", () => {
  it("shows the literal $tex$ until KaTeX is loaded, then KaTeX's HTML", () => {
    const { container } = renderContent("energy $E=mc^2$ today");
    expect(container.querySelector(".vr-math")?.textContent).toBe("$E=mc^2$");
    expect(container.querySelector(".vr-math-rendered")).toBeNull();

    cleanup();
    _setMathForTests({ renderToString: (tex) => `<span class="katex">${tex}</span>` });
    const second = renderContent("energy $E=mc^2$ today");
    const rendered = second.container.querySelector(".vr-math.vr-math-rendered");
    expect(rendered?.querySelector(".katex")?.textContent).toBe("E=mc^2");
    expect(rendered?.getAttribute("data-from")).toBe("7");
  });

  it("does not treat prices as math (Pandoc heuristic, grammar §2.9)", () => {
    _setMathForTests({ renderToString: () => "<span class=katex>x</span>" });
    const { container } = renderContent("$5 and $10 each");
    expect(container.querySelector(".vr-math")).toBeNull();
  });
});

describe("the ```query fence, rendered", () => {
  it("says what is wrong, and where, for a query that does not parse", async () => {
    fake.results = undefined;
    const { container } = renderContent("```query\nTODO (tag:work\n```");
    await waitFor(() => {
      expect(container.querySelector(".vr-query-error")?.textContent).toContain(
        "missing closing )",
      );
    });
    expect(container.querySelector(".vr-query-source mark")?.textContent).toBe("(tag:work");
  });

  it("says so in words when nothing matches", async () => {
    fake.results = { matched: 0, shown: 0, nested: 0, groups: [], truncated: false };
    const { container } = renderContent("```query\ntag:nothing\n```");
    await waitFor(() => {
      expect(container.querySelector(".vr-query-empty")?.textContent).toBe("No blocks match.");
    });
    expect(container.querySelector(".vr-query-count")?.textContent).toBe("0 blocks");
  });

  it("lists hits grouped by page with a count, and a click navigates without entering edit mode", async () => {
    fake.results = {
      matched: 2,
      shown: 2,
      nested: 0,
      truncated: false,
      groups: [
        {
          pageId: "p1",
          pageName: "Projects/Aurora",
          pageJournalDay: null,
          hits: [
            {
              id: "blk1",
              pageId: "p1",
              content: "Ship it #work",
              marker: "TODO",
              priority: "A",
              children: [
                {
                  id: "blk2",
                  pageId: "p1",
                  content: "sub task",
                  marker: null,
                  priority: null,
                  children: [],
                },
              ],
            },
          ],
        },
        {
          pageId: "p2",
          pageName: "2026-09-10",
          pageJournalDay: 20260910,
          hits: [
            {
              id: "blk3",
              pageId: "p2",
              content: "call bob",
              marker: "TODO",
              priority: null,
              children: [],
            },
          ],
        },
      ],
    };
    const onNavigate = vi.fn();
    const outer = vi.fn();
    const bc = classifyBlockContent("```query\nTODO tag:work\n```");
    const { container } = render(() => (
      // biome-ignore lint/a11y/noStaticElementInteractions: stands in for `.vr-block-view`'s click-to-edit handler
      // biome-ignore lint/a11y/useKeyWithClickEvents: test scaffold
      <div onClick={outer}>
        <BlockContentView content={bc} ctx={{ source: "", onNavigate }} />
      </div>
    ));
    await waitFor(() => {
      expect(container.querySelector(".vr-query-count")?.textContent).toBe("2 blocks on 2 pages");
    });
    expect([...container.querySelectorAll(".vr-query-page")].map((h) => h.textContent)).toEqual([
      "Projects/Aurora",
      "Sep 10th, 2026",
    ]);
    expect(container.querySelector('[data-block-id="blk1"] .vr-marker-TODO')).not.toBeNull();
    expect(container.querySelector('[data-block-id="blk1"] .vr-priority-A')).not.toBeNull();
    expect(container.querySelector('[data-block-id="blk1"] .vr-tag')?.textContent).toBe("#work");
    expect(container.querySelector('[data-block-id="blk2"]')?.textContent).toContain("sub task");

    const row = container.querySelector('[data-block-id="blk3"] .vr-query-hit-row') as HTMLElement;
    fireEvent.click(row);
    expect(onNavigate).toHaveBeenCalledWith({ kind: "block", id: "blk3" });
    expect(outer).not.toHaveBeenCalled();

    fireEvent.click(container.querySelector(".vr-query-page a") as HTMLElement);
    expect(onNavigate).toHaveBeenCalledWith({ kind: "page", name: "Projects/Aurora" });
    expect(outer).not.toHaveBeenCalled();
  });

  it("a query fence that is itself a result renders as a plain fence (no recursion)", () => {
    const { container } = renderContent("```query\nTODO\n```", { refDepth: 1 });
    expect(container.querySelector("pre.vr-fence[data-lang=query] code")?.textContent).toBe("TODO");
    expect(container.querySelector(".vr-query")).toBeNull();
  });
});
