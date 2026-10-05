# Proposal 006: capture from anywhere on the phone (share sheet, quick actions, widgets)

**Status:** Phase 1 accepted 2026-10-04 by the owner ("do phase 1"); being built, see `docs/progress/phone-capture.md`. Phases 2-3 not decided · **Prompted by:** the owner:
"are there some iOS features like 'share with nooklet' so it would get added as a quick capture to
the current day, or when holding the icon it offers some options, or a widget… plan it? Same in
Android?"

## What already exists

- **`/capture`** (`apps/web/src/routes/CaptureRoute.tsx`, PLAN.md §14): a route outside the app
  shell that opens fast, never loads the graph, and appends one block to today's journal through
  `capture/quickCaptureService.ts` (local write into the replica; sync carries it to the server).
- **`nooklet://` URL scheme** registered in the iOS app (`Info.plist`), already used for pairing
  links (ADR 029). Android has the Capacitor project (`apps/web/android/`, experimental).
- The owner's phone is an **iPhone 15 Pro**, which has the **Action Button**.

Everything below funnels into one thing: **a capture lands as a new block at the end of today's
journal in the active graph**, as text, or `[title](url)` for a shared link, or an image for a
shared picture. It is written locally first (works offline) and synced like any other edit.

## The menu of entry points

| Entry point | iOS | Android | Needs |
|---|---|---|---|
| A. `nooklet://capture?text=…` deep link opening a capture sheet | URL scheme (exists) | intent filter | app only |
| B. Long-press the icon: "New note", "Today", "Search" | Home Screen Quick Actions (`UIApplicationShortcutItems`) | App Shortcuts (`shortcuts.xml`) | app only |
| C. "Add to nooklet" in Shortcuts, Siri, **Action Button**, Spotlight | App Intents (iOS 16+), in the app target | Assistant App Actions / a launcher shortcut | app only |
| D. **Share sheet**: "nooklet" for text, links, images from any app | **Share Extension** (separate target) | Share target (`ACTION_SEND` intent filter in the main activity) | iOS: extension + App Group; Android: app only |
| E. Widget: a "Capture" button on the Home/Lock Screen | WidgetKit extension (button opens A) | Glance widget | iOS: extension; Android: app |
| F. Control Center / Quick Settings button | Control widget (iOS 18) | Quick Settings tile | extension / app |
| G. Widget showing today's tasks or recent pages | WidgetKit + App Group data | Glance + app data | data shared with the widget; most work |

## The iOS catch: extensions and a free Apple account

A, B and C live in the app itself. D, E, F and G are **app extensions**: separate targets with their
own bundle ids, and D/G must share data with the app through an **App Group**. With the free
Personal Team the owner uses:

- every extension is another App ID, and a free account may register only a handful per week
  (Apple: 10 App IDs per 7 days); all expire with the app every 7 days;
- whether a Personal Team can use **App Groups** at all is unclear. Apple's capability table says
  no; free-account sideloading tools say yes. The probe that settles it is built but not yet run
  (`docs/research/16-personal-team-app-groups.md`). If it cannot, a Share Extension can still work by
  posting straight to the server with its own token (online only), but not offline.

Android has none of this: a share target is an intent filter on the main activity, and the shared
text arrives in the running app.

## How a share extension would work (iOS, D)

An extension cannot run the Capacitor web app and cannot open its host app. So:

1. The extension shows a small native sheet (text field pre-filled with what was shared, a Save
   button), and on Save writes a JSON file to the App Group container (`captures/<uuid>.json`:
   text, url, title, image file name, created-at).
2. The app, on launch and every foreground, drains that folder through `quickCaptureService` (one
   block each, in created-at order) and deletes each file only after its write committed.
3. Nothing is lost if the app is not opened for days; captures land with their own timestamps.
   Images go through the existing asset upload when the app drains them.

The same queue serves C (an App Intent can write to the queue in the background without opening
the app) and E/F.

## Proposed phases

1. **Phase 1, app only, works with the free account (both platforms):**
   - A: `nooklet://capture` opens the capture sheet, pre-filled from `text`/`url`/`title`.
   - B: quick actions "New note" (capture sheet), "Today" (today's journal), "Search".
   - C (iOS): an "Add to nooklet" App Intent with a text parameter, which can run without opening the
     app, so the **Action Button**, Siri and Shortcuts can capture in one press. It needs a tiny
     native queue the app drains, the same as in the share-extension design above.
   - D (Android): the share target.
   - Tests: unit tests for the drain (ordering, idempotence, partial failure); e2e for
     `nooklet://capture` via the web route; Simulator runs of the quick actions and the intent.
2. **Phase 2, iOS extensions:** first the App Group probe on the free account. Then:
   - D: the Share Extension.
   - E: a Capture widget (Home Screen and Lock Screen).
   - F: a Control Center button.
   - Android gets its Glance widget and Quick Settings tile here too.
3. **Phase 3, data widgets (G):** today's tasks and recent pages. Needs a small read model exported
   into the shared container on every sync. Only if Phase 2 proves the shared container works and
   the owner wants it.

## What it costs

- Native code: Swift (an App Intent, a quick-action handler, then the extension targets) and Kotlin
  (share intent, shortcuts). Capacitor plugins exist for some of this (e.g. app shortcuts, share
  targets), but they are third-party; each needs a look before adopting it versus ~100 lines of
  our own native code.
- Testing: the Simulator covers quick actions, intents, share extensions and widgets; the Action
  Button and real share sheets from other apps need the owner's phone. Android is untested on a
  device, as the rest of the Android app already is (documented as experimental).
- Phase 2 on iOS adds App IDs that expire every 7 days with the free account, and installing it
  needs the owner's phone in the loop each time.

## Still unverified

- ~~Whether a free Personal Team can use App Groups~~ — **settled 2026-10-05: yes.** An app and a
  share extension signed by Xcode's automatic provisioning with the owner's free team shared
  `group.sh.nooklet.probe` on the owner's iPhone; the extension's file was read by the app
  (`docs/research/16-personal-team-app-groups.md` §3). Phase 2 is technically possible on the free
  account, within its limits (10 App IDs per 7 days, 3 apps per phone).
- Whether an App Intent defined in a Capacitor app target can write to the queue while the web view
  is not running (expected yes: it is plain Swift in the app process).

Settled: the free-account limits. Apple's
[Developer account overview](https://developer.apple.com/support/compare-memberships/) says a
Personal Team can register up to 10 App IDs (expiring after 7 days), up to 3 devices, and install
up to **3 apps per device**, with 7-day profiles. The 3-app cap is new to this proposal: nooklet
plus any probe use 2 of the 3.
