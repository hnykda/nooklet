/**
 * Reads the documentation the site publishes, straight from the repository at build time.
 *
 * `docs/guide/*.md` is the single source for the user guide; the site never keeps its own copy.
 * A build fails if that folder is missing or empty. `docs/adr/*.md` is published as "Design
 * decisions".
 *
 * This module runs in two places: inside `next build`, and as plain Node type-stripped TypeScript
 * from `scripts/emit-raw.ts`. So it imports only `node:` built-ins and `yaml`, and uses
 * syntax that Node's type stripping accepts (no enums, no parameter properties).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { REPO_URL, SITE_URL } from "./links.ts";

export { REPO_URL, SITE_URL };

export type Collection = "docs" | "decisions";

export interface DocPage {
  collection: Collection;
  /** URL segment, e.g. `sync` for `/docs/sync`. */
  slug: string;
  /** Source file name, e.g. `02-sync.md`; used to rewrite links between pages. */
  file: string;
  /** Path relative to the repository root, for "edit on GitHub" links. */
  repoPath: string;
  title: string;
  description: string;
  order: number;
  /** Markdown body with the front matter (and, for ADRs, the leading `# ` title) removed. */
  body: string;
}

/** Walks up from the working directory to the folder holding `pnpm-workspace.yaml`. */
export function repoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const up = dirname(dir);
    if (up === dir)
      throw new Error("site: could not find the repository root (pnpm-workspace.yaml)");
    dir = up;
  }
}

export function guideDir(): string {
  const dir = join(repoRoot(), "docs", "guide");
  if (!existsSync(dir) || !readdirSync(dir).some((f) => f.endsWith(".md"))) {
    throw new Error(
      `site: no guide pages in ${dir}; the site renders docs/guide and has no fallback`,
    );
  }
  return dir;
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function splitFrontMatter(src: string): { data: Record<string, unknown>; body: string } {
  const m = FRONT_MATTER.exec(src);
  if (!m) return { data: {}, body: src };
  const data = parseYaml(m[1] ?? "") as unknown;
  return {
    data: data && typeof data === "object" ? (data as Record<string, unknown>) : {},
    body: src.slice(m[0].length),
  };
}

/** `02-sync.md` → `sync`. A numeric prefix only orders files on disk; it is not part of the URL. */
export function slugFromFile(file: string): string {
  return file
    .replace(/\.md$/, "")
    .replace(/^\d+[-_]/, "")
    .toLowerCase();
}

function firstParagraph(body: string): string {
  for (const block of body.split(/\n\s*\n/)) {
    const t = block.trim();
    if (!t || t.startsWith("#") || t.startsWith(">") || t.startsWith("```") || t.startsWith("|")) {
      continue;
    }
    const text = t
      .replace(/^[-*]\s+/, "")
      .replace(/\s+/g, " ")
      .replace(/[*_`]/g, "");
    return text.length > 200 ? `${text.slice(0, 197).replace(/\s+\S*$/, "")}…` : text;
  }
  return "";
}

function readGuide(): DocPage[] {
  const dir = guideDir();
  const root = repoRoot();
  const pages = readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md")
    .map((file): DocPage => {
      const { data, body: withH1 } = splitFrontMatter(readFileSync(join(dir, file), "utf8"));
      const h1 = /^\s*#\s+(.+)\n/.exec(withH1);
      const title = typeof data.title === "string" ? data.title : (h1?.[1] ?? slugFromFile(file));
      // Guide files open with "# Title" so they read well on GitHub; the page header already
      // shows the title, so a leading H1 is dropped rather than rendered twice.
      const body = h1 ? withH1.slice(h1[0].length) : withH1;
      return {
        collection: "docs",
        slug: slugFromFile(file),
        file,
        repoPath: resolve(dir, file).slice(root.length + 1),
        title,
        description: typeof data.description === "string" ? data.description : firstParagraph(body),
        order: typeof data.order === "number" ? data.order : Number.MAX_SAFE_INTEGER,
        body,
      };
    });
  return pages.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

function readDecisions(): DocPage[] {
  const root = repoRoot();
  const dir = join(root, "docs", "adr");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d+-.*\.md$/.test(f))
    .sort()
    .map((file): DocPage => {
      const src = readFileSync(join(dir, file), "utf8");
      const heading = /^#\s+(.+)$/m.exec(src);
      // "ADR 003: Sync = op log + …" → "Sync = op log + …"; the number is shown separately.
      const title = (heading?.[1] ?? file).replace(/^ADR\s*\d+\s*[:.-]\s*/i, "").trim();
      const body = heading ? src.replace(heading[0], "").trimStart() : src;
      const num = Number.parseInt(file, 10);
      return {
        collection: "decisions",
        slug: file.replace(/\.md$/, ""),
        file,
        repoPath: `docs/adr/${file}`,
        title,
        description: firstParagraph(body.replace(/^Date:.*$/m, "")),
        order: num,
        body,
      };
    });
}

let cache: { docs: DocPage[]; decisions: DocPage[] } | undefined;

/** All published pages. Cached per process; a build reads the files once. */
export function allPages(): { docs: DocPage[]; decisions: DocPage[] } {
  if (process.env.NODE_ENV === "development") cache = undefined;
  cache ??= { docs: readGuide(), decisions: readDecisions() };
  return cache;
}

export function pageUrl(p: Pick<DocPage, "collection" | "slug">): string {
  return `/${p.collection}/${p.slug}`;
}

/**
 * Resolves a link written in a source markdown file to a site URL.
 *
 * Authors write links the way they work on GitHub: `02-sync.md`, `../adr/003-sync.md#why`. Links
 * to another published page become its site URL; any other repository-relative link points at the
 * file on GitHub, so nothing renders as a dead relative path. Absolute URLs pass through.
 */
export function resolveLink(href: string, from: DocPage): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("/")) {
    return href;
  }
  const [path = "", hash] = href.split("#", 2);
  const fromDir = from.repoPath.split("/").slice(0, -1).join("/");
  const target = join(fromDir, path).replaceAll("\\", "/");
  const anchor = hash ? `#${hash}` : "";
  const { docs, decisions } = allPages();
  for (const p of [...docs, ...decisions]) {
    if (p.repoPath === target) return `${pageUrl(p)}${anchor}`;
  }
  // A bare file name ("02-sync.md") still finds the page whose slug it names.
  if (from.collection === "docs" && !path.includes("/")) {
    const hit = docs.find((p) => p.slug === slugFromFile(path));
    if (hit) return `${pageUrl(hit)}${anchor}`;
  }
  if (target.startsWith("..")) return href;
  return `${REPO_URL}/blob/main/${target}${anchor}`;
}

/**
 * The page as standalone markdown for `<page>.md` and `llms-full.txt`: title and summary on top,
 * links made absolute so the text still works once it has left the site.
 */
export function rawMarkdown(p: DocPage): string {
  const body = p.body.replace(/(\]\()([^)\s]+)(\))/g, (_m, open: string, href: string, close) => {
    const r = resolveLink(href, p);
    return `${open}${r.startsWith("/") ? SITE_URL + r : r}${close}`;
  });
  const head =
    p.collection === "decisions"
      ? `# ADR ${String(p.order).padStart(3, "0")}: ${p.title}`
      : `# ${p.title}`;
  const summary = p.description ? `\n\n> ${p.description}` : "";
  return `${head}${summary}\n\nSource: ${SITE_URL}${pageUrl(p)}\n\n${body.trim()}\n`;
}
