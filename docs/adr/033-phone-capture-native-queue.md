# ADR 033: Phone capture through `nooklet://` links and a native queue drained by the web app

Date: 2026-10-04. Status: accepted (proposal 006 Phase 1, accepted by the owner; implemented on
the phone-capture branch, `docs/progress/phone-capture.md`).

## Context

Proposal 006 asks for capture from outside the app: links, Home Screen quick actions, an "Add to
nooklet" action for Shortcuts / Siri / Spotlight / the Action Button, and Android's share sheet.
Everything ends as a block at the end of today's journal, written locally through
`quickCaptureService` and synced.

Two constraints shape it. The owner signs with a free Personal Team, which limits App IDs and may
not allow App Groups (unverified), so app extensions are expensive. And the replica lives inside
the web view (SQLite WASM on OPFS), so native code that runs without the web view cannot write a
block.

## Decision

1. **One funnel: `nooklet://` links.** Every native entry point that opens the app becomes a link:
   `nooklet://capture?text=&url=&title=`, `nooklet://today`, `nooklet://search`. Quick actions
   (iOS `UIApplicationShortcutItems`, Android `shortcuts.xml`), the "Open nooklet to add" intent
   and Android's `ACTION_SEND` are each a few lines of our own native code that hand over a link:
   on iOS through Capacitor's `ApplicationDelegateProxy` (so it arrives as `appUrlOpen`, or as
   `getLaunchUrl()` on a cold start), on Android by rewriting the intent before Capacitor reads it.
   The web side has one handler (`capture/AppLinkHandler.tsx`) that navigates to `/capture?…`,
   `/journals` or `/search`; `/capture?…` is also the web and e2e entry.
2. **A link only pre-fills.** The capture screen writes nothing until the person taps Save.
   Anything can open a `nooklet://` link, so a silent-write link would let any web page add to the
   journal.
3. **"Add to nooklet" writes a native queue, not the replica.** The App Intent lives in the app
   target (no extension) and runs in the app's process without the web view. It writes one JSON
   file per capture to the app's own `Application Support/captures/<uuid>.json` (`text`, `url`,
   `title`, `created_at`) and returns. iOS runs it only on the person's own action (Shortcuts,
   Siri, the Action Button), so it is the one entry that writes without a confirmation tap.
4. **The web app drains the queue** (`capture/capture-queue.ts`) on launch and on every resume,
   through a small Capacitor plugin in the app target (`NookletCapture`: list, read, remove; no
   write). Rules: oldest `created_at` first; each capture lands on the journal of the day it was
   made, with that time as `createdAt`; the block id is derived from the capture's uuid and time,
   and a capture whose block already exists (deleted or not) is only removed; a file is removed
   only after `applyOps` resolved with nothing rejected; a failed or rejected write stays queued
   and does not stop the rest; a malformed file is skipped and kept; one drain at a time, and a
   drain requested mid-drain runs once more afterwards. No drain without a graph or on a graph
   mismatch; the files wait.
5. **No graph yet:** the capture screen says so, keeps the text in `localStorage`, and offers
   "Set up a graph". The text comes back on the capture screen afterwards.
6. **Our own native code, no third-party plugins.** Each piece is under ~60 lines (quick actions,
   intent, queue, plugin, Android rewrite). Third-party Capacitor plugins for app shortcuts and
   share targets exist, but each would add a dependency for less code than it replaces, and none
   covers App Intents.

## Alternatives rejected

- **An App Intents extension, or a Share Extension, with an App Group.** Each extension is another
  App ID that expires with the free account, and the queue would need an App Group, which a
  Personal Team may not be able to use. Kept for Phase 2, after a probe.
- **The intent writes straight to the server.** Online only, needs a token in native code, and
  bypasses the single local write path.
- **The intent opens the app and writes there.** That is "Open nooklet to add"; it is offered, but
  the Action Button's value is capturing without the app coming to the front.
- **A link that writes immediately** (`nooklet://capture?…&save=1`). A silent write from any web
  page.
- **Drain into today's journal at drain time.** A note captured on Monday evening and drained on
  Tuesday belongs to Monday; the capture keeps its own time.
- **Delete the file before writing.** A crash between the two loses the capture; with the
  deterministic block id, writing first and deleting second is safe to repeat.

## Costs

- A capture made with the app closed is invisible until nooklet is next opened, and does not sync
  until then.
- `Application Support` is not shared with any extension; Phase 2's Share Extension needs either an
  App Group or its own path.
- The block id is derived (time + 25 bits of the uuid), not random; a collision needs another
  block created in the same millisecond with the same 25 bits.
- DEBUG builds read a few launch arguments (`-NookletDebug…`) so the Simulator can run these paths
  headless. Launch arguments cannot be set by a link; Release builds do not compile them.
- Found while building: one deep-link listener must serve every subscriber (B-800); a Capacitor
  plugin proxy must never be returned from a promise (B-801); the capture screen's buttons must be
  above the field on iOS (B-802).
