/**
 * An image's display size and alignment, stored the way Logseq file graphs store an image's size
 * (ADR 034): an EDN map written straight after the image, no space between —
 *
 *     ![alt](assets/x.png){:height 236, :width 500}
 *
 * Logseq 0.10.x writes it in `editor-handler/resize-image!` as `(pr-str (merge metadata size))`,
 * and mldoc reads it as everything from the `{` to the FIRST `}` right after the `)` (mldoc
 * `lib/syntax/inline.ml`, `let metadata = between "{" "}"`). The same rule is used here, so a map
 * nooklet writes is one Logseq reads, and a Logseq graph's sizes import as sizes rather than as
 * text after the picture.
 *
 * Only a map that parses as EDN (keyword keys; number, string, keyword, `true`/`false`/`nil`
 * values; commas are whitespace) counts. Anything else after the `)` stays ordinary text: mldoc
 * would swallow `{{embed …}` there too, but a grammar that hides text a person typed is worse
 * than one that leaves a stray Logseq oddity visible.
 *
 * Keys nooklet does not know are kept, in order, through every rewrite (`setImageMeta`).
 * Alignment is nooklet's own key, `:align "center"` (Logseq keeps alignment only in its DB
 * version, as the asset property `:logseq.property.asset/align`; its file format has none).
 */

export type ImageAlign = "left" | "center" | "right";

export interface ImageMeta {
  /** Display width in CSS pixels, when the map has a positive number for `:width`. */
  width?: number;
  /** `:height`, kept for Logseq; nooklet sizes by width and the picture's own aspect ratio. */
  height?: number;
  /** `:align`, when it is one of the three; absent means left (Logseq DB's default too). */
  align?: ImageAlign;
}

/** One `key value` pair as written: `key` with its colon (`:width`), `value` verbatim (`500`). */
interface Entry {
  key: string;
  value: string;
}

const KEYWORD_RE = /^:[A-Za-z_*+!?<>=-][\w.*+!?<>=/-]*$/;
const NUMBER_RE = /^[-+]?\d+(?:\.\d+)?$/;

/** EDN tokens of a map's interior, or `null` when something in it is not a value this reads. */
function ednTokens(inner: string): string[] | null {
  const out: string[] = [];
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i] as string;
    if (ch === "," || /\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < inner.length && inner[j] !== '"') j += inner[j] === "\\" ? 2 : 1;
      if (j >= inner.length) return null;
      out.push(inner.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < inner.length && !/[\s,"]/.test(inner[j] as string)) j++;
    const atom = inner.slice(i, j);
    if (
      !KEYWORD_RE.test(atom) &&
      !NUMBER_RE.test(atom) &&
      atom !== "true" &&
      atom !== "false" &&
      atom !== "nil"
    ) {
      return null;
    }
    out.push(atom);
    i = j;
  }
  return out;
}

function entriesOf(map: string): Entry[] | null {
  if (!map.startsWith("{") || !map.endsWith("}")) return null;
  const tokens = ednTokens(map.slice(1, -1));
  if (tokens === null || tokens.length % 2 !== 0) return null;
  const out: Entry[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const key = tokens[i] as string;
    if (!KEYWORD_RE.test(key)) return null;
    const value = tokens[i + 1] as string;
    // A repeated key: EDN readers keep the last (Clojure's reader refuses it outright; Logseq's
    // `safe-read-string` would then ignore the whole map, which keeping the last is kinder than).
    const at = out.findIndex((e) => e.key === key);
    if (at !== -1) out.splice(at, 1);
    out.push({ key, value });
  }
  return out;
}

function positive(value: string | undefined): number | undefined {
  if (value === undefined || !NUMBER_RE.test(value)) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function alignOf(value: string | undefined): ImageAlign | undefined {
  const v = value?.replace(/^"(.*)"$/, "$1").replace(/^:/, "");
  return v === "left" || v === "center" || v === "right" ? v : undefined;
}

function metaOf(entries: readonly Entry[]): ImageMeta {
  const get = (key: string) => entries.find((e) => e.key === key)?.value;
  const meta: ImageMeta = {};
  const width = positive(get(":width"));
  const height = positive(get(":height"));
  const align = alignOf(get(":align"));
  if (width !== undefined) meta.width = width;
  if (height !== undefined) meta.height = height;
  if (align !== undefined) meta.align = align;
  return meta;
}

/**
 * The image metadata map starting at `text[at]`, if there is one: what it says, and the index just
 * past its `}`. `at` is where the image's `)` ended.
 */
export function readImageMeta(text: string, at: number): { meta: ImageMeta; end: number } | null {
  if (text[at] !== "{") return null;
  const close = text.indexOf("}", at + 1);
  if (close === -1) return null;
  const map = text.slice(at, close + 1);
  if (map.includes("\n")) return null;
  const entries = entriesOf(map);
  if (entries === null) return null;
  return { meta: metaOf(entries), end: close + 1 };
}

/** `{:height 236, :width 500}` — `pr-str`'s shape, which is what Logseq writes. */
function serialize(entries: readonly Entry[]): string {
  return `{${entries.map((e) => `${e.key} ${e.value}`).join(", ")}}`;
}

/** A width as written: whole pixels. Logseq writes whatever its drag measured (`412.5`); nooklet
 *  rounds, since a fraction of a pixel is nothing a person chose. */
function px(n: number): string {
  return String(Math.max(1, Math.round(n)));
}

export interface ImageMetaChange {
  /** The new display width; `null` removes it (the picture's own size again). */
  width?: number | null;
  /** The new alignment; `"left"` or `null` removes the key (left is the default). */
  align?: ImageAlign | null;
}

/**
 * `content` with the metadata of an image changed. `imageEnd` is the offset just past the image's
 * `)` — the image token's `metaAt` — where the map is, or would go.
 *
 * Changing the width rescales an existing `:height` by the same factor (Logseq 0.10 puts both
 * on the `<img>`, so a stale height would stretch the picture there); a `:height` with no
 * `:width` to scale from is dropped. A map left empty is removed.
 */
export function setImageMeta(content: string, imageEnd: number, change: ImageMetaChange): string {
  const existing = readImageMeta(content, imageEnd);
  const entries = existing ? (entriesOf(content.slice(imageEnd, existing.end)) ?? []) : [];
  const set = (key: string, value: string | null): void => {
    const at = entries.findIndex((e) => e.key === key);
    if (value === null) {
      if (at !== -1) entries.splice(at, 1);
    } else if (at !== -1) entries[at] = { key, value };
    else entries.push({ key, value });
  };
  if (change.width !== undefined) {
    const before = existing?.meta;
    if (change.width === null) {
      set(":width", null);
      set(":height", null);
    } else {
      const width = Math.max(1, Math.round(change.width));
      if (before?.height !== undefined) {
        set(
          ":height",
          before.width !== undefined ? px((before.height * width) / before.width) : null,
        );
      }
      set(":width", px(width));
    }
  }
  if (change.align !== undefined) {
    set(":align", change.align === null || change.align === "left" ? null : `"${change.align}"`);
  }
  const map = entries.length > 0 ? serialize(entries) : "";
  return content.slice(0, imageEnd) + map + content.slice(existing ? existing.end : imageEnd);
}
