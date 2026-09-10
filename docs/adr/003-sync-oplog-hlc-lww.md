# ADR 003: Sync = op log + hybrid logical clocks + per-field last-writer-wins, server validates the tree

Date: 2026-09-10. Status: accepted.

## Decision

- Every write anywhere (editor, HTTP API, MCP tool, markdown import) is a list of ops:
  `page.create|rename|prop|delete`, `block.create|place|text|prop|delete`. An op targets one
  entity and one independently mergeable field and carries a hybrid logical clock (HLC).
- Each field is a last-writer-wins register keyed by HLC. Block placement `(page, parent, order)`
  is one field so a move is atomic. Sibling order is a fractional index string; equal keys
  tie-break on block id.
- The home server is the single validator: it applies pushed ops in arrival order, assigns a
  `server_seq`, rejects a move that would create a cycle in its own state, and emits a corrective
  `block.place` op with a newer HLC. Clients never rebase; a transient cycle renders under an
  "Unplaced" pseudo-node for one round trip.
- Protocol: `POST /sync/push`, `GET /sync/pull?since=seq`, `GET /sync/snapshot`, plus a
  WebSocket "poke". Idempotent, resumable, works through a service worker.
- State tables are a pure function of the op log; `rebuild()` replays the log and must reproduce
  the state. Property tests simulate N devices with partitions and assert convergence.

## Why

- Compared to Yjs (no tree type, y-indexeddb unmaintained), Automerge (no move op), and Loro
  (correct movable tree, but a 1 MB gzipped WASM and 0.x sync protocol), a hand-rolled log on
  SQLite is smaller, fully inspectable, and sufficient for a single user on several devices.
  Workflowy, Trilium, SiYuan, Anytype, and Logseq DB all converged on block-level op logs.
- Because ids and ops are data, per-block text CRDTs (Loro/Yjs bytes in a `block.text.crdt` op)
  can be added later without migration if live co-editing is ever wanted.

## Consequences

- Concurrent edits to the same block's text on two devices resolve last-writer-wins in v1; a
  3-way text merge on the client (diff-match-patch) is the planned v1.1 improvement.
- Device clocks more than 60 s ahead are rejected with a visible error rather than accepted.
