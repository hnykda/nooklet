# ADR 013: AI parity is a first-class requirement — undo and assets in MVP, live UI control designed for M2

Date: 2026-09-10. Status: accepted (tool additions); live-UI-control is a design direction for
M2, not yet an implementation decision.

## Decision

1. **`batch_undo` and `asset_upload` join the v1 MCP/API tool set** (18 tools total, alongside
   the 16 in `docs/spec/mcp-tools.md`), not deferred to a later milestone:
   - `batch_undo(batch_id)` reverses every entity a `changes.batch_id` touched, using that
     batch's own before/after JSON (already recorded by every write per ADR 008). It is itself a
     new, separately-audited batch — undoing an undo is calling `batch_undo` again on the new
     batch's id, with no special-cased "redo" concept needed.
   - `asset_upload(data, filename, mime_type)` (base64 or a pre-signed upload, exact wire shape
     left to the M1 implementation) creates an `asset` row and returns an id an agent can embed
     as a normal markdown image (`![alt](assets/<id>.<ext>)`) in the very next `block_update`/
     `page_append` call.
2. **The live running client should be observable and controllable by an agent, not just the
   underlying graph.** Beyond the headless data API (which works whether or not anyone has the
   app open), a second, distinct capability is designed for M2: while a human has a client
   instance open, an agent should be able to ask "what page/block is currently focused, what's
   selected" and issue "run this command" (reusing the ADR 009 command registry — the same
   `Command` objects the palette and slash menu already call), over the same live connection the
   sync protocol (ADR 003) already keeps open between server and client. This is not implemented
   yet; `docs/research/09-live-ui-control.md` explores prior art and a concrete design, to be
   turned into its own ADR once M2 starts.

## Why

The user's explicit goal is that vrite treats AI agents as first-class users of the product, not
a headless API bolted onto a human-first editor. Two gaps surfaced by checking the finished
`docs/spec/mcp-tools.md` against that bar:

- Every write is already grouped into an audited batch with full before/after state (ADR 008),
  specifically so an agent's mistake could be undone — but no tool actually called it. An agent
  that edits the wrong block currently has no atomic way to say "undo that"; it has to
  reconstruct the reverse edit itself from memory, which is exactly the friction a human editor's
  Cmd+Z does not have.
- The `asset` table exists in the schema (ADR 002/`sql-schema.md`) but nothing in the API creates
  a row in it, so an agent cannot attach an image or file it generated or fetched, something a
  human can do by simply pasting one into a block.

The live-UI-control idea goes further: most competitors' AI integrations (per
`docs/research/02-competitors.md`) are headless, reading and writing a backend the human's UI
happens to also read from. Letting an agent see and drive the actual screen a human is looking
at, live, is a meaningfully different and differentiated capability worth designing properly
rather than retrofitting later — and the architecture already has the two pieces it would be
built from (a live server-client connection, and a command registry), which is why this is
being recorded now even though it isn't scheduled until M2.

## Consequences

- `docs/spec/mcp-tools.md` needs two new tool definitions in the same rigor as its existing 16
  (full Zod schema, HTTP mapping, example, error cases) before `batch_undo`/`asset_upload` are
  implemented — tracked as follow-up work, written once the in-flight M1 op-registry
  implementation lands, to avoid destabilizing it mid-flight.
- `changes.before_json`/`after_json` must be sufficient to fully reconstruct prior state for
  every entity type `batch_undo` might touch; if a future write type's audit summary turns out to
  be lossy (e.g. it stores only field names, not fully old values), that write path needs
  revisiting before `batch_undo` can be trusted for it.
- The live-UI-control design must work whether the client is a plain browser tab, a Capacitor
  app, or a desktop shell (Tauri, or Electron if ever used) — the point of hanging it off the
  existing sync connection is that packaging is irrelevant to it.

## Amendment (2026-09-10, same day): re-sequenced as M1.5, not gating M1/M2

Still MVP-scope, but no longer required for M1 to be considered done or for M2 (the web client,
now the priority) to start. `batch_undo`/`asset_upload` become milestone M1.5 in `docs/PLAN.md`'s
table: implemented once M1's core (already in flight) lands, whenever convenient, without
blocking the move to the web client the user wants to reach quickly.
