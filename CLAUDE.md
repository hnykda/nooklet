# Working notes for Claude

nooklet is a local-first outliner in the spirit of Logseq, built so AI agents are first-class
users rather than an afterthought. Read `README.md` for what it is and `docs/PLAN.md` for scope.

The rule behind everything below: **nothing important may exist only in a chat transcript.**
Sessions get compacted and lost. If a decision, an assumption, a bug, or a measurement matters
beyond the next few minutes, it goes in a file, in the same commit as the work it describes.

---

## Where things go

| Put it here | When |
|---|---|
| `docs/BUGS.md` | Anything reported from real use, anything you notice in passing, anything you fix. **Log it before you start fixing, not after.** |
| `docs/PLAN.md` | Scope, milestones, non-goals. The synthesis document — update it when scope actually moves. |
| `docs/adr/NNN-*.md` | A decision with alternatives that were rejected. Records *why*, including what it costs. |
| `docs/spec/*.md` | Behaviour precise enough to implement or test against (grammar, SQL schema, API/plugin types, MCP tools, keymap). |
| `docs/research/NN-*.md` | Findings with sources, dated. Kept as written rather than updated in place — it's a record of what was known when. |
| `docs/proposals/NNN-*.md` | A worked-through "should we do X" that isn't a decision yet. |
| `docs/progress/<slug>.md` | Where a long task stands *right now*: done (commit hashes), in flight (which files, what state), next steps in order, decisions, how to resume. Updated after every meaningful step, not at the end — a session or agent can be cut off mid-task, and what is only in its head is gone. |
| `tools/probes/` | Throwaway programs that settled a factual question. Keep them — a claim you can re-run beats a claim you remember. |

Non-goals are as load-bearing as goals: **no flashcards, no kanban boards, nothing fancy.**

---

## Assumptions

Write them down, and say which are verified. An assumption that turns out wrong is cheap to fix if
it's recorded and expensive if it lived in someone's head.

- If a claim came from a doc, blog post, or issue, cite the URL and what it said.
- If you verified it yourself, say how, and leave the probe behind.
- If you could not verify it, say so explicitly in a "Still unverified" section. `docs/research/10`
  has one; copy that shape.

Real example from this repo: a widely-cited claim said WKWebView caps OPFS files at 10 MB, which
would have invalidated the whole client storage design. `tools/probes/wkwebview-opfs.swift` wrote
1.2 GB into one file and disproved it. That probe is worth more than the paragraph it replaced.

---

## Testing

**A green unit suite is not evidence that the app works.** This repo learned that the hard way:
six defects — the client having no API credential, editing dying after one keystroke, no resource
ever refetching after a write — all shipped past 1,180 passing tests, because none of those tests
launched a browser against a production build served by a real server.

- `pnpm -r test` — unit and component tests. Fast, run constantly.
- `pnpm e2e` — Playwright, real Chromium, real `nooklet serve`, real production build. **This is
  the suite that catches integration bugs.** Run it before claiming a UI change works.
- `pnpm nooklet verify` — replays the entire op log and diffs it against live state. The single
  best regression detector in the system; run it after touching sync, ops, or schema.
- `pnpm -r typecheck` and `pnpm exec biome check --write .`

When you fix a bug, add the test that would have caught it, and name that test in the `docs/BUGS.md`
entry. "Fixed" without a test means "believed fixed" — say so if that's what it is.

---

## Verify, don't trust

Independently re-run anything you're about to report as working. Where a real graph can be used,
use one — bugs hide in the shape of real data (952 pages, mixed Czech/English, heavy task markers),
not in fixtures. Import with `pnpm nooklet import <logseq-graph-dir> --data <dir>`.

Report outcomes faithfully. If tests fail, say so and show the output. If something is unverified
or was skipped, say that. Don't describe a plan as finished when it's believed-finished.

---

## Code conventions

- TypeScript throughout, latest standards, no backward-compatibility baggage. Biome for lint/format.
- Comments explain *why*, especially where the obvious approach is wrong. Several bugs above were
  caused by code that looked correct; the fixes carry comments saying what breaks otherwise.
- Respect the seams. `packages/core` is platform-free except for one Node driver behind the
  `SqlDriver` interface — keep it that way, it's what keeps a native port cheap. The command system
  is host-agnostic and ships its own fakes. The editor's "keys → ops" boundary is pure.
- One `defineOp` registry drives HTTP routes, OpenAPI, MCP tools and the typed client. Add
  capabilities there, not in a parallel path.
- The server's single write path is `serverApplyOps`. Don't bypass it.

---

## Architecture in one paragraph

SQLite is the source of truth on the server and in every client. Every write becomes an op in an
append-only log with a hybrid logical clock; fields merge last-writer-wins and sibling order uses
fractional indexing, so devices reconcile without a lock. The server validates tree structure and
emits corrective ops. Markdown files are a lossless mirror with stable `^id` suffixes — never the
sync medium, just a greppable copy you can walk away with. Details in `docs/adr/`.

---

## Working style

- Keep going through a milestone; don't stop to ask for confirmation on each step.
- Prefer the smallest change that fixes the actual cause. Two bugs here were "fixed" by reasoning
  and turned out to be something else — get evidence first (a probe, a failing test, a DOM dump).
- When you find a second bug while fixing the first, log it rather than silently expanding scope.
