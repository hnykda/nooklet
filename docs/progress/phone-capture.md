# Progress: phone capture, proposal 006 Phase 1

Task: build Phase 1 of `docs/proposals/006-capture-from-anywhere-on-the-phone.md` (accepted by the
owner 2026-10-04): `nooklet://capture` links, Home Screen quick actions / Android App Shortcuts, the
iOS "Add to nooklet" App Intent with a native queue the web app drains, the Android share target.

## Done

- (nothing committed yet)

## In flight

- Web layer: link parsing/formatting (`apps/web/src/capture/capture-link.ts`), drain
  (`capture-queue.ts`), app-level link handler, capture screen pre-fill / no-graph notice.

## Next, in order

1. Web layer + unit tests, commit.
2. iOS native: queue writer, Capacitor plugin, App Intents, quick actions; xcodebuild for the
   Simulator (iPhone 17e, UDID CEA113D0-9B86-44EE-B77D-03F1E7903D9C only).
3. Android: share intent filter, shortcuts.xml; Gradle build if the toolchain exists.
4. e2e for `/capture?text=` and `?url=&title=`.
5. Simulator verification, screenshots in `tools/probes/phone-capture/` (fixture data only).
6. Docs: guide, ADR 033, PLAN.md M5. Full checks.

## Decisions

- See ADR 033 once written.

## How to resume

Read this file, `git log --oneline` on the branch, then continue with "Next".
