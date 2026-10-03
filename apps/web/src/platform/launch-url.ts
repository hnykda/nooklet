/**
 * Keeps `App.getLaunchUrl()` from re-delivering a deep link the page already handled.
 *
 * Despite its name, `getLaunchUrl()` returns Capacitor's `ApplicationDelegateProxy.shared.lastURL`
 * (`@capacitor/ios` 8.5.1, `CAPBridge.swift`), which is set by EVERY `open url`, cold or warm, and
 * lives as long as the native process, so it survives `location.reload()`. Found on the
 * Simulator (B-603): a pairing link connected, the connect screen reloaded the page as it must,
 * and the reloaded page got the same link from `getLaunchUrl()` and showed the confirm screen
 * again, indefinitely.
 *
 * So every URL delivered to the page is recorded (`markUrlHandled`), and the `getLaunchUrl()` check
 * at startup only fires for one not yet recorded (`claimLaunchUrl`). A live `appUrlOpen` event is
 * always delivered, so opening the same link again on purpose still works. `sessionStorage` lasts
 * exactly as long as this WebView's page session: it survives a reload, not a relaunch.
 *
 * Only a hash is stored: a pairing link carries a token, and it should not be kept anywhere it
 * does not have to be.
 */
const KEY = "nooklet.handledLaunchUrl";

function hash(s: string): string {
  // FNV-1a, 32-bit. A collision could only hide one deep link opened in the same page session.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export function markUrlHandled(url: string, storage: Storage | undefined): void {
  try {
    storage?.setItem(KEY, hash(url));
  } catch {
    // Storage unavailable: nothing to remember it in.
  }
}

/** True if `url` (from `getLaunchUrl()`) has not been delivered to this page session yet; marks
 * it delivered. */
export function claimLaunchUrl(url: string, storage: Storage | undefined): boolean {
  try {
    if (storage?.getItem(KEY) === hash(url)) return false;
  } catch {
    // Storage unavailable: deliver it, as before this existed.
  }
  markUrlHandled(url, storage);
  return true;
}
