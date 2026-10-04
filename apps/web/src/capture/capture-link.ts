/**
 * Proposal 006 Phase 1 (ADR 033): every phone entry point (a `nooklet://capture` link, a Home
 * Screen quick action, an Android share, the "Open nooklet to add" App Intent) arrives as one of
 * the links below and ends on the capture screen, pre-filled. Pure, so link parsing and the
 * text a capture becomes are unit-tested without a router or a native bridge
 * (`capture-link.test.ts`).
 *
 * Security: anything that can open a URL on the phone can craft `nooklet://capture?text=…`. So a
 * link only ever PRE-FILLS the capture screen; the person confirms with a tap (or edits first).
 * Nothing here writes. The one silent write path is the "Add to nooklet" App Intent, which iOS
 * runs only on the person's own action (Shortcuts, Siri, the Action Button), never from a link —
 * it goes through the native queue (`capture-queue.ts`), not through this module.
 */

/** What a capture was handed: free text, and/or a link with an optional page title. */
export interface CaptureFields {
  text?: string;
  url?: string;
  title?: string;
}

export type AppLink =
  | { kind: "capture"; fields: CaptureFields }
  | { kind: "today" }
  | { kind: "search" };

/** A link's fields are untrusted input that ends up in a textarea: cap them so a crafted link
 * cannot hand the page megabytes to lay out. Generous for anything a person shares. */
export const MAX_FIELD_CHARS = 100_000;

function clean(v: string | null | undefined): string | undefined {
  if (v === null || v === undefined) return undefined;
  const t = v.trim();
  if (t === "") return undefined;
  return t.length > MAX_FIELD_CHARS ? t.slice(0, MAX_FIELD_CHARS) : t;
}

/**
 * `nooklet://capture?text=…&url=…&title=…`, `nooklet://today`, `nooklet://search`. Returns
 * `undefined` for anything else (pairing links, other schemes), so several subscribers can share
 * one deep-link stream and each ignore what is not theirs.
 *
 * `new URL("nooklet://capture?…")` puts "capture" in `host`; `nooklet:///capture` and
 * `nooklet:capture` put it in `pathname`. All three are accepted: the link is typed by people
 * building Shortcuts by hand.
 */
export function parseAppLink(raw: string): AppLink | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.protocol !== "nooklet:") return undefined;
  const where = (u.host || u.pathname.replace(/^\/+/, "")).replace(/\/+$/, "").toLowerCase();
  switch (where) {
    case "capture": {
      const fields: CaptureFields = {};
      const text = clean(u.searchParams.get("text"));
      const url = clean(u.searchParams.get("url"));
      const title = clean(u.searchParams.get("title"));
      if (text !== undefined) fields.text = text;
      if (url !== undefined) fields.url = url;
      if (title !== undefined) fields.title = title;
      return { kind: "capture", fields };
    }
    case "today":
      return { kind: "today" };
    case "search":
      return { kind: "search" };
    default:
      return undefined;
  }
}

/** The app-relative path each link opens. `/capture` carries the fields as query params, the same
 * shape the PWA manifest's `share_target` already uses, so the web route is the one parser. */
export function appLinkPath(link: AppLink): string {
  switch (link.kind) {
    case "today":
      return "/journals";
    case "search":
      return "/search";
    case "capture":
      return capturePath(link.fields);
  }
}

export function capturePath(fields: CaptureFields): string {
  const q = new URLSearchParams();
  for (const key of ["text", "url", "title"] as const) {
    const v = clean(fields[key]);
    if (v !== undefined) q.set(key, v);
  }
  const s = q.toString();
  return s ? `/capture?${s}` : "/capture";
}

/** `[`, `]` and `\` would end or break a markdown link label; the inline grammar honours
 * backslash escapes inside labels (`packages/core/src/tokens.ts`). Newlines would split the
 * block's first line, so a title becomes one line. */
function escapeLabel(title: string): string {
  return title.replace(/\s*\n\s*/g, " ").replace(/[\\[\]]/g, (c) => `\\${c}`);
}

/** A space or parenthesis would end the `(href)` early; percent-encoding them keeps the URL the
 * same URL. */
function escapeHref(url: string): string {
  return url.replace(/[ ()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

const BARE_URL_RE = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;

/**
 * The block text a capture becomes (proposal 006): shared text → the text; a link with a title →
 * `[title](url)`; a bare link → the URL. When both text and a link arrive (a browser's share often
 * sends the selection as text plus the page's URL), the text comes first and the link follows,
 * unless the text already contains the URL. A title with no link and no text is used as the text.
 */
export function formatCapture(fields: CaptureFields): string {
  let text = clean(fields.text);
  let url = clean(fields.url);
  const title = clean(fields.title);
  // Android's share sends a shared link as EXTRA_TEXT; so does a Shortcut passing a URL as text.
  if (url === undefined && text !== undefined && BARE_URL_RE.test(text)) {
    url = text;
    text = undefined;
  }
  if (url === undefined) return text ?? title ?? "";
  const link =
    title !== undefined && title !== url ? `[${escapeLabel(title)}](${escapeHref(url)})` : url;
  if (text === undefined || text === url || text === title) return link;
  if (text.includes(url)) return text;
  return `${text} ${link}`;
}
