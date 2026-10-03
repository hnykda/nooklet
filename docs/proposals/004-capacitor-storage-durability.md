# 004 — Capacitor storage durability, without rewriting `SqlDriver`

Proposal, 2026-09-15, against the tree this session left (`docs/BUGS.md` B-573, the Capacitor iOS
work). Status: **A, B, and C implemented** (2026-09-15, same day, owner sign-off: "yeah, cool, so do
that" after ruling user-initiated clearing/uninstall out of scope). Kept as written rather than
updated in place, per this repo's convention for proposals — see `docs/BUGS.md` B-573 for the
implementation details and what is/isn't verified. D stays ruled out (§2.D), E stays parked.

## 1. The actual problem, precisely

Not "eviction someday under disk pressure" — that's real but secondary. The documented, specific
failure (`docs/research/08-mobile.md` §1.3, citing PowerSync's May 2026 survey) is:

> PowerSync reports OPFS access handles get closed when the app goes to the background, causing
> errors on resume → in Capacitor use the native SQLite plugin (or the IDB VFS), not OPFS.

`platform/capacitor.ts`'s own trailing doc comment already names this as a known, unmitigated gap.
This is routine, not rare — backgrounding a phone app happens constantly, unlike disk-pressure
eviction. Layered on top: WKWebView/Capacitor gets only 15%/20% of disk quota (vs. Safari's 60%/80%,
same doc), and `platform/capacitor.ts`'s `persist()`/`persisted()` are hardcoded to return `true`
without ever calling the real `navigator.storage.persist()` — so today's build gets none of the
protection that API exists to provide, for a storage backend (OPFS) that actively needs it.

The async-`SqlDriver` rewrite (touches `packages/core`, shared with the server) was the first answer
reached for, but it solves a different problem than the one above — "let queries call native SQLite"
is not the same goal as "survive backgrounding." Worth separating before picking a fix.

## 2. Options, cheapest first

### A. Wire the real `navigator.storage.persist()` — do this regardless
`platform/capacitor.ts`'s storage adapter is a no-op stub written under the assumption native SQLite
would land first (its own comment says so). It hasn't, so the stub is currently lying: the one API
that protects against *automatic* eviction is never actually called. Zero architectural risk, one
file, no interaction with anything else here. Does not touch the backgrounding-closes-the-handle
problem at all — orthogonal, not a substitute for B/C below.

### B. Catch-and-reopen the sahpool connection on resume
The single most targeted fix for the specific documented failure: listen for `resume`
(`platform.lifecycle`, already wired), catch the specific native error `sqlite-wasm-driver.ts`
would throw on the next query after a background/resume cycle, and reopen
`installOpfsSAHPoolVfs`/`OpfsSAHPoolDb` for the same file. No VFS change, no new dependency, no
driver change. Keeps OPFS as-is; only fixes "breaks after backgrounding," not "smaller quota than
native" or "IDBBatchAtomicVFS reads/writes go through more indirection."

### C. Periodic checkpoint to native storage, as a backstop — not the live driver
Keep OPFS/WASM SQLite as the interactive engine unchanged. Separately, on an interval or on `pause`
(already wired via `platform.lifecycle`), write a snapshot of the database out through
`@capacitor/filesystem` — real native app-sandbox storage, not WebView-controlled, not subject to
OPFS's eviction/closing behavior at all. This is the cleanest reframe of the actual goal: durability,
not "queries touch native SQLite." Doesn't fix B's resume-error UX by itself (the live OPFS
connection still needs B's reopen-on-resume to keep working *during* a session) — B and C solve
different halves: B keeps the session usable after backgrounding, C guarantees a recovery point if
OPFS itself ever loses data entirely (eviction, corruption, a resume that reopen-and-retry can't
save). Not a current dependency (`@capacitor/filesystem` isn't installed) — self-contained new
work, not a rewrite of anything existing.

### D. Swap the WASM VFS backend for Capacitor, to `wa-sqlite`'s `IDBBatchAtomicVFS`
**Ruled out — verified 2026-09-15, source-code confirmed (`wa-sqlite@1.0.0`, the only version
published).** It is fundamentally asynchronous, not a drop-in for the synchronous `Sqlite3Db`
contract `db/sqlite-wasm-driver.ts` requires. Evidence, directly from the package (downloaded and
inspected, not recalled from memory):

- The package ships two separate WASM builds — `dist/wa-sqlite.wasm` and
  `dist/wa-sqlite-async.wasm` (plus matching `.mjs` loaders) — and its own README states: *"an
  asynchronous build is required for asynchronous extensions."*
- `src/examples/IDBBatchAtomicVFS.js` (the `IDBBatchAtomicVFS` implementation itself) is written
  with `async`/`await` throughout — `async close()`, `async #xSyncHelper()`, every I/O path wrapped
  in `this.handleAsync(async () => { … await this.#idb.run(...) … })`.
- `src/VFS.js`'s base class defines `handleAsync(f)` with the doc comment: *"Handle asynchronous
  operation... This implementation will be overriden on registration by an Asyncify build."* —
  confirming in the library's own words that this VFS only functions when registered against the
  Asyncify build, and that registration is what makes the bridge async.
- Even the README's own top-level usage example is `await`-based throughout
  (`await sqlite3.open_v2(...)`, `await sqlite3.exec(...)`, `await sqlite3.close(...)`), not just
  for this VFS specifically.

No browser probe was run — this evidence is the library's own source and self-documentation, not a
secondhand claim, so a runtime probe would only re-confirm what's already unambiguous here (it
remains a legitimate thing to double-check empirically before ever depending on wa-sqlite for
something else, just not needed to settle *this* question). Conclusion: adopting `IDBBatchAtomicVFS`
does not avoid an async driver for Capacitor — it *is* one, just scoped to that one platform instead
of also touching the server. That's a real, smaller-blast-radius version of Option E, not a
sync-preserving alternative to it — evaluate it as "E, but Capacitor-only" if it's ever reconsidered,
not as a peer of A/B/C.

### E. Async `SqlDriver` everywhere (the original proposal)
Still the most general fix, and the only one that also improves the server/every-client story
uniformly — but the biggest blast radius (`packages/core`, the server's driver, every caller).
Per the earlier discussion in this session: worth it only if A–D turn out insufficient, since it
revisits a deliberate, documented architectural decision and deserves its own ADR-weight discussion,
not a bundled decision inside this durability fix.

## 3. Recommendation — implemented 2026-09-15

**A, B, and C are all implemented** — see `docs/BUGS.md` B-573 for exactly what changed and what's
verified vs. not (the short version: everything unit-testable is tested with fakes; the real
OPFS-closes-on-backgrounding trigger and an actual eviction-then-restore cycle need a real device,
which nothing in this environment can drive). **D stays ruled out** as a distinct option (verified
async, §2.D) — it collapses into E, scoped to one platform, not worth choosing over A/B/C unless E
itself is later decided to be worth doing. **E stays parked** unless A–C prove insufficient in
practice, which needs real-device use to find out.

## 4. Related

- `docs/BUGS.md` B-573 (this session) — the bug this proposal answers.
- `docs/proposals/003-independently-started-graphs.md` — same underlying theme: local-only mode
  was added as a UX choice (B-563) without revisiting durability assumptions built for "there's
  always a server."
- `platform/capacitor.ts`'s trailing doc comment on `db/sqlite-wasm-driver.ts` — names both the
  resume-reopen gap (B above) and the async-driver rewrite (E above) as prior, undone follow-ups.
