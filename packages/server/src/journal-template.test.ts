/**
 * ADR 019, the server's half of the journal template: a day created for an API caller
 * (`page_append` to a date that has no page yet, `pages.journal(..., {create: true})`) starts
 * with the template's blocks, copied with fresh ids and expanded tokens, before whatever the
 * caller appends.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createServerContext, type ServerContext } from "./apply-ops.js";
import { createDataApi, type DataApi } from "./data-api.js";
import { openDb } from "./db.js";
import { setSuggestedJournalTitleFormat } from "./journal-format.js";
import { journalTemplateId, journalTemplateNode, loadTemplateNode } from "./journal-template.js";

let ctx: ServerContext;
let data: DataApi;

beforeEach(() => {
  ctx = createServerContext(openDb({ path: ":memory:" }));
  data = createDataApi(ctx, { origin: "api", actor: "test" });
});

async function seedTemplate(extra: Record<string, string> = {}): Promise<string> {
  const page = await data.pages.create({ name: "Templates" });
  const root = await data.blocks.insert({
    page: page.id,
    content: "Daily plan for <% today %>",
    properties: { template: "daily", ...extra },
  });
  const gratitude = await data.blocks.insert({ parent: root.id, content: "Gratitude" });
  await data.blocks.insert({ parent: gratitude.id, content: "one" });
  // `blocks.insert` takes content as-is (a leading `TODO ` is only parsed from Markdown by the
  // outline parser), and a `marker` in a `block.create` properties bag is dropped by the reducer
  // (B-89), so the marker is set the way `block_update` sets it: a `block.prop` op.
  const todo = await data.blocks.insert({ parent: root.id, content: "plan the day at <% time %>" });
  await data.blocks.update(todo.id, { properties: { marker: "TODO" } });
  return root.id;
}

describe("journalTemplateId / loadTemplateNode", () => {
  it("finds the block marked journal-template and loads its subtree", async () => {
    const rootId = await seedTemplate({ "journal-template": "true" });
    expect(journalTemplateId(ctx.driver)).toBe(rootId);
    const node = loadTemplateNode(ctx.driver, rootId);
    expect(node?.content).toBe("Daily plan for <% today %>");
    expect(node?.properties).toEqual({ template: "daily", "journal-template": "true" });
    expect(node?.children.map((c) => c.content)).toEqual([
      "Gratitude",
      "plan the day at <% time %>",
    ]);
    expect(node?.children[1]?.marker).toBe("TODO");
    expect(node?.children[0]?.children.map((c) => c.content)).toEqual(["one"]);
  });

  it("is null with no journal template, or one switched off, or one deleted", async () => {
    expect(journalTemplateNode(ctx.driver)).toBeNull();
    const rootId = await seedTemplate({ "journal-template": "false" });
    expect(journalTemplateId(ctx.driver)).toBeNull();
    await data.blocks.update(rootId, { properties: { "journal-template": "true" } });
    expect(journalTemplateId(ctx.driver)).toBe(rootId);
    await data.blocks.delete(rootId);
    expect(journalTemplateId(ctx.driver)).toBeNull();
    expect(loadTemplateNode(ctx.driver, rootId)).toBeNull();
  });
});

describe("PagesApi.journal with a journal template", () => {
  it("creates the day with the template's blocks, fresh ids, tokens expanded, template keys dropped", async () => {
    const rootId = await seedTemplate({ "journal-template": "true" });
    const day = await data.pages.journal("2030-01-15", { create: true });
    expect(day?.journalDay).toBe(20300115);
    const tree = await data.blocks.tree({ page: day?.id as string });
    expect(tree.map((n) => n.content)).toEqual(["Daily plan for [[Jan 15th, 2030]]"]);
    const root = tree[0];
    expect(root?.id).not.toBe(rootId);
    expect(root?.properties).toEqual({});
    expect(root?.children.map((c) => c.content)).toEqual([
      "Gratitude",
      expect.stringMatching(/^plan the day at \d{2}:\d{2}$/),
    ]);
    expect(root?.children[1]?.marker).toBe("TODO");
    expect(root?.children[0]?.children.map((c) => c.content)).toEqual(["one"]);

    // The template itself is untouched.
    const original = await data.blocks.tree(rootId);
    expect(original[0]?.content).toBe("Daily plan for <% today %>");
    expect(original[0]?.properties.template).toBe("daily");
  });

  it("writes the date tokens in the graph's own title format when it has one", async () => {
    await seedTemplate({ "journal-template": "true" });
    setSuggestedJournalTitleFormat(ctx.driver, "EEEE, dd.MM.yyyy");
    const day = await data.pages.journal("2030-01-15", { create: true });
    const tree = await data.blocks.tree({ page: day?.id as string });
    expect(tree[0]?.content).toBe("Daily plan for [[Tuesday, 15.01.2030]]");
  });

  it("honours template-including-parent:: false and leaves an existing day alone", async () => {
    await seedTemplate({ "journal-template": "true", "template-including-parent": "false" });
    const day = await data.pages.journal("2030-01-16", { create: true });
    const tree = await data.blocks.tree({ page: day?.id as string });
    expect(tree.map((n) => n.content)).toEqual([
      "Gratitude",
      expect.stringMatching(/^plan the day at \d{2}:\d{2}$/),
    ]);
    // A second create for the same day returns the page and adds nothing.
    const again = await data.pages.journal("2030-01-16", { create: true });
    expect(again?.id).toBe(day?.id);
    expect((await data.blocks.tree({ page: day?.id as string })).length).toBe(2);
  });

  it("creates a plain empty day when no journal template is chosen", async () => {
    await seedTemplate();
    const day = await data.pages.journal("2030-01-17", { create: true });
    expect(await data.blocks.tree({ page: day?.id as string })).toEqual([]);
  });
});
