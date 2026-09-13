/**
 * The syntax-highlighting seam (`RenderCtx.highlightCode`'s default), wired in M7 (research/13
 * §4.2 item 9). Facade only: this module is in the main bundle and knows the language names and
 * a result cache; highlight.js itself and every grammar live in `./highlighter-impl.ts`, loaded
 * on the first fence that needs them, so a page with no code pays nothing (docs/research/14).
 *
 * highlight.js over shiki: no WASM/Oniguruma, no TextMate grammars (a few kB per language here
 * versus tens), synchronous once loaded — research/04-editor.md §4 named it the lighter fallback
 * for phones, and the bundle numbers in research/14 are why it is the default rather than the
 * fallback. Its output is escaped HTML with `hljs-*` spans and nothing else, which is what makes
 * `innerHTML` in `tokens.tsx` safe.
 */

/** Languages with a bundled grammar (each its own lazy chunk); `Object.keys` of the loader map
 * in `./highlighter-impl.ts`, duplicated here so the main bundle can answer "can I highlight
 * this?" without loading anything. `highlight.test.ts` asserts the two lists agree. */
export const HIGHLIGHT_LANGUAGES: readonly string[] = [
  "bash",
  "c",
  "clojure",
  "cpp",
  "csharp",
  "css",
  "dart",
  "diff",
  "dockerfile",
  "elixir",
  "go",
  "graphql",
  "haskell",
  "ini",
  "java",
  "javascript",
  "json",
  "kotlin",
  "latex",
  "lua",
  "makefile",
  "markdown",
  "nginx",
  "objectivec",
  "perl",
  "php",
  "powershell",
  "protobuf",
  "python",
  "r",
  "ruby",
  "rust",
  "scala",
  "scss",
  "shell",
  "sql",
  "swift",
  "typescript",
  "vim",
  "xml",
  "yaml",
];

const ALIASES: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  py3: "python",
  sh: "bash",
  zsh: "bash",
  console: "shell",
  yml: "yaml",
  md: "markdown",
  mkd: "markdown",
  html: "xml",
  xhtml: "xml",
  svg: "xml",
  rss: "xml",
  plist: "xml",
  "c++": "cpp",
  cc: "cpp",
  hpp: "cpp",
  h: "c",
  cs: "csharp",
  kt: "kotlin",
  kts: "kotlin",
  rb: "ruby",
  rs: "rust",
  golang: "go",
  docker: "dockerfile",
  toml: "ini",
  tex: "latex",
  objc: "objectivec",
  "objective-c": "objectivec",
  ps1: "powershell",
  pwsh: "powershell",
  proto: "protobuf",
  sass: "scss",
  pl: "perl",
  hs: "haskell",
  clj: "clojure",
  ex: "elixir",
  exs: "elixir",
  make: "makefile",
  mk: "makefile",
  gql: "graphql",
  postgres: "sql",
  postgresql: "sql",
  mysql: "sql",
  sqlite: "sql",
  patch: "diff",
};

const KNOWN = new Set(HIGHLIGHT_LANGUAGES);

/** Fence info string -> bundled grammar name, or `null` for plain text / unknown. The info
 * string may carry extra words (```js title="x") — only the first counts. */
export function resolveLanguage(lang: string): string | null {
  const first = lang.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (first === "") return null;
  const name = ALIASES[first] ?? first;
  return KNOWN.has(name) ? name : null;
}

/**
 * The `language-*` class for a fence's `<code>`: the info string's first word, reduced to the
 * characters a language name uses. Never the raw info string — a class attribute is a
 * space-separated list, so ```` ```js cmd-overlay ```` put the command palette's fixed,
 * full-screen `.cmd-overlay` on a block that any synced device or agent could write
 * (docs/BUGS.md B-138). `data-lang` may keep the raw string; an attribute value is inert.
 */
export function languageClass(lang: string): string {
  const first = lang.trim().split(/\s+/)[0] ?? "";
  return `language-${first.replace(/[^\w+-]/g, "")}`;
}

export function canHighlight(lang: string): boolean {
  return resolveLanguage(lang) !== null;
}

// A small LRU: the same fence re-renders whenever its row re-mounts (content-visibility, edit
// mode round trips), and highlighting a 200-line block is measurable work on a phone.
const CACHE_MAX = 300;
const cache = new Map<string, string>();

function cacheKey(code: string, lang: string): string {
  return `${lang}\u0000${code}`;
}

function remember(key: string, html: string): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, html);
}

/** Highlighted HTML if this exact fence was highlighted before (no I/O), else `null`. */
export function highlightSync(code: string, lang: string): string | null {
  const name = resolveLanguage(lang);
  if (name === null) return null;
  const key = cacheKey(code, name);
  const hit = cache.get(key);
  if (hit === undefined) return null;
  // Refresh recency.
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

let impl: Promise<typeof import("./highlighter-impl.js")> | undefined;

/** Highlighted HTML, loading the highlighter and the grammar on first use; `null` when the
 * language is not bundled (the caller shows plain text) or highlighting failed. */
export async function highlightCode(code: string, lang: string): Promise<string | null> {
  const name = resolveLanguage(lang);
  if (name === null) return null;
  const cached = highlightSync(code, name);
  if (cached !== null) return cached;
  try {
    if (!impl) impl = import("./highlighter-impl.js");
    const html = await (await impl).highlight(code, name);
    if (html !== null) remember(cacheKey(code, name), html);
    return html;
  } catch (err) {
    // A failed chunk load (offline before the PWA cached it) must not take the page down; the
    // fence simply stays plain and the next attempt retries the import.
    impl = undefined;
    console.warn("highlightCode: highlighter unavailable", err);
    return null;
  }
}

/** Test hook. */
export function _resetHighlightCache(): void {
  cache.clear();
}
