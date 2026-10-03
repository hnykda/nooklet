# Progress: local-only graphs under ADR 025 (B-611, B-612, B-619)

Owner's next-test items 8/9 (graph switcher, local-only on the phone). Branch:
`worktree-agent-ad349bb7b38028773` (worktree `agent-a349640cdbbaa6d03`), based on `main` at `38e17a6`.

Scratch setup used throughout: `tools/probes/sweep-devices/serve.sh <scratch>/d1 6335`, and
`node tools/probes/sweep-devices/host-proxy.mjs 6336 6335 nooklet.sweep.test apps/web/dist` (a
same-origin stand-in for the Capacitor shell). Probes for this work are in `tools/probes/local-graphs/`.

## Status

- [x] Reproduced B-612 (probe `sweep-devices/local-then-server.probe.ts`, 1/1 runs: switcher lists
      only "Remote graph" after adding a server graph).
- [x] B-619 narrowed down, cause confirmed (below).
- [ ] B-611: cause confirmed with a deterministic test (in flight).
- [ ] Fixes, tests, migration, verification, Simulator run.

## B-619: cause (confirmed)

`tools/probes/local-graphs/relaunch-loss.probe.ts` (emulated Capacitor, "Just this device", fill
today's draft, Enter, Escape, reload at once): **lost in 9 of 10 runs** (much more often than the
sweep's 1 of 3), 0 of 9 with 300/1000/3000 ms before the reload (`LG_SETTLE_MS`). Warming the replica
up first (`LG_WARM=1`) changes nothing (4 of 4 lost), so it is not the first-ever page load.

What happens: at the moment of the reload the note is shown as a `.vr-draft-line` (a line Enter
closed that the draft has not written yet), the B-247 journal holds **no** batch for it, and the
replica has no block with that text (checked through a temporary `query()` hook, since removed). The
note is nowhere in OPFS afterwards (`LG_DISK=1` reads every OPFS file raw; positive control at
1000 ms finds it). So nothing was ever written: `VirtualJournalDay.commit()` awaits `prepare()`
(the journal template plus a pool of HLCs: worker round trips, started on focus) before it can build
any op, and the page unloads first. B-247's copy cannot help: it copies ops, and there are none yet.
Same class as B-247 (text that only lives in the page), one step earlier. B-595's draft hand-off
itself is fine. A block typed into the day's tree and reloaded at once survives (0, 550, 800 ms:
`relaunch-whole-db.probe.ts`, 4 of 4 each), because that path does have ops to copy.

## Audit of per-graph client state (in flight)

| State | Where | Per graph before? | Action |
|---|---|---|---|
| Graph list, active id | `localStorage` `nooklet.graphs`, `nooklet.activeGraphId` | n/a (the list itself) | — |
| Replica file | OPFS sahpool `/nooklet-<entryId>.sqlite3`; `/nooklet.sqlite3` with no entry | yes (M4), except no-entry | B-612: the no-entry replica becomes a real entry |
| Writer lock | Web Lock `nooklet-db-writer[:<entryId>]` | yes | — |
| Unapplied-ops journal (B-247) | `localStorage` `nooklet.unapplied-ops.v1:<owner>:<seq>` | **no** | B-611 |
| Native checkpoint (B-573 C) | `@capacitor/filesystem` `Data/nooklet-checkpoint.sqlite3` | **no** | B-611 |
| Owner locks | Web Lock `nooklet.unapplied-ops.owner:<owner>` | per page load, fine | — |
| Shelf | `sessionStorage` `nooklet.shelf.state` (block/page refs) | **no** (survives the switch's same-tab navigation) | scope it |
| Reference filters | `localStorage` `nooklet.referenceFilters` keyed by page name | no | reading preference only, left |
| Journal title format | `localStorage` `nooklet.journalTitleFormat` | no | a display preference, left |
| Theme, appearance, focus log, command MRU, live consent, window id | `localStorage`/`sessionStorage` | no | device/UI preferences, not graph data, left |
| Service worker caches | Workbox runtime caches | keyed by URL, which carries `/g/<slug>` | — |
| IndexedDB | none used directly; `@capacitor/filesystem`'s web fallback only | — | — |
| GraphMismatchView "Discard the local copy" | removes **every** OPFS entry | **no**: wipes all graphs' replicas | new bug, see below |

## BUGS.md updates to fold in

(Written as the work lands.)
