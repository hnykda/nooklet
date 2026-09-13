// @vitest-environment jsdom
/**
 * One reference in the panel (B-550): the breadcrumb of its parents, the block rendered with its
 * children, and where clicks go. The replica read is `../data/reference-trees.test.ts`; the whole
 * panel against a real server is `e2e/tests/references-render.spec.ts`.
 */
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../data/block-ref-cache.js", () => ({ lookupBlockText: () => undefined }));

import type { BlockTreeNode } from "../data/types.js";
import { ReferenceBreadcrumb, ReferenceItem } from "./ReferenceItem.js";
import type { LoadedReferenceTrees } from "./referenceNesting.js";

afterEach(cleanup);

function node(
  id: string,
  content: string,
  children: BlockTreeNode[] = [],
  extra: Partial<BlockTreeNode> = {},
): BlockTreeNode {
  return {
    id,
    content,
    children,
    collapsed: false,
    marker: null,
    priority: null,
    pageId: "J",
    parentId: null,
    properties: {},
    ...extra,
  } as BlockTreeNode;
}

function trees(): LoadedReferenceTrees {
  const grand = node("grand", "grandchild");
  const child = node("child", "first child", [grand]);
  const ref = node("ref", "call about [[Target]]", [child], { marker: "TODO" });
  return {
    status: "ok",
    requested: new Set(["ref", "child", "grand", "top", "sibling"]),
    ancestors: new Map([
      ["ref", ["notes", "day"]],
      ["sibling", ["notes", "day"]],
      ["child", ["ref", "notes", "day"]],
      ["grand", ["child", "ref", "notes", "day"]],
      ["top", []],
    ]),
    nodes: new Map([
      ["ref", ref],
      ["child", child],
      ["grand", grand],
      ["top", node("top", "top level [[Target]]")],
      ["sibling", node("sibling", "sibling [[Target]]")],
    ]),
    ancestorText: new Map([
      ["day", "Meetings with [[Alice]]\nlong second line"],
      ["notes", "Project notes"],
    ]),
  };
}

function crumbs(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".reference-breadcrumb-item")].map(
    (el) => el.textContent ?? "",
  );
}

describe("ReferenceBreadcrumb", () => {
  it("shows the parents outermost first, one line each, separated", () => {
    const { container } = render(() => (
      <ReferenceBreadcrumb
        parents={[
          { id: "day", content: "Meetings with [[Alice]]\nlong second line" },
          { id: "notes", content: "Project notes" },
        ]}
        onNavigate={() => {}}
      />
    ));
    expect(crumbs(container)).toEqual(["Meetings with Alice", "Project notes"]);
    expect(container.querySelectorAll(".reference-breadcrumb-sep")).toHaveLength(1);
    expect(container.querySelector("nav")?.getAttribute("aria-label")).toBe("Parent blocks");
  });

  it("a step opens its block; a page link inside a step opens the page instead", () => {
    const onNavigate = vi.fn();
    const { container } = render(() => (
      <ReferenceBreadcrumb
        parents={[
          { id: "day", content: "Meetings with [[Alice]]" },
          { id: "notes", content: "Project notes" },
        ]}
        onNavigate={onNavigate}
      />
    ));
    const [day, notes] = [...container.querySelectorAll<HTMLElement>(".reference-breadcrumb-item")];
    fireEvent.click(notes as HTMLElement);
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "block", id: "notes" });

    fireEvent.keyDown(day as HTMLElement, { key: "Enter" });
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "block", id: "day" });

    onNavigate.mockClear();
    fireEvent.click(day?.querySelector("a") as HTMLElement);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith({ kind: "page", name: "Alice" });
  });

  it("a heading, a fence or an empty parent still reads as a step with text (B-552)", () => {
    // The inline renderer draws nothing for a heading line or a fence's opening line — they are
    // block-level — so a step built from the parent's first line as written came out empty.
    const { container } = render(() => (
      <ReferenceBreadcrumb
        parents={[
          { id: "articles", content: "## 🔖 Articles" },
          { id: "code", content: "```js\nconst answer = 42;\n```" },
          { id: "blank", content: "" },
          { id: "linked", content: "### [[Alice]] notes" },
        ]}
        onNavigate={() => {}}
      />
    ));
    expect(crumbs(container)).toEqual([
      "🔖 Articles",
      "const answer = 42;",
      "(empty)",
      "Alice notes",
    ]);
  });

  it("renders nothing for a top-level block", () => {
    const { container } = render(() => <ReferenceBreadcrumb parents={[]} onNavigate={() => {}} />);
    expect(container.querySelector(".reference-breadcrumb")).toBeNull();
  });
});

describe("ReferenceItem", () => {
  it("a nested reference: breadcrumb, then the block with its children, read-only", () => {
    const t = trees();
    const { container } = render(() => (
      <ReferenceItem id="ref" text="call about" trees={() => t} onNavigate={() => {}} />
    ));
    expect(crumbs(container)).toEqual(["Meetings with Alice", "Project notes"]);
    const rows = [...container.querySelectorAll<HTMLElement>(".vr-embed-item")];
    expect(rows.map((r) => r.dataset.embedBlockId)).toEqual(["ref", "child", "grand"]);
    expect(rows.map((r) => r.style.getPropertyValue("--depth"))).toEqual(["0", "1", "2"]);
    expect(rows[0]?.querySelector(".vr-marker-TODO")).not.toBeNull();
    expect(container.querySelector("[contenteditable], textarea")).toBeNull();
    // Not the fallback line.
    expect(container.querySelector(".reference-item-jump")).toBeNull();
  });

  it("a top-level reference has no breadcrumb", () => {
    const t = trees();
    const { container } = render(() => (
      <ReferenceItem id="top" text="top level" trees={() => t} onNavigate={() => {}} />
    ));
    expect(container.querySelector(".reference-breadcrumb")).toBeNull();
    expect(container.querySelectorAll(".vr-embed-item")).toHaveLength(1);
  });

  it("the breadcrumb is left out when the row above has the same parents", () => {
    const t = trees();
    const { container } = render(() => (
      <ul>
        <ReferenceItem id="ref" text="" trees={() => t} onNavigate={() => {}} />
        <ReferenceItem
          id="sibling"
          previousId="ref"
          text=""
          trees={() => t}
          onNavigate={() => {}}
        />
        <ReferenceItem
          id="child"
          previousId="sibling"
          text=""
          trees={() => t}
          onNavigate={() => {}}
        />
      </ul>
    ));
    const items = [...container.querySelectorAll<HTMLElement>(".reference-item")];
    expect(items.map((li) => li.querySelectorAll(".reference-breadcrumb").length)).toEqual([
      1, 0, 1,
    ]);
  });

  it("a child row opens that child; the toggle folds here without navigating", () => {
    const onNavigate = vi.fn();
    const t = trees();
    const { container } = render(() => (
      <ReferenceItem id="ref" text="" trees={() => t} onNavigate={onNavigate} />
    ));
    const row = (id: string) =>
      container.querySelector<HTMLElement>(`[data-embed-block-id="${id}"] .vr-embed-row`);
    fireEvent.click(row("grand") as HTMLElement);
    expect(onNavigate).toHaveBeenCalledWith({ kind: "block", id: "grand" });

    onNavigate.mockClear();
    fireEvent.click(
      container.querySelector(`[data-embed-block-id="child"] .vr-embed-toggle`) as HTMLElement,
    );
    expect(onNavigate).not.toHaveBeenCalled();
    expect(container.querySelector('[data-embed-block-id="grand"]')).toBeNull();
    expect(t.nodes.get("child")?.collapsed).toBe(false);
  });

  it("falls back to the server's first line when the replica does not have the block", () => {
    const onNavigate = vi.fn();
    const { container } = render(() => (
      <ReferenceItem
        id="unsynced"
        text="first line from [[Target]]"
        trees={() => trees()}
        onNavigate={onNavigate}
      />
    ));
    const jump = container.querySelector<HTMLElement>(".reference-item-jump");
    expect(jump?.textContent).toBe("first line from Target");
    fireEvent.click(jump as HTMLElement);
    expect(onNavigate).toHaveBeenCalledWith({ kind: "block", id: "unsynced" });
  });
});
