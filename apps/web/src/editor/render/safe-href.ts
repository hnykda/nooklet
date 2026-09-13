/**
 * Which link URLs may become a live `href` (B-268).
 *
 * A markdown link's URL is content: typed here, synced from another device, or written by an MCP
 * agent. `[me](javascript:…)` rendered as `<a href="javascript:…">`; headless Chromium opened
 * `about:blank` instead of running it (the `target="_blank"` saved it), but that is an engine
 * detail, and the desktop app is WKWebView.
 *
 * A denylist of the schemes that can run script or carry a document into the app, not an
 * allowlist of http/https/mailto. Every other scheme only hands the URL to the operating system,
 * and people who keep notes link to apps (`zotero://select/…`, `obsidian://`, `things:`); an
 * allowlist would silently break those. The danger is parsing, not the list, so the scheme is read
 * the way the URL standard reads it (https://url.spec.whatwg.org/#concept-basic-url-parser): leading
 * and trailing C0 controls and spaces stripped, every tab and newline removed anywhere, ASCII case
 * folded — `" JaVa\tscript:"` is `javascript:` to a browser, so it is here too.
 */

const BLOCKED_SCHEMES: ReadonlySet<string> = new Set([
  "javascript",
  "vbscript",
  "data",
  "blob",
  "filesystem",
]);

// biome-ignore lint/suspicious/noControlCharactersInRegex: the URL parser strips exactly these.
const EDGE_C0_OR_SPACE = /^[\u0000-\u0020]+|[\u0000-\u0020]+$/g;
const TAB_OR_NEWLINE = /[\t\n\r]/g;
const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/** False when `href` would run script or load a document in the app; true for anything else,
 * relative references included. */
export function isSafeHref(href: string): boolean {
  const normalized = href.replace(EDGE_C0_OR_SPACE, "").replace(TAB_OR_NEWLINE, "");
  const scheme = SCHEME.exec(normalized)?.[1];
  return scheme === undefined || !BLOCKED_SCHEMES.has(scheme.toLowerCase());
}

/** `href` itself when it is safe, otherwise `undefined` — which Solid renders as no `href` at all,
 * leaving the label as inert text. */
export function safeHref(href: string): string | undefined {
  return isSafeHref(href) ? href : undefined;
}
