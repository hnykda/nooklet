/**
 * Route wrapper for `/capture` (PLAN.md §14). Thin by design (routes own URL/param plumbing,
 * views own the UI — same split as `JournalsRoute.tsx`): it turns the query params into
 * `CaptureView`'s prefill.
 *
 * `?text=…&url=…&title=…` is one shape for every way in: the PWA manifest's `share_target` (GET
 * params `title`/`text`/`url`, research/08 §1.4), and every `nooklet://capture` link the app is
 * handed (`../capture/AppLinkHandler.tsx`, ADR 033). `formatCapture` decides the block text:
 * shared text as is, `[title](url)` for a link with a title, a bare URL as the URL.
 */
import { useNavigate, useSearchParams } from "@solidjs/router";
import { createMemo, type JSX, Show } from "solid-js";
import { formatCapture } from "../capture/capture-link.js";
import { deviceHasNoGraph } from "../data/bootstrap.js";
import { CaptureView } from "../views/CaptureView.js";

const asString = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

export function CaptureRoute(): JSX.Element {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const initialText = createMemo(() =>
    formatCapture({
      text: asString(params.text),
      url: asString(params.url),
      title: asString(params.title),
    }),
  );
  return (
    // Keyed: a second link opened while this screen is up replaces the prefill (a fresh view)
    // rather than being ignored by a view that read its props once.
    <Show when={initialText()} keyed fallback={<View navigate={navigate} />}>
      {(text) => <View navigate={navigate} initialText={text} />}
    </Show>
  );
}

function View(props: {
  navigate: ReturnType<typeof useNavigate>;
  initialText?: string;
}): JSX.Element {
  return (
    <CaptureView
      initialText={props.initialText}
      noGraph={deviceHasNoGraph()}
      onSetUpGraph={() => props.navigate("/journals")}
      onCancel={() => props.navigate("/journals", { replace: true })}
      // Saved: drop the prefill from the address so a reload cannot offer the same text again.
      // Not through the router, which would remount the view and hide the confirmation.
      onSaved={() => history.replaceState(history.state, "", location.pathname)}
    />
  );
}
