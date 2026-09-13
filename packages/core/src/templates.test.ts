import { describe, expect, it } from "vitest";
import { makeOp, type Op, type OpPayload } from "./ops.js";
import {
  copiedProperties,
  countTemplateNodes,
  expandTemplateTokens,
  isTruthyProp,
  type TemplateNode,
  templateInsertOps,
  templateRoots,
} from "./templates.js";

const expansion = {
  day: 20260912,
  dateFormat: "MMM do, yyyy",
  now: new Date(2026, 8, 12, 9, 5),
  pageName: "Projects/Nooklet",
};

function node(content: string, extra: Partial<TemplateNode> = {}): TemplateNode {
  return {
    content,
    marker: null,
    priority: null,
    collapsed: false,
    properties: {},
    children: [],
    ...extra,
  };
}

let hlc = 0;
const mint = (entity: string, payload: OpPayload): Op =>
  makeOp(`${String(++hlc).padStart(13, "0")}-0000-dev`, "dev", entity, payload);

describe("expandTemplateTokens", () => {
  it("expands the date tokens as links in the given format, relative to the given day", () => {
    expect(expandTemplateTokens("Plan for <% today %>", expansion)).toBe(
      "Plan for [[Sep 12th, 2026]]",
    );
    expect(expandTemplateTokens("<% yesterday %> / <% tomorrow %>", expansion)).toBe(
      "[[Sep 11th, 2026]] / [[Sep 13th, 2026]]",
    );
    // The reader's format, not a fixed one (ADR 018): ISO in, ISO out.
    expect(expandTemplateTokens("<% today %>", { ...expansion, dateFormat: "yyyy-MM-dd" })).toBe(
      "[[2026-09-12]]",
    );
    // Month boundaries go through a real calendar, not arithmetic on the integer.
    expect(expandTemplateTokens("<% tomorrow %>", { ...expansion, day: 20260930 })).toBe(
      "[[Oct 1st, 2026]]",
    );
  });

  it("expands time and current page, tolerating spacing and case", () => {
    expect(expandTemplateTokens("at <%time%>", expansion)).toBe("at 09:05");
    expect(expandTemplateTokens("<%   TODAY   %>", expansion)).toBe("[[Sep 12th, 2026]]");
    expect(expandTemplateTokens("on <% current page %>", expansion)).toBe(
      "on [[Projects/Nooklet]]",
    );
    expect(
      expandTemplateTokens("on <% current page %>", { ...expansion, pageName: undefined }),
    ).toBe("on ");
  });

  it("leaves a token it does not understand in place, and text without tokens alone", () => {
    expect(expandTemplateTokens("<% next friday %>", expansion)).toBe("<% next friday %>");
    expect(expandTemplateTokens("a <%% b", expansion)).toBe("a <%% b");
    expect(expandTemplateTokens("plain text", expansion)).toBe("plain text");
  });
});

describe("templateRoots / copiedProperties / isTruthyProp", () => {
  it("inserts the block itself unless template-including-parent says otherwise", () => {
    const root = node("Daily", { properties: { template: "daily" }, children: [node("a")] });
    expect(templateRoots(root)).toEqual([root]);
    root.properties["template-including-parent"] = "true";
    expect(templateRoots(root)).toEqual([root]);
    root.properties["template-including-parent"] = "false";
    expect(templateRoots(root)).toEqual(root.children);
  });

  // B-265: the owner's imported "Meeting" template is `collapsed:: true` in the library — folded
  // there to keep the library tidy — and every copy arrived folded, showing one empty bullet.
  it("hands back the inserted nodes expanded, and leaves folds below them alone", () => {
    const folded = node("folded inside", { collapsed: true, children: [node("hidden")] });
    const root = node("", {
      properties: { template: "Meeting", type: "meeting" },
      collapsed: true,
      children: [node("Agenda:"), folded],
    });
    const [copy] = templateRoots(root);
    expect(copy?.collapsed).toBe(false);
    expect(copy?.children[1]?.collapsed).toBe(true);
    expect(root.collapsed).toBe(true); // the template itself is not touched

    const childrenOnly = node("", {
      properties: { template: "m", "template-including-parent": "false" },
      children: [folded],
    });
    expect(templateRoots(childrenOnly).map((n) => n.collapsed)).toEqual([false]);
    expect(folded.collapsed).toBe(true);
  });

  it("drops only the template-describing keys", () => {
    expect(
      copiedProperties({
        template: "daily",
        "journal-template": "true",
        "template-including-parent": "false",
        tags: "review",
        scheduled: "2026-09-13",
      }),
    ).toEqual({ tags: "review", scheduled: "2026-09-13" });
  });

  it("reads the wire convention for booleans", () => {
    expect(isTruthyProp("true")).toBe(true);
    expect(isTruthyProp("yes")).toBe(true);
    expect(isTruthyProp("false")).toBe(false);
    expect(isTruthyProp("FALSE")).toBe(false);
    expect(isTruthyProp("")).toBe(false);
    expect(isTruthyProp(null)).toBe(false);
    expect(isTruthyProp(undefined)).toBe(false);
  });
});

describe("templateInsertOps", () => {
  const template: TemplateNode = node("Daily plan for <% today %>", {
    properties: { template: "daily", "journal-template": "true", tags: "daily" },
    collapsed: true,
    children: [
      node("Gratitude", { children: [node("one"), node("two")] }),
      node("plan the day at <% time %>", { marker: "TODO", priority: "A" }),
    ],
  });

  it("copies the subtree with fresh ids, expanded text and the template keys dropped", () => {
    const { ops, roots } = templateInsertOps(
      template,
      { pageId: "page1", parentId: null, lower: "a0", upper: null },
      expansion,
      mint,
      1_700_000_000_000,
    );
    expect(ops).toHaveLength(countTemplateNodes([template]));
    expect(ops.every((op) => op.payload.kind === "block.create")).toBe(true);
    expect(new Set(ops.map((op) => op.entity)).size).toBe(5);

    const [rootOp, gratitude, one, two, todo] = ops as Array<
      Op & { payload: Extract<OpPayload, { kind: "block.create" }> }
    >;
    expect(roots).toEqual([{ id: rootOp?.entity, order: rootOp?.payload.place.order }]);
    expect(rootOp?.payload).toMatchObject({
      place: { pageId: "page1", parentId: null },
      content: "Daily plan for [[Sep 12th, 2026]]",
      // The template root is folded in the library; the copy is not (B-265).
      collapsed: false,
      properties: { tags: "daily" },
      createdAt: 1_700_000_000_000,
    });
    const orderOf = (op: (typeof ops)[number] | undefined): string =>
      op?.payload.kind === "block.create" ? op.payload.place.order : "";
    expect(orderOf(rootOp) > "a0").toBe(true);

    // Children hang off the NEW root id, grandchildren off the new child id, in order.
    expect(gratitude?.payload.place.parentId).toBe(rootOp?.entity);
    expect(todo?.payload.place.parentId).toBe(rootOp?.entity);
    expect(orderOf(gratitude) < orderOf(todo)).toBe(true);
    expect(one?.payload.place.parentId).toBe(gratitude?.entity);
    expect(two?.payload.place.parentId).toBe(gratitude?.entity);
    expect(todo?.payload).toMatchObject({
      marker: "TODO",
      priority: "A",
      content: "plan the day at 09:05",
    });
    // No empty bag: a node with nothing left after stripping carries no `properties` at all.
    expect("properties" in (gratitude?.payload ?? {})).toBe(false);
  });

  it("inserts only the children when template-including-parent is false, between the bounds", () => {
    const childrenOnly: TemplateNode = {
      ...template,
      properties: { ...template.properties, "template-including-parent": "false" },
    };
    const { ops, roots } = templateInsertOps(
      childrenOnly,
      { pageId: "page1", parentId: "parent9", lower: "a0", upper: "a1" },
      expansion,
      mint,
    );
    expect(roots).toHaveLength(2);
    expect(ops).toHaveLength(4);
    for (const r of roots) {
      expect(r.order > "a0" && r.order < "a1").toBe(true);
    }
    const tops = ops.filter(
      (op) => op.payload.kind === "block.create" && op.payload.place.parentId === "parent9",
    );
    expect(tops.map((op) => op.entity)).toEqual(roots.map((r) => r.id));
  });

  it("mints a different set of ids on every call", () => {
    const a = templateInsertOps(
      template,
      { pageId: "p", parentId: null, lower: null, upper: null },
      expansion,
      mint,
    );
    const b = templateInsertOps(
      template,
      { pageId: "p", parentId: null, lower: null, upper: null },
      expansion,
      mint,
    );
    const idsA = new Set(a.ops.map((op) => op.entity));
    expect(b.ops.some((op) => idsA.has(op.entity))).toBe(false);
  });
});
