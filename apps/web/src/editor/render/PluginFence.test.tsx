// @vitest-environment jsdom
/**
 * A fence whose language a plugin claimed (`registerCodeBlockRenderer`, ADR 023) is drawn by that
 * plugin, inside the block row it belongs to, and falls back to the ordinary code fence otherwise.
 * The replica lookups are mocked — `e2e/tests/plugins.spec.ts` runs the real thing.
 */
import { classifyBlockContent } from "@nooklet/core";
import type { CodeBlockRenderer, RenderInfo } from "@nooklet/plugin-api";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../data/plugin-lookups.js", () => ({
  loadBlock: async (id: string) => ({
    id,
    pageId: "p0000000000001",
    parentId: null,
    order: "a0",
    content: "```demo\nA -> B\n```",
    marker: null,
    priority: null,
    properties: {},
    collapsed: false,
    createdAt: 1,
    updatedAt: 1,
  }),
  loadPage: async () => ({
    id: "p0000000000001",
    name: "Zahrada",
    key: "zahrada",
    journalDay: null,
    properties: {},
    createdAt: 1,
    updatedAt: 1,
  }),
}));

import { registerFenceRenderer } from "./PluginFence.js";
import { BlockContentView } from "./tokens.js";

const disposers: Array<() => void> = [];
afterEach(() => {
  cleanup();
  for (const d of disposers.splice(0)) d();
});

function renderFenceInRow(content: string) {
  return render(() => (
    <div data-block-id="b0000000000001">
      <BlockContentView content={classifyBlockContent(content)} ctx={{ source: content }} />
    </div>
  ));
}

describe("plugin-rendered fences (B-103)", () => {
  it("hands the source, the element and the fence's block and page to the renderer", async () => {
    const calls: Array<{ source: string; info: RenderInfo }> = [];
    const renderer: CodeBlockRenderer = {
      render(source, el, info) {
        calls.push({ source, info });
        el.innerHTML = `<svg data-testid="drawn"></svg>`;
      },
    };
    disposers.push(registerFenceRenderer("demo", renderer));

    const { container } = renderFenceInRow("```demo\nA -> B\n```");

    await waitFor(() => expect(container.querySelector("[data-testid=drawn]")).not.toBeNull());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.source).toBe("A -> B");
    expect(calls[0]?.info.block.id).toBe("b0000000000001");
    expect(calls[0]?.info.page.name).toBe("Zahrada");
    expect(calls[0]?.info.editing).toBe(false);
  });

  it("re-renders a fence painted before its renderer registered — plugins activate after first paint", async () => {
    const { container } = renderFenceInRow("```demo\nA -> B\n```");
    expect(container.querySelector(".vr-plugin-fence")).toBeNull();
    expect(container.querySelector("pre.vr-fence")?.textContent).toBe("A -> B");

    disposers.push(registerFenceRenderer("demo", { html: () => "<em>late</em>" }));

    await waitFor(() =>
      expect(container.querySelector(".vr-plugin-fence em")?.textContent).toBe("late"),
    );
  });

  it("goes back to a plain code fence when the renderer is disposed", async () => {
    const dispose = registerFenceRenderer("demo", { html: () => "<em>drawn</em>" });
    const { container } = renderFenceInRow("```demo\nA -> B\n```");
    await waitFor(() => expect(container.querySelector(".vr-plugin-fence em")).not.toBeNull());

    dispose();

    await waitFor(() => expect(container.querySelector(".vr-plugin-fence")).toBeNull());
    expect(container.querySelector("pre.vr-fence")?.textContent).toBe("A -> B");
  });

  it("shows what a throwing renderer said instead of a blank block", async () => {
    disposers.push(
      registerFenceRenderer("demo", {
        render() {
          throw new Error("Parse error on line 1");
        },
      }),
    );
    const { container } = renderFenceInRow("```demo\n???\n```");
    await waitFor(() =>
      expect(container.querySelector("[role=alert]")?.textContent).toBe(
        "demo: Parse error on line 1",
      ),
    );
    expect(container.querySelector("pre.vr-fence")?.textContent).toBe("???");
  });

  it("refuses a second renderer for the same language and the core `query` fence", () => {
    disposers.push(registerFenceRenderer("demo", { html: () => "" }));
    expect(() => registerFenceRenderer("DEMO", { html: () => "" })).toThrow(/already registered/);
    expect(() => registerFenceRenderer("query", { html: () => "" })).toThrow(/nooklet itself/);
  });
});
