import { describe, expect, it } from "vitest";
import { type ChunkInfo, lazyOnlyChunks } from "./lazy-only-chunks.js";

function chunk(fileName: string, over: Partial<ChunkInfo> = {}): ChunkInfo {
  return {
    fileName,
    isEntry: false,
    isDynamicEntry: false,
    facadeModuleId: null,
    imports: [],
    dynamicImports: [],
    ...over,
  };
}

const isMermaid = (c: ChunkInfo) =>
  /[\\/]node_modules[\\/]mermaid[\\/]/.test(c.facadeModuleId ?? "");

describe("lazyOnlyChunks", () => {
  // The shape of the real build: the app entry dynamically imports mermaid.core, which imports a
  // shared chunk the app also uses, and dynamically imports diagram chunks, which dynamically
  // import layout engines from other packages (cytoscape) — those must go too.
  const chunks = [
    chunk("static/index.js", {
      isEntry: true,
      imports: ["static/shared.js"],
      dynamicImports: ["static/mermaid.core.js", "static/settings.js"],
    }),
    chunk("static/settings.js", { isDynamicEntry: true, facadeModuleId: "/app/src/settings.tsx" }),
    chunk("static/shared.js"),
    chunk("static/mermaid.core.js", {
      isDynamicEntry: true,
      facadeModuleId: "/r/node_modules/.pnpm/mermaid@12/node_modules/mermaid/dist/mermaid.core.mjs",
      imports: ["static/shared.js", "static/chunk-a.js"],
      dynamicImports: ["static/flowDiagram.js"],
    }),
    chunk("static/chunk-a.js"),
    chunk("static/flowDiagram.js", {
      isDynamicEntry: true,
      facadeModuleId: "/r/node_modules/mermaid/dist/chunks/flowDiagram.mjs",
      imports: ["static/chunk-a.js"],
      dynamicImports: ["static/cytoscape.js"],
    }),
    chunk("static/cytoscape.js", {
      isDynamicEntry: true,
      facadeModuleId: "/r/node_modules/cytoscape/dist/cytoscape.esm.mjs",
    }),
  ];

  it("excludes mermaid and everything only it reaches, keeps what the app reaches", () => {
    const { roots, lazyOnly } = lazyOnlyChunks(chunks, isMermaid);
    expect(roots.sort()).toEqual(["static/flowDiagram.js", "static/mermaid.core.js"]);
    expect([...lazyOnly].sort()).toEqual([
      "static/chunk-a.js",
      "static/cytoscape.js",
      "static/flowDiagram.js",
      "static/mermaid.core.js",
    ]);
  });

  it("keeps a chunk the app imports statically even when mermaid imports it too", () => {
    const { lazyOnly } = lazyOnlyChunks(chunks, isMermaid);
    expect(lazyOnly.has("static/shared.js")).toBe(false);
    expect(lazyOnly.has("static/settings.js")).toBe(false);
    expect(lazyOnly.has("static/index.js")).toBe(false);
  });

  it("finds no roots when the library is not in the build", () => {
    const { roots, lazyOnly } = lazyOnlyChunks([chunks[0] as ChunkInfo], isMermaid);
    expect(roots).toEqual([]);
    expect(lazyOnly.size).toBe(0);
  });
});
