/**
 * What the image viewer's buttons do (B-736): copy an image, save it, open it on its own. Kept
 * apart from `./ImageViewer.tsx` so each host's path is testable without rendering anything.
 *
 * "Save" is three different things depending on where the client runs, and the obvious single
 * answer (`<a download href=blob:…>`) works in only one of them:
 *
 * - a browser: fetch the bytes, `<a download>` a blob URL. Asset URLs need no credential (`GET
 *   /assets/:id` is public by design, `packages/server/src/http/assets.ts`), so a plain fetch
 *   works; the blob is what makes `download` honoured even if the API origin differs from the
 *   page's (Chromium ignores `download` on a cross-origin href and navigates instead).
 * - the desktop app (WKWebView): wry CANCELS every download unless the shell set a download
 *   handler (`wry` `navigation_policy`: `shouldPerformDownload` → `Cancel` without one), so
 *   `<a download>` did nothing at all. The shell now has one (`main.rs`, `on_download`) and saves
 *   to ~/Downloads. The page hands it the asset's own http URL rather than a blob: a blob URL
 *   would make WebKit's download depend on the page staying alive, and the plain URL is
 *   same-origin there anyway (the window shows the server's page, ADR 016).
 * - a phone (Capacitor): there is no "Downloads" a person can find; the share sheet is where
 *   "Save Image" / "Save to Files" live, so the bytes go there (`platform.share.shareFile`).
 */

import { describeError } from "../../data/api-client.js";
import { DESKTOP_DOWNLOAD_EVENT, desktopShell } from "../../platform/desktop-shell.js";
import { platform } from "../../platform/index.js";
import { assetIdOf } from "./asset-url.js";

export type ImageHost = "web" | "desktop" | "desktop-old" | "phone";

export function imageHost(): ImageHost {
  const shell = desktopShell();
  if (shell) return shell.downloads ? "desktop" : "desktop-old";
  return platform.name === "capacitor" ? "phone" : "web";
}

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
};

/**
 * The file name a saved image gets: the alt text when there is a usable one (what a person
 * called it), otherwise the asset id or the URL's last path segment; the extension from the
 * source path, falling back to the response's type.
 */
export function downloadName(src: string, alt: string, mime?: string): string {
  const path = src.split(/[?#]/)[0] ?? "";
  const last = decodeURIComponentSafe(path.slice(path.lastIndexOf("/") + 1));
  const dot = last.lastIndexOf(".");
  const ext =
    (dot > 0 ? last.slice(dot + 1).toLowerCase() : "") || (mime && MIME_EXT[mime]) || "png";
  const fromAlt = cleanName(alt);
  const stem =
    fromAlt || assetIdOf(src) || cleanName(dot > 0 ? last.slice(0, dot) : last) || "image";
  return `${stem}.${ext}`;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Anything a file system might refuse (or read as a path) becomes `_`; capped in length. */
function cleanName(s: string): string {
  return s
    .replace(/[\\/:*?"<>|]+|\p{Cc}+/gu, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 100);
}

export async function fetchImageBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

export type ActionResult = { ok: true; message: string } | { ok: false; message: string };

/**
 * Copies the image's bytes. The Clipboard API takes `image/png` everywhere it takes images at all
 * (Chromium writes nothing else), so a JPEG/WebP/GIF is re-encoded through a canvas first. The
 * blob is handed over as a PROMISE: Safari/WebKit only allows `clipboard.write` while the click
 * is still the current user gesture, and a fetch in between would end it.
 */
const COPY_TIMEOUT_MS = 10_000;

export async function copyImage(url: string): Promise<ActionResult> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    return {
      ok: false,
      message:
        "Copying images isn't supported here. Use Download, or open the image and copy it from there.",
    };
  }
  try {
    const png = fetchImageBlob(url).then(toPng);
    // B-744: in the Mac app the write was seen never to settle; a bound turns that into an
    // answer instead of a button that stays busy forever.
    const timedOut = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), COPY_TIMEOUT_MS));
    const done = await Promise.race([
      navigator.clipboard.write([new ClipboardItem({ "image/png": png })]),
      timedOut,
    ]);
    if (done === "timeout") {
      return {
        ok: false,
        message: "Copying didn't finish — this app may not allow it. Use Download instead.",
      };
    }
    return { ok: true, message: "Image copied to the clipboard." };
  } catch (err) {
    return { ok: false, message: `Couldn't copy the image (${describeError(err)}).` };
  }
}

async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not encode PNG"))), "image/png"),
  );
}

/** Click a throwaway `<a download>`. */
function clickDownloadLink(href: string, name: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.append(a);
  a.click();
  a.remove();
}

/** How long the desktop shell has to say a download finished before the viewer stops waiting. */
const DESKTOP_REPORT_MS = 15_000;

export async function downloadImage(
  url: string,
  src: string,
  alt: string,
  host: ImageHost = imageHost(),
): Promise<ActionResult> {
  try {
    if (host === "desktop") {
      // Absolute: WebKit resolves the href against the page anyway, but the shell matches its
      // report on the URL it was given.
      const abs = new URL(url, location.href).href;
      const name = downloadName(src, alt);
      const reported = new Promise<ActionResult>((resolve) => {
        const timer = setTimeout(() => {
          window.removeEventListener(DESKTOP_DOWNLOAD_EVENT, onDone);
          resolve({ ok: true, message: "Saving to Downloads…" });
        }, DESKTOP_REPORT_MS);
        function onDone(e: Event): void {
          const d = (
            e as CustomEvent<{ ok?: unknown; name?: unknown; path?: unknown; url?: unknown }>
          ).detail;
          if (d?.url !== undefined && d.url !== abs) return;
          clearTimeout(timer);
          window.removeEventListener(DESKTOP_DOWNLOAD_EVENT, onDone);
          const saved = typeof d?.name === "string" && d.name ? d.name : name;
          // The whole path (B-744): "Downloads" alone left the owner asking where it went.
          const where = typeof d?.path === "string" && d.path ? d.path : `~/Downloads/${saved}`;
          resolve(
            d?.ok === true
              ? { ok: true, message: `Saved to ${where}` }
              : { ok: false, message: "The download failed." },
          );
        }
        window.addEventListener(DESKTOP_DOWNLOAD_EVENT, onDone);
      });
      clickDownloadLink(abs, name);
      return await reported;
    }
    if (host === "desktop-old") {
      // This shell cancels every download; the system browser can save it instead.
      window.open(url, "_blank", "noopener");
      return {
        ok: false,
        message: "This version of the app can't save files — opened in your browser instead.",
      };
    }
    const blob = await fetchImageBlob(url);
    const name = downloadName(src, alt, blob.type);
    if (host === "phone") {
      return (await platform.share.shareFile({ name, blob }))
        ? { ok: true, message: "Shared." }
        : { ok: false, message: "Sharing isn't available. Long-press the image to save it." };
    }
    const href = URL.createObjectURL(blob);
    clickDownloadLink(href, name);
    // Revoked later, not now: the browser reads the blob after the click returns.
    setTimeout(() => URL.revokeObjectURL(href), 60_000);
    // A page cannot learn where the browser put it; say what to look for and where it usually is.
    return { ok: true, message: `Downloaded ${name} to your browser's downloads folder.` };
  } catch (err) {
    return { ok: false, message: `Couldn't download the image (${describeError(err)}).` };
  }
}
