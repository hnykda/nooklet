# 002 — Pending edits must survive a reload

Proposal, 2026-09-13, against tree `febfc23` (branch `m9/clipboard-sync`). Status: **the cheapest
safe option (B below) is implemented**; whether to keep it or move to C is the open question for
the owner. Kept as written rather than updated in place.

The question: an edit the user has seen on screen can vanish when the page reloads, closes or
crashes shortly after (`docs/BUGS.md` B-247). What should make it durable, and at what cost?

---

## 1. What is actually lost, measured

A local write travels: keystroke → editor buffer → 500 ms text debounce (or the `pagehide` flush)
→ `applyOps` on the main thread → a Comlink message to the DB worker → `SyncClient.applyLocal`,
which writes local state and the `pending_op` outbox in one SQLite transaction → 300 ms push
debounce → `POST /sync/push`.

Durable means "past `applyLocal`". Everything before it lives in one JavaScript realm or the other
and dies with the document. Two windows, measured with `tools/probes/replica-busy-window.mjs` on a
copy of the owner's graph (952 pages, 18.6k blocks; Chromium; machine shared with other agents, so
two runs differ):

- **The worker's queue.** Every SQLite call is synchronous inside the one worker, so a message
  waits for whatever runs before it. Longest single blocked stretch: cold first load 1.8–2.1 s,
  warm reload 0.2–0.3 s, a `[[` popup search 0.4–0.8 s, plain typing on a 201-block page
  0.1–1.6 s. An edit handed over during such a stretch is a queued message; unload kills it.
- **The unload itself.** Reloading N ms after typing into a small page, no artificial load:
  0 ms kept, **100 ms lost, 300 ms lost**, 700 ms kept, 1,500 ms kept (lost = gone from the
  replica, not merely unpushed). The `pagehide` flush posts its message while the document is
  being torn down; whether the worker runs it first is a race it loses right after a load.

A third window turned up while measuring, fixed separately as B-301: an op already durable in
`pending_op` was not pushed after a reload until the next local write, because nothing at startup
scheduled a push.

## 2. Options

### A. Flush harder at unload

Call `flushPendingEdit` from `beforeunload` as well as `pagehide`, or `await` the worker there.

Rejected: it does not touch the cause. Unload handlers cannot wait for a promise, and a message
posted from them still lands behind whatever the worker is doing. Measurements above already
include the existing `pagehide` flush.

### B. A synchronous main-thread copy until the worker answers — implemented

`db/unapplied-ops.ts`. `db/client.ts#applyOps` writes each batch to `localStorage` (synchronous:
done before `applyOps` returns) and removes it when the worker's answer arrives. A batch still
there at the next start is replayed through a new worker method, `replayLocalOps`, which skips op
ids the replica's `op` table already has (a batch whose answer was lost with the page is not
pushed twice) and otherwise runs the normal `applyLocal`. Replaying is otherwise safe to repeat:
op ids are HLCs, fields merge last-writer-wins, the server records a duplicate id as accepted.

Two tabs share `localStorage`, so each page load holds a Web Lock named after itself; a tab only
replays batches whose owner lock is no longer held (the browser releases it when that document
is gone). A second replay pass 5 s after start covers an old document whose lock is released late.

Costs and limits:

- One `JSON.stringify` + `setItem` per `applyOps` call on the main thread — a typing flush is a
  few hundred bytes every 500 ms; not measured as a cost.
- `localStorage` quota (~5–10 MB per origin): a batch that does not fit (a paste of thousands of
  blocks) is not copied and is exactly as durable as before; a warning is logged.
- Covers only what reached `applyOps`. Keystrokes still inside the editor's 500 ms debounce are
  covered only because the `pagehide` flush calls `applyOps` synchronously — which it does. A
  crash (renderer killed) inside the debounce, with no `pagehide`, still loses up to 500 ms of
  typing.
- `applyOps` promises resolve exactly as before; nothing waits on storage.
- Verified in Chromium only (`e2e/tests/reload-durability.spec.ts`, 15 of 15 runs; with the copy
  disabled the two B-247 tests fail 4 of 4). WebKit/WKWebView (`localStorage` and Web Locks exist
  there, the lock-release timing is unmeasured) is not.

### C. Make the worker's queue not matter: apply on the main thread

Run the write transaction on the main thread (a second SQLite connection, or the whole replica),
keeping the worker for sync and heavy reads.

Not done: `opfs-sahpool` allows one connection per database file (research/08 §1.3), so a second
connection would need another VFS (`opfs` with its own locking, slower, and not in every engine)
or moving the replica out of the worker, which is what the worker split exists to avoid (long
queries freezing typing). This is the real fix for "an edit waits seconds to become durable" and
a design decision in its own right.

### D. Make the worker's queue short

Split long worker tasks (bootstrap in chunks, search with a `LIMIT` and a yield between
statements) or give writes a second worker.

Worth doing for responsiveness regardless, but it narrows the window instead of closing it: an
unload still races the last message, as the 100–300 ms measurements show with an idle worker.

### E. `sessionStorage` instead of `localStorage` in B

Survives a reload, is per-tab (no lock needed), but not a tab close or a browser crash, which are
the same loss. Rejected as strictly weaker for the same code.

## 3. Recommendation

Keep B: small, contained in `db/`, no schema change, and it closes the measured loss. Revisit C
if the durability window itself becomes the complaint (an edit acknowledged on screen that another
device does not see for seconds) — that is a latency problem B does not address.

## 4. Still unverified

- WebKit / the Tauri WKWebView: whether the old document's owner lock is released before the
  reloaded document asks (if not, the 5 s pass or the next start replays the batch).
- Capacitor (mobile): whether `localStorage` writes made during a backgrounding kill are flushed
  to disk by the WebView before the process dies.
- The main-thread cost of the copy on a large paste (not measured).
