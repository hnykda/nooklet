/**
 * B-705, belt and braces for the touch-screen 16px field rule (`../styles/shell.css`): in the iOS
 * app, `maximum-scale=1` on the viewport stops iOS's zoom-on-focus outright, for a field that rule
 * misses (one under 16px by an inline style, say).
 *
 * Only in the Capacitor app, where it costs nothing: Capacitor's WKWebView already has pinch-zoom
 * off (`zoomEnabled` defaults to false — `@capacitor/ios` 8.5.1, `CAPInstanceDescriptor.m`:
 * `_zoomingEnabled = NO`, and `WebViewDelegationHandler.scrollViewWillBeginZooming` disables the
 * pinch recogniser). On the web it is NOT added: mobile Safari ignores the scale limits for
 * pinch-zoom since iOS 10 (https://webkit.org/blog/7367/new-interaction-behaviors-in-ios-10/ —
 * "we ignore the user-scalable, min-scale and max-scale settings"), but a WKWebView honours them
 * unless `ignoresViewportScaleLimits` is set (same post), and Chrome on Android honours
 * `maximum-scale` too — so on the web it would take pinch-zoom away from people who need it.
 */
export function withMaximumScale(content: string): string {
  if (/(^|,)\s*maximum-scale\s*=/.test(content)) return content;
  return `${content.replace(/[\s,]+$/, "")}, maximum-scale=1`;
}

/** Applies `withMaximumScale` to the page's viewport meta. Call only in the Capacitor app. */
export function capViewportScale(doc: Document = document): void {
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (meta) meta.content = withMaximumScale(meta.content);
}
