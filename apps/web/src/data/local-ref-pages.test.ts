import type { Op } from "@nooklet/core";
import { describe, expect, it, vi } from "vitest";
import { namesReferencedByOps, planLocalReferencedPages } from "./local-ref-pages.js";

function textOp(content: string): Op {
  return {
    id: `id-${content}`,
    hlc: "hlc",
    device: "dev",
    entity: "block-1",
    payload: { kind: "block.text", content },
  };
}

function createOp(content: string, marker: string | null = null): Op {
  return {
    id: `id-${content}`,
    hlc: "hlc",
    device: "dev",
    entity: "block-1",
    payload: {
      kind: "block.create",
      place: { pageId: "page-1", parentId: null, order: "a0" },
      content,
      marker: marker as never,
      createdAt: 0,
    },
  };
}

describe("namesReferencedByOps", () => {
  it("extracts page refs and tags from block.text", () => {
    expect(namesReferencedByOps([textOp("see [[Some Page]] and #atag")])).toEqual([
      "Some Page",
      "atag",
    ]);
  });

  it("extracts refs and the Task tag from a marked block.create", () => {
    expect(namesReferencedByOps([createOp("do [[Something]]", "TODO")])).toEqual([
      "Something",
      "Task",
    ]);
  });

  it("ignores block.create with no marker and content with no refs", () => {
    expect(namesReferencedByOps([createOp("plain text")])).toEqual([]);
  });

  it("is empty for ops with no block.text/block.create payload", () => {
    const op: Op = {
      id: "x",
      hlc: "h",
      device: "d",
      entity: "page-1",
      payload: { kind: "page.rename", name: "x" },
    };
    expect(namesReferencedByOps([op])).toEqual([]);
  });
});

describe("planLocalReferencedPages", () => {
  it("returns [] fast when nothing is referenced — pageExists/mint never called", async () => {
    const pageExists = vi.fn();
    const mint = vi.fn();
    const result = await planLocalReferencedPages([createOp("plain text")], pageExists, mint);
    expect(result).toEqual([]);
    expect(pageExists).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
  });

  it("mints a page.create for a reference that does not exist locally", async () => {
    const pageExists = vi.fn().mockResolvedValue(false);
    const mint = vi.fn(async (name: string) => ({
      id: `new-${name}`,
      hlc: "h",
      device: "d",
      entity: `page-for-${name}`,
      payload: { kind: "page.create" as const, name, journalDay: null, createdAt: 0 },
    }));
    const result = await planLocalReferencedPages([textOp("see [[New Page]]")], pageExists, mint);
    expect(result).toHaveLength(1);
    expect(mint).toHaveBeenCalledWith("New Page");
  });

  it("does not mint anything for a reference that already resolves locally", async () => {
    const pageExists = vi.fn().mockResolvedValue(true);
    const mint = vi.fn();
    const result = await planLocalReferencedPages([textOp("see [[Existing]]")], pageExists, mint);
    expect(result).toEqual([]);
    expect(mint).not.toHaveBeenCalled();
  });

  it("mints missing namespace ancestors too, ancestors before the page", async () => {
    const existing = new Set<string>();
    const pageExists = vi.fn(async (key: string) => existing.has(key));
    const minted: string[] = [];
    const mint = vi.fn(async (name: string) => {
      minted.push(name);
      return {
        id: `new-${name}`,
        hlc: "h",
        device: "d",
        entity: `page-for-${name}`,
        payload: { kind: "page.create" as const, name, journalDay: null, createdAt: 0 },
      };
    });
    const result = await planLocalReferencedPages(
      [textOp("see [[Projects/Aurora/Launch]]")],
      pageExists,
      mint,
    );
    expect(result).toHaveLength(3);
    expect(minted).toEqual(["Projects", "Projects/Aurora", "Projects/Aurora/Launch"]);
  });

  it("mints a missing reference once even when named twice in the same batch", async () => {
    const pageExists = vi.fn().mockResolvedValue(false);
    const mint = vi.fn(async (name: string) => ({
      id: `new-${name}`,
      hlc: "h",
      device: "d",
      entity: `page-for-${name}`,
      payload: { kind: "page.create" as const, name, journalDay: null, createdAt: 0 },
    }));
    const result = await planLocalReferencedPages(
      [textOp("[[Repeat]]"), textOp("[[Repeat]] again")],
      pageExists,
      mint,
    );
    expect(result).toHaveLength(1);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("never mints a journal-day-looking name", async () => {
    const pageExists = vi.fn().mockResolvedValue(false);
    const mint = vi.fn();
    const result = await planLocalReferencedPages([textOp("see [[2026-09-15]]")], pageExists, mint);
    expect(result).toEqual([]);
    expect(mint).not.toHaveBeenCalled();
  });
});
