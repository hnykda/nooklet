/**
 * What the page actions actually do to the world (B-220, B-221, B-222): put text on the
 * clipboard, hand the browser a file, flip the synced `favorite` property, open the print dialog.
 * The commands (`../commands/registrations/page-actions.ts`) reach these through
 * `./page-actions-host.ts`; the page title row (`../views/PageActions.tsx`) runs those commands.
 *
 * Also owns the one-line notice ("Copied page as markdown") the title row shows, as a module-level
 * signal: the action may start from the palette, which has closed by the time the copy lands, and
 * the title row is the thing on screen that is about this page.
 */

import { createSignal } from "solid-js";
import { isPageFavorite, renderPageMarkdown } from "../data/page-export.js";
import { setPageFavorite } from "../data/store.js";

export { printPage } from "./print.js";

export interface PageActionNotice {
  text: string;
  /** Distinguishes two identical notices in a row, so the second one restarts the timer. */
  seq: number;
  error: boolean;
}

const [notice, setNotice] = createSignal<PageActionNotice | null>(null);
export const pageActionNotice = notice;

let seq = 0;
let clearTimer: ReturnType<typeof setTimeout> | undefined;

function announce(text: string, error = false): void {
  seq++;
  setNotice({ text, seq, error });
  if (clearTimer !== undefined) clearTimeout(clearTimer);
  clearTimer = setTimeout(() => setNotice(null), error ? 6000 : 2500);
}

/** A page id, or a pending lookup of one (`undefined` = no such page). */
export type PageIdSource = string | Promise<string | undefined>;

/**
 * Copy the page, ids off (`../data/page-export.ts#renderPageMarkdown` says why).
 *
 * `clipboard.write` with a `ClipboardItem` whose data is a PROMISE, called before the first
 * `await`: WebKit — Safari, and the WKWebView the desktop app runs in — only allows a clipboard
 * write inside the user gesture itself, and the text is not ready until two worker round trips
 * later. https://webkit.org/blog/10855/async-clipboard-api/ (read 2026-09-13): "A call to
 * `clipboard.write` or `clipboard.writeText` outside the scope of a user gesture … will result in
 * the immediate rejection of the promise", and "Each `ClipboardItem` is initialized with a mapping
 * of MIME type to `Promise`". So the write starts inside the gesture and the text follows.
 * Chromium accepts the same shape (the e2e copy test runs on it); WebKit itself is unverified
 * here. `writeText` after the await is the fallback for engines without `ClipboardItem`.
 */
export function copyPageMarkdown(page: PageIdSource): Promise<boolean> {
  const text = (async () => {
    const id = await page;
    const md = id === undefined ? undefined : await renderPageMarkdown(id, { ids: "none" });
    if (!md) throw new Error("no such page");
    return md.text;
  })();

  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  let write: Promise<void>;
  if (clipboard?.write && typeof ClipboardItem !== "undefined") {
    const blob = text.then((t) => new Blob([t], { type: "text/plain" }));
    write = clipboard.write([new ClipboardItem({ "text/plain": blob })]);
  } else if (clipboard?.writeText) {
    write = text.then((t) => clipboard.writeText(t));
  } else {
    write = Promise.reject(new Error("no clipboard"));
  }
  // Either promise can reject first; observe both so neither is reported as unhandled.
  text.catch(() => {});
  return write.then(
    () => {
      announce("Copied page as markdown");
      return true;
    },
    () => {
      announce("Couldn't copy the page — the browser refused clipboard access", true);
      return false;
    },
  );
}

/** Offer `text` to the browser as a download named `fileName`. */
export function downloadText(fileName: string, text: string, type = "text/markdown"): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.style.display = "none";
  document.body.append(a);
  a.click();
  a.remove();
  // Revoked on the next task, not synchronously: the click only QUEUES the navigation, and a URL
  // revoked before it is read downloads nothing (Chromium) or a zero-byte file (older WebKit).
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Download the page as the mirror writes it: `^id` suffixes kept, the mirror's file name. */
export async function exportPageMarkdown(page: PageIdSource): Promise<boolean> {
  const id = await page;
  const md = id === undefined ? undefined : await renderPageMarkdown(id, { ids: "present" });
  if (!md) {
    announce("Couldn't export — the page no longer exists", true);
    return false;
  }
  downloadText(md.fileName, md.text);
  announce(`Exported ${md.fileName}`);
  return true;
}

/** The toggle in flight, if any. Toggles run one after another, never interleaved: each one reads the
 * stored value and writes its opposite, and two interleaved (a double click on the star) both read
 * the value from before either write and both wrote `true` — two clicks, still a favourite (B-229). */
let favoriteQueue: Promise<unknown> = Promise.resolve();

/** Flip the page's synced `favorite` property; resolves to the new state (`undefined`: no page). */
export function togglePageFavorite(page: PageIdSource): Promise<boolean | undefined> {
  const run = favoriteQueue.then(async () => {
    const id = await page;
    if (id === undefined) return undefined;
    const next = !(await isPageFavorite(id));
    await setPageFavorite(id, next);
    announce(next ? "Added to favourites" : "Removed from favourites");
    return next;
  });
  // A failed toggle must not wedge every later one behind a rejected promise.
  favoriteQueue = run.catch(() => {});
  return run;
}
