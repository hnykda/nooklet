/**
 * `/image` (R48, B-99): ask for an image file the way every platform this app runs on already
 * knows how — an `<input type="file">` — so the web build, the Tauri webview and a phone's
 * webview all show their own native chooser with no platform-specific host.
 *
 * The upload and the insertion reuse the image-paste path (`paste.ts#uploadImageAsset`,
 * `BlockTree.tsx#insertUploadedImage`); this file only gets the file.
 */

/**
 * Opens the chooser and resolves with the picked file, or `null` when the person cancels.
 *
 * The input is attached to the document (hidden) for as long as the chooser is open: some engines
 * refuse `click()` on a detached file input, and WebKit fires `change` only on a connected one.
 * `cancel` is the standard event for a dismissed chooser (Chromium 113+, Safari 16.4+, Firefox
 * 91+); where it never fires the promise simply stays pending, which is harmless — nothing waits on
 * it but the insertion it would have made.
 */
export function pickImageFile(doc: Document = document): Promise<File | null> {
  return new Promise((resolve) => {
    const input = doc.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.hidden = true;
    input.dataset.nookletImagePicker = "";
    const done = (file: File | null): void => {
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => done(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => done(null), { once: true });
    doc.body.appendChild(input);
    input.click();
  });
}

/** `text` inserted into `content` at `offset`, clamped — for a block the editor has since left. */
export function insertAt(content: string, offset: number, text: string): string {
  const at = Math.max(0, Math.min(offset, content.length));
  return content.slice(0, at) + text + content.slice(at);
}
