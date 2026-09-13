# Bug inbox — quiet-topbar (M11)

Entries in `docs/BUGS.md`'s format, for the coordinator to fold in. B-542 and B-543 are
provisional numbers (no range was reserved for this run) — renumber freely.

---

### B-540 (existing)

**Fixed 2026-09-13.** Scoped as the owner asked: the indicator, nothing broader. The owner, on the
top bar: "'Agent access to this window' could be probably hidden under some icon? Same with sync —
I want it to be very silent. Logseq has an icon of a cloud with a yellow small dot … that goes
green when synced again … Also in muted colours."

- **Sync indicator** (`apps/web/src/shell/SyncIndicator.tsx`, rule in `sync-indicator-state.ts`,
  styles in `sync-indicator.css`): a muted cloud `.app-icon-button` with a 7px dot in its
  bottom-right corner — green synced, yellow pending, red-grey offline, red error, a hollow ring
  for "not saved locally" (B-43, amber) and "synced via another tab" (B-81, green), no dot before
  the worker answers. The words moved to `title` and `aria-label` ("Synced", "3 changes waiting to
  sync", "Offline — changes are kept and sent when back online", …). The dot (`data-state`) only
  moves to pending/offline/error once that state has lasted 2 s (`ATTENTION_DELAY_MS`); recovering
  shows at once. The label is the true state at every moment, so e2e tests that waited for
  `toHaveText("synced")` as "nothing left to push" now wait for `aria-label="Synced"`. It also now
  shows the sync client's `error` state, which the text version silently rendered as "synced" or
  "syncing". Click still opens Diagnostics; the button never changes size.
- **Consent badge** (`apps/web/src/live/ConsentBadge.tsx`, `live.css`): the pill became a muted
  robot icon button with the same corner dot — none when off, a muted green dot when observed; when
  agents can *control* the window the icon, dot and a tinted ground are drawn in the agent accent
  so that state stays noticeable. The sentence is the tooltip and accessible name; click still opens
  the toggles and activity log. ADR 015 §6 records the change.
- One new token, `--dot-pending` in `styles/shell.css`: `--warn` is a text colour and read brown at
  dot size in the light theme.

Measured in Chromium against the production build (port 6422), in the e2e test below run with the
delay temporarily set to 0: counting from when recording started (just before typing), the label
went to "1 change waiting to sync" at 401 ms and back to "Synced" at 711 ms. A routine push is
pending about 300 ms, well under the 2 s delay. With the delay at 0 that test fails, recording
`data-state="pending"` for that window; with 2 s it passes.

Tests: `apps/web/src/shell/sync-indicator-state.test.ts` (10: derive, labels, and the delay state
machine with fake timers — "a push that lands inside the delay shows nothing at all" and 6 more);
`apps/web/src/live/ConsentBadge.test.tsx` (2: accessible name/tooltip per state with no visible
text; click opens the toggles); `e2e/tests/sync-indicator.spec.ts` › "a routine edit's push and
pull never change what the sync indicator shows" (records every `data-state`/`aria-label` value
with a MutationObserver; asserts the edit was pending, and the dot never left "synced") and ›
"offline shows the offline state, and reconnecting clears it" (`context.setOffline`). Updated to
the new attributes: `storage.spec.ts`, `views.spec.ts` (follower), `read-only.spec.ts`,
`palette-text-keys.spec.ts`, `connectivity.spec.ts` ("sync reaches a connected state" read the
page's text for "offline", which an icon no longer has). Screenshots (light, dark, 390 px, a state
gallery, real offline) were checked by eye and are not in the repo.

`storage.spec.ts` also passes in the `webkit` project (2/2), which covers the `memory` state.
Not verified: the desktop app (WKWebView), and how the bar looks next to `m11/desktop-shell`'s
top-bar inset.

---

### B-542 · Under `vite dev` (and vitest), opening the consent badge's popover throws
**Status:** fixed · **Severity:** low (production builds unaffected) · **Found:** 2026-09-13,
quiet-topbar (writing the badge's first component test) · **Test:**
`apps/web/src/live/ConsentBadge.test.tsx` › "opens the agent-access toggles on click, as the pill did"

`ConsentBadge.tsx` defined its own `function Switch(...)` for the two toggles. In development mode
vite-plugin-solid wraps components in the HMR registry (`var Switch = _$$component(_REGISTRY, …)`),
and babel-preset-solid's built-ins handling then compiled `<Switch>` to an import of solid-js's
own `Switch` — `TypeError: Cannot read properties of undefined (reading 'when')` the moment the
popover rendered. Evidence: `vite`'s `transformRequest` for the file in development mode imports
`Switch as _$Switch` from `solid-js/web` and calls it; in production mode it calls the local
`Switch`. So the dev server and every component test were broken; the served production build
(and so e2e) was not. Fixed by renaming the local component to `ToggleSwitch`.

---

### B-543 · `connectivity.spec.ts` › "search returns rather than spinning forever" fails most runs
**Status:** open · **Severity:** low (test only) · **Found:** 2026-09-13, quiet-topbar (running the
specs it touched) · **Test:** the test itself

On the unchanged base commit `9ac9e48` (port 6422, Chromium) it failed 3 of 4 runs, the same as on
`m11/quiet-topbar`: `locator.click` times out waiting for `.vr-outliner .vr-block-view`. The page
snapshot at the failure shows today's virtual journal with its "Start typing…" draft and no
outliner. Likely cause (read, not proven): the test decides which branch to take with a
non-retrying `await draft.isVisible()` straight after `page.goto("/journals")`, before the journal
has rendered, so it takes the "outliner" branch on a day that only has a draft. `openJournal` in
`e2e/helpers/editor.ts` waits for `draft.or(outliner)` first and does not have this race.
