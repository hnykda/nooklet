/**
 * `DataApi`'s two query methods that were stubs returning `[]` ("embeddings ship in M3") long
 * after M3 shipped — a plugin calling `ctx.data.query.semantic()` silently got nothing.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createServerContext, type ServerContext } from "./apply-ops.js";
import { createDataApi, type DataApi } from "./data-api.js";
import { openDb } from "./db.js";
import {
  activateModel,
  EmbeddingIndexer,
  FakeEmbeddingProvider,
  registerModel,
} from "./embeddings/index.js";

let ctx: ServerContext;
let data: DataApi;

beforeEach(() => {
  ctx = createServerContext(openDb({ path: ":memory:" }));
  data = createDataApi(ctx, { origin: "api", actor: "test" });
});

describe("PagesApi.create over a page a reference made (ADR 024)", () => {
  it("takes the empty page over — same id, the asked-for name and properties — instead of throwing", async () => {
    const notes = await data.pages.create({ name: "Notes" });
    await data.blocks.insert({ page: notes.id, content: "see [[plugin made]]" });
    const auto = await data.pages.get({ name: "plugin made" });
    expect(auto).not.toBeNull();

    const page = await data.pages.create({ name: "Plugin Made", properties: { type: "log" } });
    expect(page.id).toBe(auto?.id);
    expect(page.name).toBe("Plugin Made");
    expect(page.properties).toEqual({ type: "log" });
  });
});

describe("QueryApi.unlinkedRefs", () => {
  it("finds plain-text mentions on other pages that do not already link, aliases included", async () => {
    const target = await data.pages.create({
      name: "Zahrada",
      properties: { alias: "garden" },
    });
    const notes = await data.pages.create({ name: "Notes" });
    await data.blocks.insert({ page: notes.id, content: "the zahrada needs watering" }); // mention
    await data.blocks.insert({ page: notes.id, content: "see [[Zahrada]] for the plan" }); // linked
    await data.blocks.insert({ page: notes.id, content: "or [[garden]], same thing" }); // linked via alias
    await data.blocks.insert({ page: target.id, content: "Zahrada is its own page" }); // own page

    const groups = await data.query.unlinkedRefs(target.id);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.page.name).toBe("Notes");
    expect(groups[0]?.blocks.map((b) => b.content)).toEqual(["the zahrada needs watering"]);
  });

  it("is empty for a missing page or a name too short to be a mention", async () => {
    expect(await data.query.unlinkedRefs("nope")).toEqual([]);
    const tiny = await data.pages.create({ name: "Go" });
    const other = await data.pages.create({ name: "Other" });
    await data.blocks.insert({ page: other.id, content: "go go go" });
    expect(await data.query.unlinkedRefs(tiny.id)).toEqual([]);
  });
});

describe("QueryApi.semantic", () => {
  async function index(): Promise<void> {
    const model = registerModel(ctx.driver, { provider: "fake", model: "test-model", dims: 8 });
    activateModel(ctx.driver, model.id);
    await new EmbeddingIndexer({
      driver: ctx.driver,
      providerFor: (m) => new FakeEmbeddingProvider(8, m.model),
    }).drainUntilEmpty();
  }

  it("is empty, not an error, with no model active", async () => {
    const page = await data.pages.create({ name: "P" });
    await data.blocks.insert({ page: page.id, content: "anything" });
    expect(await data.query.semantic("anything")).toEqual([]);
  });

  it("returns indexed blocks with a 0..1 score, optionally scoped to one page", async () => {
    const a = await data.pages.create({ name: "A" });
    const b = await data.pages.create({ name: "B" });
    await data.blocks.insert({ page: a.id, content: "reconnect backoff for flaky wifi" });
    await data.blocks.insert({ page: b.id, content: "grocery list: oat milk, coffee" });
    await index();

    const all = await data.query.semantic("reconnect backoff", { limit: 5 });
    expect(all.length).toBeGreaterThan(0);
    for (const hit of all) {
      expect(hit.score).toBeGreaterThanOrEqual(0);
      expect(hit.score).toBeLessThanOrEqual(1);
      expect(typeof hit.block.content).toBe("string");
    }
    const onlyB = await data.query.semantic("reconnect backoff", { limit: 5, page: b.id });
    expect(onlyB.every((h) => h.block.pageId === b.id)).toBe(true);
  });
});
