import { describe, expect, it } from "vitest";
import { blocksToOutline, outlineToBlocks } from "./blocks.js";
import { parseOutline } from "./outline.js";

describe("blocks", () => {
  it("flattens and rebuilds a tree preserving order and ids", () => {
    const tree = parseOutline(
      "- a\n  id:: 64f1a2b3-0000-4000-8000-000000000001\n\t- b\n\t- c\n- d\n",
    );
    const blocks = outlineToBlocks(tree.blocks, "page-1", { now: 1 });
    expect(blocks).toHaveLength(4);
    expect(blocks[0]?.id).toBe("64f1a2b3-0000-4000-8000-000000000001");
    expect(blocks[1]?.parentId).toBe(blocks[0]?.id);
    const shuffled = [...blocks].reverse();
    const rebuilt = blocksToOutline(shuffled, { includeIds: false });
    expect(rebuilt.map((n) => n.content)).toEqual(["a", "d"]);
    expect(rebuilt[0]?.children.map((n) => n.content)).toEqual(["b", "c"]);
  });
});
