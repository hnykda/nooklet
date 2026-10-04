/**
 * Which files of a Logseq graph folder or .zip the importer needs, and where each one goes
 * (ADR 030). Shared by the client, which uses it to pick what to upload out of a chosen folder, and
 * by the server, which uses it to decide what to unpack out of an uploaded zip — so the two can never
 * disagree about what "the graph" is.
 *
 * The importer (`packages/server/src/importer/logseq.ts`) reads exactly these: the top level of
 * `pages/` and `journals/` (markdown only), the top level of `assets/`, and `logseq/config.edn`.
 * `logseq/bak/`, `.recycle/`, `.git/`, `whiteboards/` and the rest are left out.
 */

export class LogseqArchiveError extends Error {}

const GRAPH_DIRS: readonly string[] = ["pages", "journals", "assets"];

/** One file-name component we are willing to create: no separators, not `.`/`..`, no NUL, not
 * hidden (Logseq never reads dotfiles, and `._name` is macOS resource-fork litter). */
export function safeArchiveFileName(name: string): boolean {
  if (name.length === 0 || new TextEncoder().encode(name).length > 255) return false;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  return !name.startsWith(".");
}

/**
 * Where the graph sits among `paths` (`/`-separated, relative). Zipping a folder in Finder or
 * Windows puts everything under `<folder>/`, and a browser folder pick names every file
 * `<folder>/...`; zipping its contents does neither. The root is the shallowest prefix that has a
 * `pages/` or `journals/` entry, or `logseq/config.edn`. Two different roots at that depth is two
 * graphs, which is refused rather than guessed.
 */
export function findLogseqRoot(paths: readonly string[]): string {
  const roots = new Set<string>();
  for (const path of paths) {
    if (path.startsWith("__MACOSX/")) continue;
    const m = /^((?:[^/]+\/)*?)(?:pages\/|journals\/|logseq\/config\.edn$)/.exec(path);
    if (m) roots.add(m[1] ?? "");
  }
  if (roots.size === 0) {
    throw new LogseqArchiveError(
      "no pages/ or journals/ folder was found, so this is not a Logseq graph",
    );
  }
  const depth = (p: string) => p.split("/").length;
  const shallowest = Math.min(...[...roots].map(depth));
  const candidates = [...roots].filter((r) => depth(r) === shallowest);
  if (candidates.length > 1) {
    throw new LogseqArchiveError(
      `this holds more than one graph (${candidates.map((c) => c || "/").join(", ")}); choose one graph folder`,
    );
  }
  return candidates[0] as string;
}

/** Where `path` goes inside the graph (`pages/x.md`, `logseq/config.edn`, ...), or `null` when the
 * importer does not read it. */
export function logseqArchiveTarget(path: string, root: string): string | null {
  if (!path.startsWith(root) || path.endsWith("/")) return null;
  const rest = path.slice(root.length);
  if (rest === "logseq/config.edn") return rest;
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  const dir = rest.slice(0, slash);
  const base = rest.slice(slash + 1);
  if (!GRAPH_DIRS.includes(dir)) return null;
  if (!safeArchiveFileName(base)) return null; // also rejects anything nested deeper
  if (dir !== "assets" && !base.toLowerCase().endsWith(".md")) return null;
  return `${dir}/${base}`;
}
