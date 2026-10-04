# ADR 015: Live UI control — a dedicated `/ui/live` socket, the existing command registry, consent by default-asymmetry

Date: 2026-09-10. Status: accepted (design); implementation lands with M2's client.

Follows from ADR 013's forward-looking item. Full survey and rationale:
`docs/research/09-live-ui-control.md`.

## Decision

An agent can observe and drive a *currently-open* client window, in addition to (never instead
of) the headless 18-tool data API, which keeps working with no client open at all.

1. **Transport: a second, dedicated WebSocket (`/ui/live`)**, not a multiplexed extension of the
   sync "poke" socket (ADR 003). The sync channel is mandatory, always-on, per-device, and
   protected by property tests; this one is optional, per-window, opt-in, and needs genuine
   request/response semantics. Keeping them separate buys one clean invariant: **the socket being
   open *is* the feature being active**, which is exactly the fact the consent badge displays.
2. **Identity is a `window_id`, not a `device_id`.** One device routinely has several tabs open
   (the client already elects a writer tab via `navigator.locks`). Each window mints a random
   `window_id` in `sessionStorage`; the server keeps an in-memory-only table of live sessions —
   ephemeral by nature, never persisted, never something `rebuild()` reproduces.
   Resolution policy differs by risk: reads (`ui_get_state`, `ui_list_windows`) default to the
   most-recently-active window and return the other candidates alongside; `ui_run_command` with
   several windows open and no `window_id` returns `ambiguous_window` rather than guessing, since
   acting on the wrong window is materially worse than reading the wrong one.
3. **Observed state is the client's existing `WhenContext`/`CommandContext`, serialized** — page,
   zoom root, focused/selected blocks, cursor offset, viewport, open panel or dialog. nooklet does
   not build a second "what is the user doing" model for agents; it exposes the one the command
   dispatcher already computes before every keystroke.
4. **Actions are the existing `Command` registry (ADR 009), invoked by id + args**, with each
   command's own `when` clause and scope check enforced exactly as for a human. Only two new
   commands are needed (`nav.openPage`, `nav.revealBlock`) for the one thing no keybinding-driven
   command does today: jump straight to a known page or block with no picker.
5. **New MCP surface**: `ui_list_windows`, `ui_get_state`, `ui_run_command`, plus thin
   `ui_navigate`/`ui_highlight` wrappers for the two constant cases. Tools, not resources, are the
   day-one surface — MCP 2026-07-28 *does* natively support subscribable resources, and a
   `nooklet://ui/window/{id}` resource should be added in parallel later, but Claude Code currently
   surfaces resources only as manual `@mentions`, not something an autonomous loop polls.
6. **Consent is asymmetric by default, and visible rather than hidden.** Two independent,
   device-local, unsynced toggles: *"let agents view this window"* defaults **on** (read-only, no
   write risk, and it is what makes the feature discoverable); *"let agents control this window"*
   defaults **off**, one deliberate opt-in per window. A persistent status-bar badge shows
   off/observed/controlled and opens a recent-activity log. Anything a remote command touches gets
   a distinct flash attributed to the agent, in a different colour from the human's own accent.
   Since 2026-09-13 (B-540) the badge is a muted icon button rather than a text pill, its sentence
   moved to the tooltip and accessible name — except that *controlled* stays drawn in the agent
   accent on a tinted ground, because a consent signal for "an agent can act here" must not blend
   into the chrome.
7. **A new `ui:control` capability flag**, orthogonal to `read`/`write`/`admin`. A broad `write`
   token for headless data cleanup should not thereby be able to drive someone's screen, and a
   `read` + `ui:control` token is a coherent "can watch and point at things, cannot edit" grant.
8. **No blocking confirmation on remote commands.** The human is by construction looking at the
   screen when this channel is live, and everything destructive here is soft-deleted and
   reversible, so destructive ops surface a toast with one-tap Undo via `batch_undo` (ADR 013)
   instead of a dialog per call. `page_delete`'s existing hard `requiresUserInteraction` gate is
   unchanged — that one is page-level and harder to casually undo.

## Why

Most competitors' AI integrations are headless: they read and write a backend the human's UI also
happens to read. Letting an agent see and drive the actual screen someone is looking at, live and
attributably, is a genuinely different capability, and the architecture already contains both
halves it needs — a live server-client connection and a declarative command registry — so this is
cheap to build and expensive to retrofit.

The closest real precedent is **VS Code's Language Model Tools API plus Copilot Chat's editor
context**: the only surveyed system that is also "an app with its own command registry and live
focus/selection model, exposed to an LLM over a semantic channel," including a `when`-gated
availability model nearly identical to nooklet's own. Figma's agent canvas access is the second
template (structured operations against the document model, gated by an explicit capability).
Home Assistant's WebSocket API — which the user already depends on daily — is the transport
pattern: subscribe for state, call services for actions, confirm effects by watching the stream.

Browser automation and "computer use" were rejected as the wrong shape: they exist to break into
applications from the outside, paying in screenshots, vision tokens, pixel ambiguity, and a
documented 2–5 seconds per action. nooklet owns both ends of this connection, so it can have a
typed JSON snapshot and a command id in tens of milliseconds instead.

## Consequences

- `docs/spec/commands-and-keymap.md` needs `nav.openPage`, `nav.revealBlock`, and a
  `Command.remoteInvocable` flag added before implementation.
- Client-side op emission needs an origin/actor override so remotely-triggered local edits are
  attributed to the agent, not the human, in the audit trail.
- `ui_run_command` needs its own rate-limit bucket, separate from `write`'s — a live collaboration
  burst has a different natural rate than a batch import.
- Whether `ui:control` needs a third, narrower tier is left open; per-command scope checks may
  already give a fine enough boundary.
- A desktop shell could later add OS-level extras a browser tab cannot have (raising the window
  when a remote command fires), through ADR 005's existing `platform` adapter. Explicitly optional
  and not required by this design.

## Amendment (2026-10-04, B-708): off and hidden by default on a phone

Owner: "agents control should probably be off for mobile? that doesn't make much sense."

**Change.** On the Capacitor app and on any touch-only device (what the command system already
calls `mobile`: an iOS/Android user agent, or a coarse pointer with no hover), "let agents view
this window" now defaults **off**, and the top-bar badge is not drawn while both switches are off.
Both switches are also in Settings → Agent access, on every device; on a phone that is where the
channel is turned on, and turning it on brings the badge back. A choice the device already stored
wins either way. Desktop behaviour is unchanged (view on, control off, badge always shown).
Code: `apps/web/src/live/device-default.ts`, `consent.ts#liveBadgeShown`.

**Why.** This channel exists for an agent working beside a window someone is looking at — the same
computer, the next terminal (§"Why" above). A phone is rarely that: nobody runs an agent next to
it, it is one more socket to hold open on a radio that sleeps, and the badge took a slot in a top
bar with little room. "Discoverable by default" (§6) was the argument for view-on, and it is
weakest exactly where the feature is least useful.

**What stays true.** "The socket being open *is* the feature being active" (§1): with view off,
`app/CommandLayer.tsx#LiveConnection` never calls `connectLiveSocket`, so the device opens no
`/ui/live` at all — checked by `e2e/tests/phone-ui.spec.ts` "B-708…" (Chromium and WebKit, iPhone
viewport with touch), which watches the page's WebSockets before and after the Settings opt-in. And
the badge is shown whenever an agent can see the window (§6): hiding it is tied to the switches
being off, never to the device alone.

**Cost.** Someone who does want an agent on their phone or tablet must find the switch in Settings.
A touch-screen laptop with a mouse attached reports hover, so it keeps the desktop default; an
iPad with a keyboard but no pointer gets the phone default.
