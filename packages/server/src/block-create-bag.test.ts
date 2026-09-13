/**
 * B-89 through the path it was found on: a plugin/API caller putting a reserved key in the
 * `properties` bag of `data.blocks.insert`. The core reducer test (`packages/core/src/sync/
 * apply-ops.test.ts`, "…in the properties bag land in their columns (B-89)") pins the column
 * write; this one pins what the server derives from it — a marked block is a `#Task` (ADR 017's
 * sibling rule in `rebuildRefRows`), which a dropped marker silently was not.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createServerContext, type ServerContext } from "./apply-ops.js";
import { createDataApi, type DataApi } from "./data-api.js";
import { openDb } from "./db.js";

let ctx: ServerContext;
let data: DataApi;

beforeEach(() => {
  ctx = createServerContext(openDb({ path: ":memory:" }));
  data = createDataApi(ctx, { origin: "api", actor: "test" });
});

describe("blocks.insert with reserved keys in the properties bag (B-89)", () => {
  it("writes marker, priority and collapsed, and the block becomes a Task", async () => {
    const page = await data.pages.create({ name: "Inbox" });
    const block = await data.blocks.insert({
      page: page.id,
      content: "call the plumber",
      properties: { marker: "TODO", priority: "B", collapsed: "true", area: "home" },
    });

    expect(block.marker).toBe("TODO");
    expect(block.priority).toBe("B");
    expect(block.collapsed).toBe(true);
    expect(block.properties).toEqual({ area: "home" });

    const taskRef = ctx.driver.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM ref WHERE src_block_id = ? AND dst_page_key = 'task'",
      [block.id],
    );
    expect(taskRef?.n).toBe(1);
  });
});
