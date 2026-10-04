# Progress: phone capture, proposal 006 Phase 1

Task: build Phase 1 of `docs/proposals/006-capture-from-anywhere-on-the-phone.md` (accepted by the
owner 2026-10-04): `nooklet://capture` links, Home Screen quick actions / Android App Shortcuts, the
iOS "Add to nooklet" App Intent with a native queue the web app drains, the Android share target.
Design: `docs/adr/033-phone-capture-native-queue.md`. User guide: `docs/guide/capture.md`.

## Done

- `87783213` web layer + iOS native: `capture/capture-link.ts` (parse/format), `capture-queue.ts`
  (drain), `native-queue.ts` (plugin glue), `AppLinkHandler.tsx`, capture screen pre-fill / Cancel
  / no-graph draft, `deviceHasNoGraph()`; iOS `CaptureQueue.swift`, `CaptureQueuePlugin.swift`,
  `AppViewController.swift` (plugin registration, link forwarder, quick actions),
  `CaptureIntents.swift`, Info.plist quick actions, SceneDelegate handling. B-800 (deep-link
  multicast).
- `c62423f8` Android: `ACTION_SEND` filter + `MainActivity` rewrite, `shortcuts.xml`. Not compiled.
- `a8c1d26d` e2e `e2e/tests/quick-capture-links.spec.ts` (5 tests).
- `604bee4c` Swift probe `tools/probes/phone-capture/capture-queue-probe.swift` (all pass) and a
  cross-language file-format test.
- `d5c93515` B-801 (plugin proxy as thenable: the drain never ran on the Simulator), DEBUG launch
  arguments, `tools/probes/phone-capture/sim-run.sh`.
- `51b05e3f` B-802 (Save under the iOS keyboard): buttons above the field; Simulator evidence in
  `tools/probes/phone-capture/screenshots/` (fixture text only).
- Docs: guide, ADR 033, PLAN.md §14/M5, features.md (this commit).

## Simulator verification (iPhone 17e, iOS 27 SDK, Xcode 27.0, 2026-10-04)

`UDID=… OUT=… tools/probes/phone-capture/sim-run.sh`, fresh install, `screenshots/run.log` and
`dumps.jsonl`:

| What | How it was driven | Result |
|---|---|---|
| Cold `nooklet://capture?text=` with no graph | `-NookletDebugOpenURL` (simctl openurl stops at an "Open in nooklet?" prompt nothing can tap) | capture screen pre-filled, no-graph notice (shot 1) |
| Text kept through set-up | driver taps "Just this device"; relaunch with `nooklet://capture` | text back on the capture screen (2b) |
| Intent with the app closed | `-NookletDebugEnqueue … -NookletDebugExitAfterEnqueue YES`: runs `AddToNookletIntent.enqueue` and exits before the web view | file in `Application Support/captures/` |
| Drain on launch | plain launch | block in today's journal, folder empty (4) |
| Drain on resume | app backgrounded (Settings opened), file written into the container, app foregrounded | `[title](url)` block appended, folder empty (5) |
| Quick actions | `-NookletDebugQuickAction sh.nooklet.app.{search,today,capture}`: the same `QuickActions.handle` the long-press calls | /search, /journals, /capture (6a, 6c) |
| Open nooklet to add | `-NookletDebugOpenToAdd` (the link the intent forwards) | capture screen pre-filled (7a) |
| Link with url+title | `-NookletDebugOpenURL` | `[An article](https://example.com/a)` (7b) |

Not verified: a real long-press on the Home Screen icon, a warm link from another app (needs a tap
on iOS's prompt), running the App Intents from Shortcuts/Siri/Spotlight/Action Button, anything on
a physical iPhone, Android (no JDK/SDK here: not even compiled).

Swift queue writer outside the app (`capture-queue-probe.swift`, macOS): 14 checks, all pass;
sample file `{"created_at":"2026-10-04T07:46:40.123Z","text":"…"}`.

## Checks (2026-10-04, at 0ff52f2c)

- `pnpm -r typecheck`: clean. `pnpm exec biome check --write .`: no fixes, only pre-existing warnings.
- `pnpm test`: core 506, plugin-api 17, server 951, web 1784 (204 files), tools 10; all pass.
- `pnpm e2e` (full, port 6490, retries off): 859 passed, 1 failed, 6 skipped. The failure was
  `[webkit] webkit-refresh-focus.spec.ts:127` timing out inside an API seed POST after 38.3 minutes
  of wall time on a 30 s test (the run stalled outside the app; it is not a capture path). Alone:
  6/6 pass; that test `--repeat-each 5`: 5/5 pass. Treated as an environment stall, not a bug.
- Release Simulator build: succeeds (DEBUG hooks compiled out).
- `node tools/leak-check.mjs --tree`: clean.

## Decisions

- Pre-fill only for links; the App Intent is the only silent write (ADR 033 §2–3).
- Queued captures land on the journal day of `created_at`, not drain day.
- Own native code, no third-party Capacitor plugins (ADR 033 §6).
- A kept no-graph draft is merged with a later prefill (draft, newline, prefill) until saved or
  cancelled; seen on the Simulator as the draft text appearing above later prefills.

## How to resume

Read this file and ADR 033; `git log --oneline` on the branch. To re-run the Simulator check:
`pnpm ios:sync && UDID=<your sim> OUT=<dir> tools/probes/phone-capture/sim-run.sh`, then
`pnpm ios:sync` again (the script injects a driver into the gitignored `public/index.html`).
