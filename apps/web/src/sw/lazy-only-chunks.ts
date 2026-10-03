/**
 * Build-time helper for `vite.config.ts` (not shipped in the client): which output chunks exist
 * ONLY to serve a lazily imported library, so the service worker need not precache them.
 *
 * mermaid is ~6 MB of chunks (its ELK and cytoscape layout engines, a second KaTeX, one chunk per
 * diagram type) that load on the first diagram, through the mermaid plugin's `import("mermaid")`.
 * Precaching them made every install download them (ADR 023 §Consequences). The chunks are not
 * nameable up front — most are `chunk-<hash>` or named after the diagram type — so they are found
 * in the module graph instead: everything reachable from the lazy library's dynamic-entry chunks
 * that the app cannot reach WITHOUT going through one of them. A chunk the app also imports
 * statically (a shared utility Rollup split out) stays precached.
 */

/** The parts of a Rollup `OutputChunk` this needs. */
export interface ChunkInfo {
  fileName: string;
  isEntry: boolean;
  isDynamicEntry: boolean;
  facadeModuleId: string | null;
  imports: readonly string[];
  dynamicImports: readonly string[];
}

/**
 * `isLazyRoot` picks the dynamic-entry chunks the excluded subgraph hangs from (for mermaid: those
 * whose facade module is inside the `mermaid` package). Returns the file names of chunks reachable
 * from a lazy root and unreachable from every entry when lazy roots are treated as walls.
 */
export function lazyOnlyChunks(
  chunks: readonly ChunkInfo[],
  isLazyRoot: (chunk: ChunkInfo) => boolean,
): { roots: string[]; lazyOnly: Set<string> } {
  const byName = new Map(chunks.map((c) => [c.fileName, c]));
  const roots = chunks.filter((c) => c.isDynamicEntry && isLazyRoot(c)).map((c) => c.fileName);
  const rootSet = new Set(roots);

  const walk = (start: Iterable<string>, stopAtRoots: boolean): Set<string> => {
    const seen = new Set<string>();
    const stack = [...start];
    while (stack.length > 0) {
      const name = stack.pop() as string;
      if (seen.has(name)) continue;
      if (stopAtRoots && rootSet.has(name)) continue;
      const chunk = byName.get(name);
      if (!chunk) continue; // an import of something that is not a chunk of this bundle
      seen.add(name);
      stack.push(...chunk.imports, ...chunk.dynamicImports);
    }
    return seen;
  };

  // What the app reaches without passing through a lazy root — including its OTHER dynamic
  // imports, which are not this helper's business and stay precached.
  const appReach = walk(
    chunks.filter((c) => c.isEntry).map((c) => c.fileName),
    true,
  );
  const lazyReach = walk(roots, false);
  const lazyOnly = new Set([...lazyReach].filter((name) => !appReach.has(name)));
  return { roots, lazyOnly };
}
