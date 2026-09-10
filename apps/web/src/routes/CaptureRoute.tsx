/**
 * Route wrapper for `/capture` (PLAN.md §14). Thin by design (routes own URL/param plumbing,
 * views own the UI — same split as `JournalsRoute.tsx`): its only job is turning the PWA
 * manifest's `share_target`/`shortcuts` query params (`public/manifest.webmanifest`) into
 * `CaptureView`'s `initialText` prefill.
 *
 * `share_target`'s GET params are `title`/`text`/`url` (Android only receives this — research/08
 * §1.4); the "Quick capture" `shortcuts` entry links to plain `/capture` with no params.
 */
import { useSearchParams } from "@solidjs/router";
import type { JSX } from "solid-js";
import { CaptureView } from "../views/CaptureView.js";

function joinNonEmpty(parts: (string | undefined)[]): string {
  return parts.filter((p): p is string => !!p && p.length > 0).join(" ");
}

export function CaptureRoute(): JSX.Element {
  const [params] = useSearchParams();
  const asString = (v: string | string[] | undefined): string | undefined =>
    Array.isArray(v) ? v[0] : v;
  const initialText = joinNonEmpty([
    asString(params.title),
    asString(params.text),
    asString(params.url),
  ]);
  return <CaptureView initialText={initialText || undefined} />;
}
