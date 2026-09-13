/**
 * The persistent consent badge (ADR 015 §2.6/BUILD item 8) — "the goal is not to make this
 * invisible or minimally-surprising, it is to make it legible and a little bit delightful to
 * watch, while still being trivially revocable." Always visible in the top bar
 * (`../shell/AppShell.tsx`), never tucked in a settings page. Click opens the two toggles and a
 * short recent-activity log.
 *
 * An icon rather than a sentence since B-540 (the owner: agent access "could be probably hidden
 * under some icon", in the same muted register as the sync cloud): the sentence is the tooltip and
 * accessible name. *Observed* is a muted robot with a small dot; *controlled* is drawn in the
 * agent accent on a tinted ground, because that is the state in which something other than the
 * human can act on this window, and a consent signal that blends into the chrome is no signal
 * (ADR 015 §6).
 *
 * Reads `./consent.ts#liveConsent` and `./connection-state.ts#liveConnected` directly (module
 * singletons) rather than via props, so mounting this in `AppShell` needs no wiring beyond the
 * import — `../app/CommandLayer.tsx` is the only place that WRITES to either.
 */

// One file per icon, not the `lucide-solid` barrel (B-140).
import Bot from "lucide-solid/icons/bot";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { type ActivityEntry, activityLog } from "./activity-log.js";
import { BADGE_LABEL, deriveBadgeState } from "./badge-state.js";
import { liveConnected } from "./connection-state.js";
import { type ConsentState, liveConsent } from "./consent.js";
import "./live.css";

function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

/** Not named `Switch` (B-542): under vite-plugin-solid's dev transform the HMR wrapper hides this
 * binding from babel-preset-solid's built-ins check, so `<Switch>` compiled to solid-js's own
 * `<Switch>` and opening the popover threw under `vite dev` and vitest. Production was fine. */
function ToggleSwitch(props: {
  checked: boolean;
  onChange: (v: boolean) => void;
  variant?: "view" | "control";
  label: string;
}) {
  return (
    <button
      type="button"
      class="vr-live-switch"
      data-variant={props.variant}
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      onClick={() => props.onChange(!props.checked)}
    />
  );
}

export function ConsentBadge() {
  const [open, setOpen] = createSignal(false);
  const [consent, setConsent] = createSignal<ConsentState>(liveConsent.get());
  const [activity, setActivity] = createSignal<ActivityEntry[]>(activityLog.list());
  const [now, setNow] = createSignal(Date.now());

  onMount(() => {
    const unsubConsent = liveConsent.subscribe(setConsent);
    const unsubActivity = activityLog.subscribe(setActivity);
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    onCleanup(() => {
      unsubConsent();
      unsubActivity();
      clearInterval(tick);
    });
  });

  const state = createMemo(() =>
    deriveBadgeState({ connected: liveConnected(), controlEnabled: consent().controlEnabled }),
  );

  return (
    <div class="vr-live-badge-wrap">
      <button
        type="button"
        class="app-icon-button vr-live-badge"
        data-state={state()}
        aria-expanded={open()}
        aria-haspopup="dialog"
        aria-label={BADGE_LABEL[state()]}
        title={BADGE_LABEL[state()]}
        onClick={() => setOpen((v) => !v)}
      >
        <Bot size={17} />
        <span class="vr-live-dot" aria-hidden="true" />
      </button>
      <Show when={open()}>
        <div class="vr-live-popover" role="dialog" aria-label="Agent access to this window">
          <h3>Agent access to this window</h3>

          <div class="vr-live-toggle-row">
            <div class="vr-live-toggle-copy">
              <span class="vr-live-toggle-title">Let agents view this window</span>
              <span class="vr-live-toggle-sub">
                Read-only: what page, what's focused. No edits.
              </span>
            </div>
            <ToggleSwitch
              checked={consent().viewEnabled}
              variant="view"
              label="Let agents view this window"
              onChange={(v) => liveConsent.setViewEnabled(v)}
            />
          </div>

          <div class="vr-live-toggle-row">
            <div class="vr-live-toggle-copy">
              <span class="vr-live-toggle-title">Let agents control this window</span>
              <span class="vr-live-toggle-sub">Run commands here, exactly as you would.</span>
            </div>
            <ToggleSwitch
              checked={consent().controlEnabled}
              variant="control"
              label="Let agents control this window"
              onChange={(v) => liveConsent.setControlEnabled(v)}
            />
          </div>

          <div class="vr-live-activity">
            <h4>Recent activity</h4>
            <Show
              when={activity().length > 0}
              fallback={<p class="vr-live-activity-empty">Nothing yet.</p>}
            >
              <ul>
                <For each={activity()}>
                  {(entry) => (
                    <li>
                      {entry.text} · {relativeTime(entry.at, now())}
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}
