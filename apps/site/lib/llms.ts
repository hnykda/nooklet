/**
 * `llms.txt` and `llms-full.txt`, following https://llmstxt.org: an H1, a one-paragraph
 * blockquote summary, then H2 sections of `- [title](url): note` links. Each linked URL is the
 * page's raw markdown twin (`<page>.md`), which is what an agent wants to fetch.
 */

import { allPages, type DocPage, pageUrl, REPO_URL, rawMarkdown, SITE_URL } from "./source.ts";

const SUMMARY =
  "nooklet is a local-first outliner in the spirit of Logseq. Notes are nested bullets with [[links]], #tags and tasks, stored in SQLite with a plain markdown mirror on your own disk. Every device keeps a full replica and syncs through a server you run, using an op log with hybrid logical clocks and per-field last-writer-wins. Agents can read and edit the graph over HTTP or MCP with scoped tokens.";

function linkLine(p: DocPage): string {
  const title =
    p.collection === "decisions" ? `ADR ${String(p.order).padStart(3, "0")}: ${p.title}` : p.title;
  const note = p.description ? `: ${p.description}` : "";
  return `- [${title}](${SITE_URL}${pageUrl(p)}.md)${note}`;
}

export function llmsTxt(): string {
  const { docs, decisions } = allPages();
  const parts = [
    "# nooklet",
    "",
    `> ${SUMMARY}`,
    "",
    "Every page below is plain markdown. The HTML version is the same URL without `.md`.",
    `Source code and issues: ${REPO_URL}`,
    "",
    "## Guide",
    "",
    ...docs.map(linkLine),
  ];
  if (decisions.length) {
    parts.push(
      "",
      "## Optional",
      "",
      "Design decisions (architecture decision records):",
      "",
      ...decisions.map(linkLine),
    );
  }
  parts.push("", `All of the above in one file: ${SITE_URL}/llms-full.txt`, "");
  return parts.join("\n");
}

export function llmsFullTxt(): string {
  const { docs, decisions } = allPages();
  const pages = [...docs, ...decisions].map(rawMarkdown);
  return [`# nooklet`, "", `> ${SUMMARY}`, "", ...pages.flatMap((p) => ["---", "", p])].join("\n");
}
