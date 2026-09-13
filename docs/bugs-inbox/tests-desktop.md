# Bug inbox — m10/tests-desktop

Entries in `docs/BUGS.md`'s format, for the coordinator to fold in. New numbers B-400..B-409.

Load for "under load" runs: `N` busy `node -e 'for(;;){}'` loops on the 14-core machine (scripts
`burn.sh`/`unburn.sh` in the branch's scratch dir), e2e on port 6402, production build, Chromium.

---

### B-292 (existing)

**Fixed 2026-09-13.** Reproduced first, at `70c9bb9`: `--repeat-each=3` on an idle machine failed
repeats 1 and 2 with `Expected: 1, Received: 3` / `Received: 4`. The test now seeds its page
through the shared `e2e/helpers#openPage` under `runName("Enter Probe", info)` — a new helper,
`e2e/helpers/api.ts#runName`, that suffixes `repeatEachIndex-retry` (the pattern `views.spec.ts`'s
palette test already used) — instead of `page.evaluate` fetches under a fixed name after an extra
`/journals` load. The same repeat-unsafety was in `page-icons.spec.ts` (the "setting an icon" test
found the previous repeat's rocket: `Expected pattern: /page-icon-button-empty/`) and
`references.spec.ts` ("shows a count" found `2`…`8`; "refreshes after a local edit" found a panel
already there), and both now use `runName` too. Test that would have caught it: the spec itself
under `--repeat-each`. Proof: `editing.spec.ts`, `page-icons.spec.ts`, `references.spec.ts`
together, `--repeat-each=5` under 28 busy loops: 55 passed; `--repeat-each=8` under 56 busy loops
(load average 63 → 68): 88 passed, 0 failed; and with the final specs plus `opfs-pool.spec.ts`,
`--repeat-each=8` under 56 busy loops (load average up to 69): 96 passed, 0 failed.

---

### B-335 (existing)

**Diagnosis 2026-09-13 (m10/tests-desktop).** Reproduced at `70c9bb9` under 56 busy loops (load
average ≈ 65): `editing.spec.ts`'s first three tests, `--repeat-each=8`, failed 3 of 24 with
exactly `locator.blur: Test timeout of 30000ms exceeded … waiting for
locator('.vr-draft-input').first()`. Cause, from the page snapshot of a failure: today's outline
already existed on the server, and its LAST row was a new "seed" block. Every test has a fresh
browser context and so an empty replica; `JournalStreamView` renders today's `VirtualJournalDay`
draft while the stream's first fetch is pending, and that fetch waits for the worker's bootstrap
from `/sync/snapshot` (the window `journal-draft-sync.spec.ts` holds open on purpose, B-243). The
helper saw that draft, filled it, the snapshot landed, the stream swapped the draft for the real
outliner (B-243's `keepUncommittedDraft` appended "seed" to the day), and `blur()` then waited for a
textarea that no longer existed. The longer the snapshot takes, the wider the window — hence load.
Not a product bug: the draft-then-swap is designed, and B-243 keeps what was typed.

**Fixed 2026-09-13.** `e2e/helpers/editor.ts#openJournal` makes today real through the API
(`page.append` of one "seed" block, only when today has no blocks) BEFORE loading `/journals`, then
waits for `.journal-day-today .vr-outliner` — it never touches the draft. It is scoped to
`.journal-day-today` because an "Upcoming" day another spec created renders above today, where an
unscoped `.vr-outliner` `.first()` landed. `editing.spec.ts` now uses the shared helper instead of
its own copy (the helper had been lifted from it and was unused). The draft handover keeps its own
specs (`a-fresh-journal.spec.ts`, `journal-draft-sync.spec.ts`). Test that would have caught it: the
spec's first three tests under load; with the fix, 24 of 24 passed in each of the 88- and 96-test runs
above (load average 63-69). Probe `tools/probes/open-journal-slow-snapshot.spec.ts` holds the snapshot 3 s so the
draft is certainly on screen: the helper returned today's outliner 4 of 4, without committing the
draft (today's block count unchanged). Same draft-fill-blur pattern, not changed (WebKit-only, and
its replica is in memory): `storage.spec.ts` "the app is usable on an in-memory database".

---

### B-356 (existing)

**Fixed 2026-09-13.** Mechanism confirmed, and made deterministic. The title row renders from the
local replica; the server hears of the change when the client's push lands (300 ms debounce, then a
request). The single `page.read` straight after the row updated therefore raced two pushes: if
neither the flag's nor the clear's push had landed, it passed without testing anything (seen: reads
right after setting the flag had no `icon`); if the flag's had and the clear's had not — the steps
between them taking longer than the debounce, i.e. a slow machine — it failed with B-356's exact
`Received: "🇨🇿"`. The test now routes `**/sync/push` with a 1 s delay (installed before the app
loads: a route added later did not reach the DB worker, which is what pushes — seen as the route
handler never running), polls the server until it HAS the flag, clears, and polls until the
property is gone. Test that would have caught it: `e2e/tests/page-icons.spec.ts` "only the first
grapheme is kept, and clearing the field removes the icon". Proof: the same test with its final poll
replaced by one read failed 3 of 3 (`Received value: "🇨🇿"`); the polled test passed 3 of 3, and 8
of 8 in the 96-test run under 56 busy loops (load average up to 69).
