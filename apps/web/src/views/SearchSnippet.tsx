/**
 * Renders one search result's snippet.
 *
 * A snippet is NOT block markdown, even though it looks like it: the server's `search` op wraps
 * each matched term in `**` (see `packages/server/src/ops/search.ts`), a form chosen because it
 * reads naturally to an LLM consuming the same op over MCP. Passing that through the markdown
 * renderer (`InlineContent`) would be wrong in both directions — a match would render as bold
 * rather than a highlight, and a block whose real text contains `**bold**` would render as though
 * it were a match. So snippets get their own tiny renderer: `**…**` becomes `<mark>`, everything
 * else is plain text, and no other markdown is interpreted.
 *
 * The remaining ambiguity (real `**bold**` text inside a snippet reads as a highlight) is
 * accepted: a snippet is a lossy preview by nature, and the alternative — structured match
 * offsets on the wire — would complicate the MCP tool's output schema for little gain. If that
 * ever stops being true, `search`'s output gains a `highlights: [start, end][]` field and only
 * this file changes.
 */

import { For } from "solid-js";

const HIGHLIGHT = /\*\*([^*]+)\*\*/g;

interface Part {
  text: string;
  match: boolean;
}

export function splitSnippet(snippet: string): Part[] {
  const parts: Part[] = [];
  let last = 0;
  HIGHLIGHT.lastIndex = 0;
  let m: RegExpExecArray | null = HIGHLIGHT.exec(snippet);
  while (m !== null) {
    if (m.index > last) parts.push({ text: snippet.slice(last, m.index), match: false });
    parts.push({ text: m[1] as string, match: true });
    last = m.index + m[0].length;
    m = HIGHLIGHT.exec(snippet);
  }
  if (last < snippet.length) parts.push({ text: snippet.slice(last), match: false });
  return parts;
}

export function SearchSnippet(props: { snippet: string }) {
  const parts = () => splitSnippet(props.snippet);
  return (
    <For each={parts()}>{(p) => (p.match ? <mark>{p.text}</mark> : <span>{p.text}</span>)}</For>
  );
}
