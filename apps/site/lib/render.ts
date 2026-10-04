/**
 * Markdown → HTML for the docs pages, at build time only (nothing here ships to the browser).
 *
 * The output is split into segments so the page can put live React components where a guide
 * author wrote an ```` ```animation-spec ```` fence: the sync animations are components, not
 * HTML strings, and they need their own play/pause state.
 */

import rehypeShikiFromHighlighter from "@shikijs/rehype/core";
import type { Element, ElementContent, Root as HastRoot } from "hast";
import { toString as hastToString } from "hast-util-to-string";
import type { Code, Html, Link, Root as MdastRoot } from "mdast";
import rehypeRaw from "rehype-raw";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { createCssVariablesTheme, createHighlighter, type Highlighter } from "shiki";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { parse as parseYaml } from "yaml";
import { type DocPage, resolveLink } from "./source.ts";

export interface TocItem {
  id: string;
  text: string;
  depth: 2 | 3;
}

export interface AnimationRef {
  /** One of the ids in `components/sync/registry.ts`, or an id the site does not draw yet. */
  id: string;
  caption: string;
}

export type Segment = { kind: "html"; html: string } | { kind: "animation"; anim: AnimationRef };

export interface SearchSection {
  /** `#anchor` within the page, or empty for the text before the first heading. */
  anchor: string;
  heading: string;
  text: string;
}

export interface RenderedPage {
  segments: Segment[];
  toc: TocItem[];
  sections: SearchSection[];
}

// The code colours are CSS variables, so the palette in globals.css (and its dark twin) decides
// them. Two fixed shiki themes would each carry their own idea of blue and fight the page.
const theme = createCssVariablesTheme({ name: "nooklet", variablePrefix: "--code-", fontStyle: true });

const LANGS = [
  "sh",
  "bash",
  "shellsession",
  "json",
  "jsonc",
  "ts",
  "tsx",
  "js",
  "yaml",
  "toml",
  "md",
  "sql",
  "diff",
  "html",
  "css",
  "ini",
  "dockerfile",
  "nginx",
] as const;

let highlighter: Promise<Highlighter> | undefined;
function getHighlighter(): Promise<Highlighter> {
  highlighter ??= createHighlighter({ themes: [theme], langs: [...LANGS] });
  return highlighter;
}

const ANIM_MARK = "nooklet-animation";

function parseSpec(value: string): AnimationRef {
  let data: unknown;
  try {
    data = parseYaml(value);
  } catch {
    data = undefined;
  }
  const rec = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const str = (...keys: string[]) => {
    for (const k of keys) {
      const v = rec[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };
  return {
    id: str("id", "name", "animation", "component"),
    caption: str("caption", "alt", "title", "description", "summary") || value.trim(),
  };
}

/** Replaces each ```` ```animation-spec ```` fence with a marker comment, collecting the specs. */
function remarkAnimationSpecs(found: AnimationRef[]) {
  return () => (tree: MdastRoot) => {
    visit(tree, "code", (node: Code, index, parent) => {
      if (node.lang !== "animation-spec" || !parent || index === undefined) return;
      const html: Html = { type: "html", value: `<!--${ANIM_MARK}:${found.length}-->` };
      found.push(parseSpec(node.value));
      parent.children.splice(index, 1, html);
    });
  };
}

function remarkLinks(page: DocPage) {
  return () => (tree: MdastRoot) => {
    visit(tree, "link", (node: Link) => {
      node.url = resolveLink(node.url, page);
    });
  };
}

/** Heading ids for the TOC, a hover anchor on each heading, and scrollable tables. */
function rehypeStructure(toc: TocItem[], sections: SearchSection[]) {
  return () => (tree: HastRoot) => {
    let current: SearchSection = { anchor: "", heading: "", text: "" };
    sections.push(current);
    for (const node of tree.children) {
      if (node.type !== "element") continue;
      if ((node.tagName === "h2" || node.tagName === "h3") && typeof node.properties.id === "string") {
        const id = node.properties.id;
        const text = hastToString(node).trim();
        toc.push({ id, text, depth: node.tagName === "h2" ? 2 : 3 });
        current = { anchor: id, heading: text, text: "" };
        sections.push(current);
        const anchor: Element = {
          type: "element",
          tagName: "a",
          properties: { className: ["heading-anchor"], href: `#${id}`, ariaLabel: `Link to “${text}”` },
          children: [{ type: "text", value: "#" }],
        };
        node.children.push(anchor);
      } else {
        current.text += ` ${hastToString(node)}`;
      }
    }
    visit(tree, "element", (node: Element, index, parent) => {
      if (node.tagName !== "table" || !parent || index === undefined) return;
      const wrap: Element = {
        type: "element",
        tagName: "div",
        properties: { className: ["table-wrap"], tabIndex: 0, role: "region", ariaLabel: "Table" },
        children: [node as ElementContent],
      };
      parent.children.splice(index, 1, wrap);
      return "skip";
    });
  };
}

export async function renderPage(page: DocPage): Promise<RenderedPage> {
  const anims: AnimationRef[] = [];
  const toc: TocItem[] = [];
  const sections: SearchSection[] = [];
  const hl = await getHighlighter();

  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkAnimationSpecs(anims))
    .use(remarkLinks(page))
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSlug)
    .use(rehypeShikiFromHighlighter, hl, {
      theme: "nooklet",
      fallbackLanguage: "text",
      defaultLanguage: "text",
      addLanguageClass: true,
    })
    .use(rehypeStructure(toc, sections))
    .use(rehypeStringify)
    .process(page.body);

  const html = String(file);
  const segments: Segment[] = [];
  const re = new RegExp(`<!--${ANIM_MARK}:(\\d+)-->`, "g");
  let last = 0;
  for (const m of html.matchAll(re)) {
    segments.push({ kind: "html", html: html.slice(last, m.index) });
    const anim = anims[Number(m[1])];
    if (anim) segments.push({ kind: "animation", anim });
    last = (m.index ?? 0) + m[0].length;
  }
  segments.push({ kind: "html", html: html.slice(last) });

  for (const s of sections) s.text = s.text.replace(/\s+/g, " ").trim();
  return {
    segments: segments.filter((s) => s.kind !== "html" || s.html.trim()),
    toc,
    sections: sections.filter((s) => s.text || s.heading),
  };
}
