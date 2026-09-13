/**
 * `graph.replace` awaits its scan worker (B-125), so a sync push can land between the scan and the
 * write. Its own file because it wraps `runScan` with `vi.mock`, which applies module-wide.
 */
import { Hlc, makeOp } from "@nooklet/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSyncTestServer, type SyncTestServer } from "../sync/sync-test-helpers.js";
import { post } from "../test-helpers.js";

const hook = vi.hoisted(() => ({ afterScan: undefined as undefined | (() => Promise<void>) }));

vi.mock("./replace-scan.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./replace-scan.js")>();
  return {
    ...mod,
    runScan: async (...args: Parameters<typeof mod.runScan>) => {
      const result = await mod.runScan(...args);
      await hook.afterScan?.();
      return result;
    },
  };
});

let s: SyncTestServer;
beforeEach(() => {
  s = makeSyncTestServer();
  hook.afterScan = undefined;
});

function contentOf(id: string): string | undefined {
  return s.serverCtx.driver.get<{ content: string }>("SELECT content FROM block WHERE id = ?", [id])
    ?.content;
}

describe("graph.replace racing a sync push (B-125)", () => {
  it("refuses with conflict, writing nothing, when a matched block changed during the scan", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Race",
      markdown: "- the colour of money\n- colour again",
    });
    const blocks = s.serverCtx.driver.all<{ id: string; content: string }>(
      "SELECT id, content FROM block WHERE deleted_at IS NULL ORDER BY content DESC",
    );
    const edited = blocks[0] as { id: string; content: string };
    const untouched = blocks[1] as { id: string; content: string };
    expect(edited.content).toBe("the colour of money");

    // A device edits the block after the scan read it and before graph.replace writes.
    hook.afterScan = async () => {
      const op = makeOp(new Hlc("aaaaaaaa").next(), "aaaaaaaa", edited.id, {
        kind: "block.text",
        content: "the colour of money, edited on the phone",
      });
      const push = await post(s.app, "/sync/push", s.syncToken, {
        device_id: "aaaaaaaa",
        ops: [op],
      });
      expect(push.status).toBe(200);
      expect(push.json.rejected).toEqual([]);
    };

    const { status, json } = await post(s.app, "/api/v1/graph.replace", s.writeToken, {
      query: "colour",
      replacement: "color",
    });
    expect(status).toBe(409);
    expect(json.error.code).toBe("conflict");
    expect(json.error.details.block_ids).toEqual([edited.id]);
    // The phone's edit survives and the other block was not half-replaced either.
    expect(contentOf(edited.id)).toBe("the colour of money, edited on the phone");
    expect(contentOf(untouched.id)).toBe("colour again");

    // Run again with nothing racing: both blocks change.
    hook.afterScan = undefined;
    const again = await post(s.app, "/api/v1/graph.replace", s.writeToken, {
      query: "colour",
      replacement: "color",
    });
    expect(again.status).toBe(200);
    expect(contentOf(edited.id)).toBe("the color of money, edited on the phone");
    expect(contentOf(untouched.id)).toBe("color again");
  });
});
