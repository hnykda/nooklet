# Bugs and backlog

Working list. Anything reported from real use lands here first, so it survives a lost session and
is not stuck in a chat transcript.

**Conventions.** Each entry says what you *see*, not what the code does — the diagnosis belongs in
the fix. A fixed entry keeps its commit so the regression test is findable. Anything with a
reproducing test names it; anything without one says so, because "fixed" without a test here means
"believed fixed".

Status: `open` · `fixed` · `wontfix` · `needs-repro`

---

## Open

### B-42 · Typing into the `[[` popup keeps dropping editor focus
**Status:** open · **Severity:** high · **Reported:** 2026-09-12 (user: "When I type `testing
[[new/page` → then context window open → but when I keep typing then the edit focus keeps
deselecting and I have to click again to type")

Type `[[` in a block, the page autocomplete opens, keep typing the query — and the editor loses
focus, repeatedly, so every few characters need another click.

**Not reproduced, in any of these** (all with a synchronous `document.activeElement` check after
*every* keystroke plus a `focusout` recorder that captures the JS stack of whatever moved focus —
an auto-retrying `toBeFocused()` would wait out a transient loss and pass):

- `e2e/tests/autocomplete.spec.ts`, Chromium, small graph, page view — 0 losses.
- The same string typed into today's journal on a **copy of the real 952-page graph** — 0/19.
- With another "device" appending to that journal every 150 ms while typing — 0/19.
- Imitating a Czech Mac layout (`[` as an Option-modified keydown, `/` as Shift) — 0/19.
- Mouse parked where the popup opens, so its rows get `mouseenter` on every re-render — 0/19.
- 10 ms between keystrokes — 0/19.
- **WebKit** (the Mac app's engine), once B-43's fallback let the app run there — 0/19.

Ruled out by reading: the `/` cannot wake the slash menu (`TRIGGER_RE` requires whitespace before
it); `surface.ts`'s deferred refocus is guarded against stale attaches; the popup never calls
`.focus()`.

What remains is the reporter's runtime: a stale desktop bundle (this is B-15's exact symptom, fixed
on 2026-09-11 and only delivered by a rebuild — see the delivery-path lesson under B-20), or
something about the real WKWebView that Playwright's WebKit does not share. Needs: which app,
which build, and whether it reproduces at `127.0.0.1:6100` after a hard reload.


**Owner report 2026-09-13 (reproduces):** in the desktop app (Tauri, WKWebView), NOT in the web app in
Chromium, on a build from today's main (B-65's fix included). Typing `testing [[new/page`, or pausing
mid-link like `[[dru` to think: the app syncs/refreshes, and editor focus is lost — you have to click
to type again. So the trigger is a sync-driven refresh while the `[[` autocomplete is open, and the
engine matters: WebKit loses focus where Chromium keeps it. All nine earlier repro attempts ran in
Chromium, which is why none reproduced.

**Still open, still not reproduced — now also not in WebKit (2026-09-13, m11/webkit-focus).** The
owner's report of today (desktop app, WKWebView, focus lost when the app syncs while `[[dru` sits
in the popup) pointed at the engine, and every earlier attempt had run in Chromium. So the same
scenario was traced in Playwright's WebKit (26.x, `webkit-2359`) next to Chromium, recording from
page load: `focusin`/`focusout` with `relatedTarget` and stack, window blur, every
`focus()`/`blur()` call with stack, every DOM insertion/removal/move of a node that contains the
focused element with stack, and `activeElement` / editor row / popup / sync indicator every 20 ms.

Not reproduced in any of these — 0 unfocused samples, 0 `focusout`, 0 DOM operations on the focused
subtree in WebKit, and a key typed afterwards lands in the block with the popup still open:

- **e2e graph, WebKit and Chromium** (probe `tools/probes/webkit-refresh-focus.spec.ts`): existing
  block and new block (Enter) in today's journal, with (a) nothing but this client's own cycle — the
  500 ms flush, push, push queue draining (syncVersion), (b) an API write to another block on the
  same page, (c) an API write to another page.
- **Copy of the owner's graph** (953 pages, 18,631 blocks; probe
  `tools/probes/webkit-refresh-focus-real-graph.mjs`), in today's journal, which holds
  `((1m287mdbqzg37p))` → "travel/trip-planning": the same three refreshes plus a new block, plus a day
  started from its draft (the owner's today page was created minutes before the report, so the tree
  is the one `VirtualJournalDay` renders). The refreshes demonstrably happened: B-500's `((id))`
  flash is in the trace each time. WebKit variants: pointer resting on the popup, pointer resting
  below the editor, every animation frame 120 ms late, 700 ms between keys.
- `document.hasFocus()` stayed true; no `window` blur.

Ruled out by the traces: a keyed `<For>` moving or re-inserting the edited row on a refresh (no
row moves — the edited row's DOM is never touched), the popup re-rendering (its rows re-render only
on keystrokes; it does not listen to sync), `CommandLayer`'s re-detect (keyup/pointerup only), the
"pointerdown outside ends editing" listener (no pointer events), the tree effect's
refocus-after-reorder and `surface.attach`'s frame backstop (neither ran during a refresh). Escape
with the popup open after a refresh still closes the popup and keeps editing (checked at 0 / 300 /
700 / 3000 ms, both engines).

What Playwright's WebKit does not share with the desktop app, none of which could be exercised here:
the system WKWebView build (macOS 26) rather than Playwright's; OPFS in the worker (Playwright's WebKit
has none and runs the in-memory replica, so every refresh reads from memory rather than a
18k-block OPFS database); a real window and the macOS text input client — inline predictions,
autocorrect (`autocorrect: on`, `spellcheck: true` on the editor), marked text, the Czech layout's
Option-typed `[`; a real pointer. Headed WebKit was not run: it would open a window that takes the
keyboard from the owner's session on the same machine.

**Instrumentation for the owner** (commits on m11/webkit-focus): Diagnostics (click the sync
indicator) → **Focus log** → tick "Record focus changes", close, reproduce, reopen Diagnostics →
"Copy log" (or "Show log" and copy from the box). It records the above plus the editor attaching and
detaching (with the stack that detached it), replica change events, sync status transitions, key
categories (`char`, `Enter`, never the character), `beforeinput` input types (an
`insertReplacementText` would point at autocorrect), composition start/end, pointer targets, and a
`LOST` line the moment the editor stops holding focus. No typed text, no page names. It stays on
across a reload, with the previous load's entries, until unticked. `nookletFocusLog.text()` in a
console does the same. Code: `apps/web/src/app/focus-log.ts`.

Tests added (guards, not a fix): `e2e/tests/webkit-refresh-focus.spec.ts` (3; runs in chromium AND
webkit — all six runs fail against a build that blurs on every replica change, all pass on this
branch), `e2e/tests/focus-log.spec.ts` (2, both projects), `apps/web/src/app/focus-log.test.ts` (8).

**Verification (2026-09-13, same branch):** the "ruled out" above holds for the refreshes traced
there — ones that leave the row list around the edited block alone. A refresh CAN move the edited
row: when another device moves that block. In Playwright's WebKit that did not lose focus but did
put the caret at 0 with the `[[` popup still open (B-502, fixed; Chromium was unaffected). Five other
structural refreshes (a block inserted above, siblings reordered, the edited block indented, a child
added above, a real second client editing the block below) and typing straight through remote
inserts kept focus and caret in both engines (probe `tools/probes/refresh-focus-structural.spec.ts`).
So the owner's report is still not reproduced; a focus log from a loss showing `dom insertBefore` on
the edited row right before `LOST` would point at this family rather than at the text input client.

**Next, needs the owner:** a focus log from the desktop app covering one loss.

---

### B-302 · Typing into a mid-sized page keeps the DB worker busy for most of a second at a time

**Status:** needs-repro (measured on a loaded machine) · **Severity:** medium (every write waits
behind it to become durable — B-247's window — and every read the UI makes waits too) · **Found:**
2026-09-13, clipboard-sync, `tools/probes/replica-busy-window.mjs` · **Test:** —

On a copy of the real graph, typing ` probe typing words` (60 ms between keys) into the first block
of `Megapage` (201 blocks) and waiting 1.5 s: the worker's event loop was blocked in stretches of
127 ms (1 run), then 250–1,602 ms adding up to 3,175 ms and 2,334 ms (2 runs) — load average between
20 and 70 from other agents at the time, so how much of that is this machine is unknown. Not
investigated: which queries the text flushes trigger (each `applyLocal` fires a change event that
page views, references and the sync status re-query on).

---

### B-391 · `page.append`, `block.insert` and `page.create` report `updated: []` when their markdown upserts existing blocks
**Status:** open · **Severity:** low · **Found:** 2026-09-13, core-ops-verify (writing the B-390
upsert test) · **Test:** none for the report; the upsert itself is
`packages/server/src/ops/outline-empty-block-id.http.test.ts`

mcp-tools.md rule 6 makes a ` ^id` in write markdown an upsert of that existing block, and
`outline-bridge.ts#prepareMarkdownInsert` returns the upserted ids as `updated` — but all three
callers destructure only `{ops, created, outline}` and answer `updated: []`
(`page-append.ts`, `block-insert.ts`, `page-create.ts`). An agent that writes back a page it read
(every block line carries `^id`) moves every block and is told "created: [], updated: []". B-390
widened the path: an empty block's `- ^id` line is now an upsert too (it used to mint a new block).
Not fixed here (a reporting change in three ops outside this branch's bugs). Likely fix: pass
`updated` through in each.

---

### B-492 · `page.delete`'s `backlinks_affected` counts every block under a linking block, not the links
**Status:** open · **Severity:** low · **Found:** 2026-09-13, delete-launcher (Delete page on a copy
of the owner's graph) · **Test:** none yet

`ops/resolve.ts#backlinkCount` counts `path_ref` rows from other pages, and `path_ref` holds a row
for every descendant of a block that references the page. On a copy of the owner's graph, page
"Balení": 3 blocks on 3 pages link to it (`ref`), and `page.delete {dry_run: true}` reports
`backlinks_affected: 98`. The MCP spec (§4.3.16) documents the field only by example
(`"backlinks_affected": 3`), and an agent reading 98 would reasonably tell the person "98 links
will break". `backlinkCount` has other callers, so the fix (count `ref` rows, or distinct linking
blocks) should be checked against each of them; not changed here. The web app's Delete page dialog
does not print the number for this reason (`apps/web/src/app/page-delete.ts`).

---

### B-493 · The palette's highlight follows a pointer that never moved, so Enter can run a row the keyboard never chose
**Status:** open · **Severity:** low · **Found:** 2026-09-13, verifying delete-launcher (its e2e
test "Cancel, Escape and the backdrop delete nothing; from the palette, Enter confirms" failed 2 of
2 runs) · **Test:** none for the palette; `e2e/tests/page-delete.spec.ts`'s `runFromPalette` now
moves the pointer away and uses commands mode

Leave the mouse resting over the middle of the window (here: where the delete dialog's Cancel was
just clicked), press Cmd/Ctrl+Shift+P and type. Each palette row has `onMouseEnter={() =>
setHighlight(i())}` (`commands/palette/CommandPalette.tsx`); when the rows render or re-sort under
the stationary pointer, Chromium fires `mouseenter` on the row that lands there, and the highlight
jumps to it. In the failing run the query "Delete page" listed the command "Delete page…" first
and the page "Delete Zebra Page" second, and the second row — under the pointer — was highlighted;
Enter would have opened that page. Reproduced on purpose too: pointer at (640, 195), palette opened
from the keyboard, "Probe Yak Pointer" typed → rows `Probe Yak Pointer`, `Probe Yak Pointer Other`,
highlight on the second.

The test passed for its author (3/3, and in the full run) and failed for the verifier (2/2, same
code, same port). Why is not established — presumably when the page rows arrive relative to
Chromium's synthetic `mouseenter` under a still pointer; not verified. Fix direction (not done — the palette is not
this branch's): take the highlight on `mousemove`, not `mouseenter`, as editors' pickers commonly
do, so only a pointer that actually moves steals it.

---

### B-535 · The launcher prefers a server URL it saved last time over the port the shell says
**Status:** open · **Severity:** low · **Found:** 2026-09-13, desktop-shell (reading
`apps/desktop/dist/index.html` while passing it the port) · **Test:** none

`serverUrl()` is `localStorage.getItem("nooklet.desktop.serverUrl") || DEFAULT_URL`, and every
successful connect saves the URL. So once the launcher has connected anywhere, the port the shell
reports (`__NOOKLET_DESKTOP__.port`, i.e. `NOOKLET_PORT` or 6100) is never used again for that
WebKit store: moving the app to another port, or a URL typed into the retry box once, sticks.
Harmless while everything is 6100. Not changed here — the launcher is also being reworked for B-430
on `m11/delete-launcher`; the natural fix is to try the shell's port first and keep the saved URL
as the fallback the retry box edits.

---

### B-538 · In WKWebView a same-origin cross-document navigation leaves the new page a sync follower
**Status:** open (observed, no user path found) · **Severity:** low · **Found:** 2026-09-13,
desktop-shell verification · **Test:** none

After `location.assign("/page/…")` in the desktop app (the verification harness did this), the
indicator read "synced via another tab" and stayed so across three View → Reload; a fresh launch
followed by three reloads stayed "synced". Probably WebKit's page cache keeping the previous
document — and its DB worker holding the leader lock (B-81) — alive. The client only ever reloads
(`location.reload()`) and navigates in-app, so nothing a user does is known to hit this; logged in
case one appears (a plugin, a future full navigation).

---

### B-381 · `page-icons.spec.ts` fails intermittently: it reads the server and the page token without waiting
**Status:** open (test flake) · **Severity:** low · **Found:** 2026-09-13, m10/editor-keys full e2e run
(port 6400, `tests/[m-z]` half) · **Test:** —

Two of its three tests failed in one run and passed in the next, with nothing they touch changed on
the branch (page icons, the title row, `page.read`/`page.update`):
- "only the first grapheme is kept, and clearing the field removes the icon": `page.read` straight
  after Enter on the cleared field still returned `icon: "🇨🇿"` — a one-shot read with no
  `expect.poll`, racing the client's push of the clear. Passed 3 of 3 alone right after.
- "an icon written as a property by an agent shows in the title row": `page.update -> 401 missing or
  invalid bearer token`. The spec's own `api()` reads `window.__NOOKLET__.token` inside
  `page.evaluate` right after `page.goto` to the page; by reading, the new document had not set it
  yet. Passed 3 of 3 alone right after.
Also: the first test ("setting an icon from the title row…") fails on `--repeat-each` because its
page keeps the icon from the previous repeat — not a product bug, but the spec is not re-run safe.
Fix direction (not done, outside this branch's scope): poll the read, and use `helpers/api.ts#api`
(token from `/api/session`) instead of the page's window.

---

2026-10-04: `page-icons.spec.ts` "…clearing the field removes the icon" now clears through the emoji picker's Remove button (same server-poll assertions).

### B-383 · `/mermaid` (and `/template`) on a zoom root puts the new block outside the zoomed view
**Status:** open · **Severity:** low · **Found:** 2026-09-13, adversarial verification of
m10/editor-keys (`/template`: pre-existing; `/mermaid`: reachable since the B-344 fix, `30e9a71`) ·
**Test:** —

Page `- zoom root` / `  - zoom child` / `- outside`, opened at `?block=<zoom root>`, click the root
row, End, type ` /merm`, Enter: the starter is stored as a new top-level block between `zoom root`
and `outside` — the next sibling of the zoom root, which is not rendered in the zoomed view. On
screen only the slash text disappears; the focus request for the new block is dropped by
`BlockTree` (in the tree but not on screen), the caret stays in the root, and a key typed next goes
there (`zoom root Z`). `/template` with text in the zoom root does the same (stored
`["tpl root ", "tpl child", "EKV Checklist", "step one", "tpl outside"]`, rows still
`["tpl root ", "tpl child"]`): both place "after a bullet with text" with
`data/templates.ts#nextSiblingOrder`. Before `30e9a71` `/mermaid` put the fence inline in the root
(visible, never rendered — B-344). Options: insert as the zoom root's first child when the anchor is
the tree's root, or navigate out of the zoom. Probe: `e2e/tests/zz-ekv-probe.spec.ts` P10/P10b/P11
(throwaway, not committed).

---

### B-451 · `review-reactivity.spec.ts`'s two "Retry recovers" tests time out: the Retry button detaches before the click

**Status:** open (cause not traced) · **Severity:** low (test; the view itself ends up loaded) ·
**Found:** 2026-09-13, keys-in-fields (full e2e run) · **Test:** the spec itself

"a failed trash load says so and Retry recovers, instead of Loading… forever (B-131)" and "a failed
history load says so and Retry recovers…" fail with `locator.click: Test timeout of 30000ms
exceeded … locator resolved to <button class="trash-retry">Retry</button> … element was detached
from the DOM, retrying`. The page snapshot at the timeout shows the trash LOADED ("Trash 0 · The
trash is empty.") — so the error state went away by itself after `page.unroute`, before the test's
click landed, and the click then waits for a button that no longer exists. Seen 3 times in a row on
port 6411: in a full run (trash only), alone (both), and alone with this branch's one dispatch line
disabled (both) — so not caused by B-300's fix. Machine load average 65–106 throughout. Not
checked: whether it also fails at `52e5d20` on an idle machine, and what refetches the view (a live
sync poke or a focus refetch would both do it) — which decides whether the fix is in the test
(click Retry OR accept a recovered view) or in the view.

Load-dependent (verifier, 2026-09-13): on `bd843cc` both "Retry recovers" tests PASSED (288 ms and
292 ms) inside a run of 30 spec files at load average ~25–56, the same port and machine. So the
race needs a slow machine — consistent with the view refetching by itself before the click lands.

---

### B-453 · `e2e/helpers#openJournal` fails in strict mode when today is virtual and another journal day is on screen

**Status:** open · **Severity:** low (test harness; the app is fine) · **Found:** 2026-09-13,
verifier of m11/keys-in-fields (a subset e2e run) · **Test:** —

A run of `agent-ops appearance block-properties editing …` failed the three `editing.spec.ts` tests
that call `openJournal` ("types a whole sentence…", "text survives blurring…", "Enter creates a
second bullet…") with `strict mode violation: locator('.vr-draft-input').first().or(locator('.vr-outliner').first())
resolved to 2 elements`. An earlier spec in that run had evidently written a journal day (probably
`agent-ops.spec.ts`, whose header says it writes one 40 days back — which spec it was is not
isolated), so the stream showed today's draft AND that day's outliner; `.or()` of two
`.first()` locators is then two elements. `editing.spec.ts` alone: 5/5. The full suite hides it only
because of what runs before `editing.spec` alphabetically. Fix belongs in the helper (e.g. scope both
to `.journal-day-today`, or `.or(...).first()`), not in any spec.

---

### B-470 · A later line of a block's text that looks like a bullet comes back from the mirror, copy and paste as a child block
**Status:** open · **Severity:** medium · **Found:** 2026-09-13, mirror-escape (fixing B-342) ·
**Test:** none yet; probe `tools/probes/content-shapes-beyond-b342.ts`

A block whose text is `a` + a second line `- dash` (also `* star`, `+ plus`, a bare `-`, or
`1. first`) is written as `- a` / `  - dash`, and every reader of that text — the markdown mirror,
`page_read`, copy then paste, a re-import — gets a block `a` with a child block `dash` (from `1. `
lines: children with `list:: number`). The same class as B-342, one level up: the serializer writes
content lines verbatim and the parser reads bullets by shape. OUT-23a's backslash would fit here too
(`\- dash`, which CommonMark renders as `- dash`), but that is a grammar addition the owner has not
approved. Owner's graph copy: 0 such blocks today (the round-trip probe reads all 953 pages back).
How often the editor produces such text (Shift+Enter, then `- `) is not checked in a browser.

---

### B-471 · A plain block whose text starts with `TODO `, `LATER ` or `[#A]` comes back from the mirror, copy and paste as a task
**Status:** open · **Severity:** low · **Found:** 2026-09-13, mirror-escape (fixing B-342) ·
**Test:** none yet; probe `tools/probes/content-shapes-beyond-b342.ts`

A block with no marker whose text is `TODO not a task` is written `- TODO not a task`, and read back
as a TODO task with the text `not a task`; `[#A] x` comes back with priority A. Same class as B-342
and B-470 (line 1's head is read by shape). `TODOS are words` is fine. Whether the editor stores a
typed leading `TODO ` as text or as the marker is not checked here. Owner's graph copy: 0 such
blocks today.

Found by mirror-escape-verify: OUT-23a adds a small aggravation to this shape. The serializer decides
where a fence opens from the text's line 1 (`TODO ```js` opens none), the parser from line 1 with
its head taken off (it opens one), so a `k:: v` line under it is escaped by one and read verbatim by
the other: plain text `TODO ```js` / `k:: v` / ```` ``` ```` comes back a TODO task with `k\:: v` in its
code (base: `k:: v`). The same for a task whose line 1 is `  ```js` (leading spaces, which the head
split trims). Both shapes were already lossy (marker, leading spaces); owner's graph copy: 0.

---

### B-472 · A text line `foo:: bar` in a block becomes a real property the first time the block is edited in the app
**Owner decision 2026-10-03:** "no for now" — deferred; the current promotion stays as is and is not changed until revisited.
**Status:** deferred (owner, 2026-10-03) · **Severity:** medium · **Found:** 2026-09-13,
mirror-escape (fixing B-342) · **Test:** none yet; probe `tools/probes/content-shapes-beyond-b342.ts`
(unit level; not run in a browser)

The editing text (OUT-22a, `packages/core/src/block-text.ts`) splits every `key:: value` line with a
non-reserved key out of the buffer as a property. A block whose stored TEXT holds `foo:: bar` —
written by an agent as `foo\:: bar` (OUT-23a), pasted from a copied block, or older content — has
that buffer; one keystroke anywhere in it writes `block.text` without the line plus `block.prop foo
= bar` (probe output: `[{"kind":"block.text","content":"notes"},{"kind":"block.prop","key":"foo",
"value":"bar"}]`). `joinBlockText`'s comment calls that promotion "what the same text in a file
would have meant", which B-342's fix made untrue: the file now keeps it text. Reserved-key lines
(`scheduled:: …`) are not affected — the buffer never splits them. B-342's fix makes this easier to
reach: an agent can now write such text through markdown, where before `foo:: bar` was always a
property and `foo\:: bar` stayed text with its backslash, which the buffer does not split; and
copy then paste now keeps it text, where before the paste made it a property. Ways out, owner's
call: the buffer shows such a line escaped (`foo\:: bar`) and the split un-escapes it — lossless,
the same rule as the mirror, but a backslash in the editor — or keep the promotion and document it.

Checked in Chromium by mirror-escape-verify: before B-474's fix the app did not even promote — one
keystroke deleted the line or doubled it (B-474). After that fix it promotes, as described above.

---

### B-473 · `editing.spec.ts` fails when a run has no `a-fresh-journal.spec.ts` before it but has `dates.spec.ts`
**Status:** open (test harness) · **Severity:** low · **Found:** 2026-09-13, mirror-escape (running
the e2e suite in three chunks on port 6413) · **Test:** none yet

`NOOKLET_E2E_PORT=6413 pnpm exec playwright test tests/agent-ops.spec.ts
tests/autocomplete-busy-replica.spec.ts tests/block-timestamps.spec.ts
tests/context-menu-placement.spec.ts tests/dates.spec.ts tests/editing.spec.ts --project=chromium`:
3 of `editing.spec.ts`'s 4 tests fail in its local `openJournal`, with the base `outline.ts` too
(so not B-342's change): `virtualDraft.or(outliner)` is a strict-mode violation — today is still
virtual (`.vr-draft-input` shown) AND today's "Scheduled and deadline" section, filled by
`dates.spec.ts`'s tasks, renders a `.vr-outliner vr-outliner-readonly`. The whole suite in file
order passes because `a-fresh-journal.spec.ts` runs first and makes today real. `editing.spec.ts`
alone: 4/4. `e2e/helpers/editor.ts#openJournal` has the same locator.

---

### B-475 · A block whose first line holds a Unicode line separator comes back from the mirror with `- ` in its text
**Status:** open · **Severity:** low · **Found:** 2026-09-13, mirror-escape-verify (fuzzing
`serializeOutline` → `parseOutline`) · **Test:** none yet

A block whose content line 1 contains U+2028 or U+2029 (pasted from some web pages or JSON
strings) is written `- a<U+2028>b`, and read back as a plain paragraph block whose text is
`- a<U+2028>b`: the bullet regex's `.` does not match a line separator, so the line is not a bullet.
A task loses its marker and id the same way. Lines after line 1 are fine (they are continuation
lines by indent). Same on the base code (`52e5d20`), so not B-342's change. Owner's graph copy: 0
blocks contain either character.

---

### B-476 · A block whose text ends in ` ^` plus 14 id-like characters comes back from the mirror with that text turned into its id
**Status:** open · **Severity:** low · **Found:** 2026-09-13, mirror-escape-verify (property test
of OUT-23a) · **Test:** none yet (kept out of `packages/core/src/outline-escape.property.test.ts`)

A block with no id whose text is `see ^1k7f3q9xz2hav4` is written `- see ^1k7f3q9xz2hav4` (always
with `ids: "none"` — copy, `block.update`'s `before`) and read back as the text `see` with the id
`1k7f3q9xz2hav4`; a text line 1 of ` ^1k7f3q9xz2hav4 ` (trailing space) is text on the first read
and an id on the next. `docs/spec/mcp-tools.md` §3.2 rule 5 says such text "is escaped as ` \^…` on
output and unescaped on input"; `outline.ts` implements no such escape. Same class as B-342 (OUT-23a
would be the natural shape for it). Same on the base code (`52e5d20`). Owner's graph copy: 0 blocks
whose text ends like that.

---

### B-416 · Blocks just made with Enter disappear from the outline for a second or two after Escape while the replica is busy
**Status:** open · **Severity:** low · **Found:** 2026-09-13, re-running QA's `s2-journal.mjs` for
B-411 on a copy of the real graph · **Test:** none; probe `scratchpad/m10/qafix-regression/p3/s2-net2.mjs`
(steps below)

On today's journal, type a line, Enter, `child of todo`, Tab, Enter,
`Czech: příliš žluťoučký kůň #[[QA10 Beta tag]]` at Playwright's default speed, then Escape. For
about 2 s the outline shows only the rows that existed before, and the sync indicator says
`syncing (5)`, then `syncing (6)`. Then the push goes out and the rows come back
(probe timeline: Escape ~2.7 s, rows 2 and stored 2 until 4.8 s, then rows 4 and stored 4). Nothing
is lost: a reload in that window showed every row, and the server had them all. QA's
report that "the Enter/Tab/typing that followed made no blocks" was this state, read 1.5 s after
Escape. The same typing without the `#[[…]]` part pushed within 1 s and the rows never dropped.

Cause, partly by reading: every keystroke inside `[[`/`#[[` runs the popup's search in the replica
worker (B-244 measured a busy worker at seconds on this graph). While those searches are queued,
the tree's writes and refetches wait. Escape ends editing, and `BlockTree`'s tree effect re-runs
against the last fetched tree. `UnseenCreations` keeps only the block being edited, so the other new
rows drop until a fetch that includes them answers. B-303 fixed the same shape for text; creations
are not covered. Not fixed here: it is outside B-411's cause.

---

### B-512 · The tasks view, search hits and property values show `((id))` for a block reference
**Status:** open · **Severity:** low · **Found:** 2026-09-13, ref-label-flash (after fixing B-510)
· **Test:** none yet

A block whose text contains `((some-block))` reads `wombatprobe task quoting ((1m2dv7va6w5hxr))` in
the Tasks view and in a search hit, and a property `source:: ((…))` reads `source((1m2d…))` under
its row — where the outliner row shows the referenced block's text. Seen with
`tools/probes/ref-placeholders-elsewhere.spec.ts` on `52ac1a6` (Chromium). Same cause as B-510:
these render through `InlineContent` without a resolver. The journal agenda renders its tasks the
same way, so it very likely shows the placeholder too (by reading the code; not run). Not fixed
here: B-510's `resolveBlockRef` prop is the way in — pass it from each of these callers
(`BlockProperties` would get it from `BlockRowView`, which already imports the cache).

---

### B-443 · A replica that holds a page of a name refuses the server's older, already-deleted page of that name, and lacks its tombstone row
**Status:** open · **Severity:** low · **Found:** 2026-09-13, ref-pages (the tests above) · **Test:**
none asserts the gap; `apps/web/src/sync/e2e.test.ts` "a page of a name whose earlier page the server
deleted stays this device's page" compares live rows only, with a comment naming this entry

Device A creates page "X" (accepted or still pending). The server meanwhile has a page "X" that was
created and deleted (with ADR 024, any short-lived page a link made). When A pulls that page's
`page.create`, A's own live "X" holds the key, so A's replica rejects the create; the following
`page.delete` is a noop on a row that does not exist. A ends without the tombstone row every other
replica has. Nothing live differs, and nothing reads that tombstone on the client — provided nothing
revives it: an un-delete of it would land everywhere but on A. That is why the server never brings an
unclaimed tombstone back (`ref-pages.ts#referencePageOps` always mints a new page; it did reuse them
before this entry). `trash.restore`/`batch.undo` of such a page are server-side and refuse or evict
before anything reaches A, so no known path revives one today.

Root cause is older than ADR 024: a pulled `page.create` meeting a live local page of the same key is
rejected locally with no reconciliation unless the local page is still unconfirmed (B-442). A fix
would apply a pulled create+delete pair as a tombstone insert, or apply pulled ops in server order
with collisions resolved in the server's favour.

---

### B-444 · `review-reactivity.spec.ts`'s B-131 failure-path tests fail at random on a loaded machine: a refetch removes the Retry button before the click
**Status:** open · **Severity:** low (test only) · **Found:** 2026-09-13, ref-pages, full e2e runs on
port 6410 with load average 70–82 (other agents' suites on 6188, 6191, 6414–6418)

"a failed trash load says so and Retry recovers…", "a failed history load…" and "a failed Older
changes says so…" route the op to fail, wait for the error, `unroute`, then click Retry. Under load
the replica's first sync finishes after the `unroute`; its change event refetches the list, which now
succeeds, the error and its Retry button unmount, and the click waits out the 30 s test timeout
("element was detached from the DOM, retrying"). Same code, three runs: run 1 all three passed; run 2
trash + history failed; `--repeat-each 2` of the three: 4 passed, 2 failed (trash once, Older
changes once — history passed). Not caused by ADR 024's changes as far as could be told (run 1 and 2
had identical client and server code), but not proven on `main` under the same load. A fix would wait
for the first sync (`synced` in the status bar) before routing the failure, or assert the recovery
whether it came from Retry or a refetch.

---

### B-447 · After `nooklet gc` trims the op log, the trash lists every junk page links ever left, and unlinked empty pages stay
**Status:** open · **Severity:** medium (noise, no loss) · **Found:** 2026-09-13, ref-pages
adversarial verification · **Test:** none yet (probe below)

"Created from a reference" and "deleted by the junk rule" are read from the `op` table
(`device_id = 'refpages'`: `isUnclaimedReferencePage`, `HIDDEN_FROM_TRASH_SQL`). `nooklet gc` runs
`DELETE FROM op WHERE seq < floor`, and ADR 022 keeps tombstones forever. Probe (scratch vitest,
deleted after): `page.create Hub "- [[Draft One]]"`, three `block.update`s through `Draft Two`,
`Draft Three`, `Final` — `trash.list` `[]`; then `DELETE FROM op WHERE seq < MAX(seq)` — `trash.list`
`["Draft Two", "Draft One"]`; then unlinking `Final` leaves it a live empty page. On a graph used for
months every slow link edit's intermediate names would surface in the trash at once, and pages
minted before the floor are never cleaned up or taken over by `page_create` again. Nothing is lost.

Possible fixes, not tried: keep `refpages` ops out of the GC (a few rows per minted page, and they
replay consistently), or record the fact in a table GC does not trim.

---

### B-448 · A link in a page-level property other than `tags::` makes no page
**Status:** open · **Severity:** low · **Found:** 2026-09-13, ref-pages adversarial verification ·
**Test:** none

The brief listed "references inside property values (tags:: etc.)". Block properties are covered
(every value except `alias::`) and a page's `tags::` is, but other page properties are not indexed
as references at all (no `ref` row, no backlink — older than ADR 024), so they make no page either.
On the owner's graph copy: `TTRPG/Alpha` `participants:: [[@Alex]], [[@Petr Novák]] [[@Jana Dvořáková]]` — `@Petr Novák` and `@Jana Dvořáková` have no page after the migration (Logseq would
have them); `@Sam Example` `projects:: [[Projects/Workshop]]` and `Projects/@Robin`
`people:: [[@Robin]]` happen to be referenced from blocks too. 4 such `page_prop` values in all.

---

### B-449 · Two namespace edges the junk rule reads differently from `namespaceAncestors`
**Status:** open · **Severity:** low · **Found:** 2026-09-13, ref-pages adversarial verification ·
**Test:** none (reproduced in a scratch `serverApplyOps` test, deleted after)

1. Spaces around `/`: `[[Garden / Beds]]` makes `Garden` (namespaceParts trims), but
   `isKeyStillReferenced`'s child check is the key range `garden/…`, and `garden / beds` is not in
   it. A second block's `[[Garden]]` added and removed deletes `Garden` while `Garden / Beds` lives.
   No live page on the owner's graph has ` / ` in its name.
2. A block `alias:: Nick` is indexed as a page reference (`extractRefs`), which the planner does not
   count as one when minting but `isKeyStillReferenced` does when deleting: an unclaimed `Nick` a
   link made survives that link's removal while any block carries `alias:: Nick`.

---

### B-460 · A property changed elsewhere on the block being edited stays stale in the editor until editing ends
**Status:** open · **Severity:** low · **Found:** 2026-09-13, m11/remote-rewrite (fixing B-192) ·
**Test:** none (probe `tools/probes/remote-property-while-editing.spec.ts`)

Put the caret in a block with a property line (`owner:: alice`). An agent's `block.update` with
`properties: {owner: "bob"}` — or another device editing that line — lands: the server has `bob`,
other rows refetch, and the editor still shows `owner:: alice`. Typing on line 1 does NOT write
`alice` back (the flush writes only the fields the typing changed); the row shows `bob` once editing
ends. Editing the property line itself would, by reading `flushPendingEdit` (not probed), write the
old value plus the edit over `bob` — the same shape as B-192 before its fix.

Cause: B-192's fix tells a newer write by `content_hlc`, and a `block.prop` write leaves it alone.
The buffer holds the editable properties too (B-101), but the page tree the worker returns carries
their values and not their HLCs (`db/worker-core.ts#collectPageProperties`). A fix: return the
newest `block_prop.hlc` per block with the tree and compare `max(content_hlc, that)` in
`editor/remote-text.ts`, recording this tree's own `block.prop` writes for non-reserved keys (a
marker or date op writes a block column, not `block_prop`, and must not count).

---

### B-480 · `review-reactivity.spec.ts`'s "Older changes" retry once listed 25 history batches instead of 26
**Status:** needs-repro · **Severity:** low (test harness, probably) · **Found:** 2026-09-13,
repair-agenda, e2e run of 32 specs (`references-filters` … `views`, alphabetical) on port 6414 at
load average ~100 · **Test:** `e2e/tests/review-reactivity.spec.ts` "a failed Older changes says
so instead of silently re-enabling the button (B-131)"

After the aborted "Older changes" load showed its error and the route was removed, the second click
left `.history-batch` at 25 for the whole 10 s (`expect … toHaveCount(26)`, line 182). The same
spec alone right after: 7/7. Nothing on this branch touches History or `page.history`. Unexplained;
one guess not checked: `page.unroute` and the click racing, so the retry went through the abort
route too but the error line had already been cleared. The trace is gone (the next run on 6414
wiped `e2e/test-results/6414/`); the failure output is in the repair-agenda scratch dir,
`e2e-chunk3.log`.

---

### B-524 · Hybrid search scores are raw RRF values (≈0.016–0.037), not the 0–1 score the op describes
**Status:** open · **Severity:** low · **Found:** 2026-09-13, search-fallback (in passing, on the
real-graph copy after indexing) · **Test:** none

`search` documents "a 0-1 score" per hit. In hybrid mode the score is reciprocal-rank fusion
(`embeddings/rrf.ts`, k=60, weights 1.25/1.0), whose maximum is 2.25/61 ≈ 0.037; "vacation plans"
hybrid on the owner's graph returned five hits all scored 0.016. Blocks and pages are fused in
separate lists and then sorted together, so the best page and the best block tie at the same value
and interleave regardless of how good either is. In range, but not comparable with keyword or
semantic scores, and no agent can threshold on it. Not changed here.

---

2026-10-03: the client now merges server hits by position, never by score, so raw RRF values no longer matter to it.

### B-527 · Settings says "Indexing… It turns on by itself" for a backfill that stopped on errors — the state the search note calls `index_incomplete`
**Status:** open · **Severity:** low · **Found:** 2026-09-13, search-fallback verify (real-graph
copy on :6418) · **Test:** none

Since B-520 the Search view's note sends a reader to Settings with "Search settings" when indexing
ended with failures. Settings then contradicts it. Reproduced on the scratch copy by making the
configured model inactive with one `embedding` row in `status = 'error'` (queue empty, nothing
pending): the note read "indexing stopped: 1 item(s) failed to embed (14,469 of 14,470 embedded),
so semantic search was not switched on. (ollama /api/embed 500: simulated) Search settings", and
the Search & embeddings section read "● Indexing… · Indexed 14469 embedded · 1 failed · It turns on
by itself once every page and block has been embedded. 0 still queued." It will not turn on by
itself — `promoteConfiguredModelIfReady` refuses while any error row remains; "Re-index everything"
(shown) is the way out, and nothing says so. Pre-existing in `SettingsPanel.tsx`'s `switching_to`
branch; not changed here.

Side note from the same run: when a re-embed fails for a unit that already has a vector, the vector
stays and the row is `error`, so the note's `total` (indexed + pending + errors + queued) counts that
unit twice ("14,469 of 14,470"). Cosmetic; not changed.

---

### B-528 · The Settings panel's indexing progress never refreshes on its own
**Status:** open · **Severity:** low · **Found:** 2026-09-13, search-fallback (noticed by the
branch author during the real-graph backfill, not logged then) · **Test:** none

`EmbeddingsSection` reads `embeddings.status` once per mount (`createResource` with no source and
no timer, `apps/web/src/views/SettingsPanel.tsx`); it refetches only on Refresh, after a save, and
after Re-index. During a 7–8 minute backfill of the owner's graph "0 embedded · 19586 still queued"
stays on screen until Refresh is pressed, which reads as stuck. Not changed here.

---

### B-529 · The plugin data API's `semantic()` still embeds its query with no time bound (B-522's hang, sibling path)
**Status:** open · **Severity:** low · **Found:** 2026-09-13, search-fallback verify (code reading
only — not reproduced) · **Test:** none

B-522 bounded the `search` op's query embed (`embedQueryForSearch`, 15 s). `data-api.ts#semantic`
— what a plugin's `ctx.data.semantic(text)` reaches — still calls `embedQueryVector(driver, model,
text)` with no signal at all, so against a host that accepts the connection and never answers it
waits for undici's 300 s header timeout, exactly as `search` did before. No plugin shipped in this
repo calls it (`grep '\.semantic('` outside tests finds nothing), which is why this is low and
unreproduced. Not changed here.

---

### B-400 · When the DB worker fails to start, every view says "Loading…" forever and nothing says why
**Status:** open · **Severity:** medium · **Found:** 2026-09-13, m10/tests-desktop (diagnosing
B-323) · **Test:** none for the general case (B-323's cause is covered by `e2e/tests/opfs-pool.spec.ts`)

If `db.worker.ts#openDb` rejects — B-323's full SAH pool was one way; a corrupt replica or a quota
error in `ensureSchema` would be others — the app shell renders, the sync indicator is blank, and
the page view shows "Loading…" indefinitely. No message, no way to reset the local copy; the only
trace is `pageerror`s in the console (five unhandled `SQLITE_CANTOPEN` rejections in B-323's trace).
B-43 gave OPFS being UNAVAILABLE a fallback and a label ("not saved locally"), but a failure after
OPFS opened goes nowhere: `initDb`'s rejection is dropped in `main.tsx` (`void initDb(…)`), and
resources whose fetch rejects re-throw on read (`PageView`'s `missing()` reads `page()`) with no
`ErrorBoundary` anywhere in the app, so — most likely; not traced — the view keeps whatever it last
rendered. Likely fix: surface `initDb`'s rejection in the shell
(the indicator and a banner, like B-43's label), and offer the memory fallback or a "reset local
copy" action. Not changed here (a second bug found while fixing B-323).

---

### B-401 · The service worker's runtime caching rules never match anything
**Status:** open · **Severity:** low · **Found:** 2026-09-13, m10/tests-desktop (reading the SW while
diagnosing B-323) · **Test:** none

`apps/web/vite.config.ts` gives workbox `runtimeCaching` patterns `/^\/(api|sync)\//` (NetworkOnly)
and `/^\/assets\//` (CacheFirst, "assets" cache, 30 days). Workbox tests a RegExp route against the
request's full `url.href` (the built `dist/workbox-*.js`: `t.exec(e.href)`), which starts with
`http`, so a pattern anchored at `^\/` can never match. The NetworkOnly rule is harmless dead code
(an unmatched request goes to the network anyway), but the CacheFirst one means the graph's own
assets (`GET /assets/:id`, ADR 013) are never cached by the service worker, so an image pasted into
a page does not load offline — which is what that rule reads as promising. (`navigateFallbackDenylist`
is tested against the pathname and does work.) Likely fix: match on `({ url }) => url.pathname
.startsWith("/assets/")`, after checking what an authenticated asset response should do in a shared
cache. Not verified in a browser; found by reading the generated SW and workbox's matcher.

---

**2026-10-03 (mermaid-lazy, `ce99b82`):** confirmed in Chromium. A RegExp rule `/^\/static\//` never
put a chunk in its cache; the function matcher `({ url, sameOrigin }) => sameOrigin &&
url.pathname.startsWith("/static/")` did (`e2e/tests/mermaid-lazy-cache.spec.ts`). The two original
rules (`api|sync` NetworkOnly, `/assets/` CacheFirst) are untouched and still never match; the
`/assets/` one still needs the authenticated-response question answered before it is switched to a
function.

### B-404 · One ChangeEvent naming four tables refetches a History page four times
**Status:** open · **Severity:** low · **Found:** 2026-09-13, m10/tests-desktop (probing B-403) ·
**Test:** none

When a fresh browser's first snapshot lands, the History view fetches its first page four times,
within 1-2 ms of each other (probe `tools/probes/history-older-vs-first-sync.spec.ts` A: five
first-page fetches, once on mount then four at 20-50 ms after the snapshot's release; C logs the same
`first>` quadruple in every cold run that saw the refetch). `data/history.ts#ensureWired`'s
`onChange` sets one version signal per table in `e.tables`, outside Solid's `batch()`, and the
bootstrap names all four (`page`, `block`, `block_prop`, `page_prop`); `usePageHistory`'s resource
source reads all four, so each set reruns the source and calls the fetcher — four `page.history`
requests where one would do. The same unbatched loop is in `data/store.ts`'s `onChange` (`bumpTable`
per table, then `bumpPage` per page id), so by reading every resource there stamped on several
tables refetches once per named table on every pulled or local write too (a `block.prop` op names
two) — not measured. Harmless to correctness (the last answer wins, and each fetcher's side effects
are idempotent), but it multiplies server-backed reads (History, and whatever `store.ts` fetches
over HTTP) on exactly the busy moments. Likely fix: wrap both loops in `batch(() => …)`. Not changed
here: a second bug found while fixing B-403, and `store.ts` feeds every view.

---

### B-408 · `journal-stream-editing.spec.ts` cannot run with `--repeat-each`
**Status:** open · **Severity:** low · **Found:** 2026-09-13, verification of m10/tests-desktop (a
`--repeat-each=4` filter on `editing.spec.ts` also matched this spec) · **Test:** the spec itself

The B-292 shape in another spec: "typing in an earlier day keeps editing across the write…" appends
"- earlier day base" to the fixed day `isoOffset(-8)`, so repeat 1 finds repeat 0's block (by then
"earlier day baseabcdef") beside its own and `section.locator(".vr-block-view", { hasText: "earlier
day base" }).click()` is a strict-mode violation — repeats 1-3 failed that way, repeat 0 passed,
under 56 busy loops. Not load: the locator matches two blocks. Likely fix: a per-repeat journal day
(an offset derived from `repeatEachIndex`, kept clear of the days other specs use) or an exact-text
match on this run's block. Not changed here: outside this branch's specs.

---

### B-570 · `sync/e2e.test.ts` "…pull first" is flaky — order-independent, fails in isolation too
**Status:** open · **Severity:** low (test only) · **Found:** 2026-09-14, coordinator noticed while
re-verifying B-569 · **Test:** the test itself

Unrelated to anything touched this session (`src/sync/e2e.test.ts`, "a page of a name whose earlier
page the server deleted stays this device's page, pull first"). Run alone, repeatedly: 3/5 pass, 2/5
fail with `AssertionError: expected [ { table: 'page', …(2) }, …(1) ] to deeply equal []` — looks
like a notify/change-event list that is not always empty by the time the assertion runs, i.e. a race
in the test's own timing/ordering assumptions rather than test order (ruled out by failing alone).
Not investigated further — noticed in passing, not fixed.

---

### B-579 · A page B-568's client-side creation makes is never auto-cleaned if the reference is later removed
**Status:** open, deliberately deferred — see `data/local-ref-pages.ts`'s header · **Severity:**
low · **Found:** 2026-09-15, coordinator, while implementing B-568

`ref-pages.ts`'s server-side junk-cleanup only reclaims a page whose every applied op came from the
reserved `REFERENCE_DEVICE_ID` sentinel. B-568's client-side equivalent deliberately does not use
that id (using it would violate the invariant that no real device can produce it — see B-568's
entry) — a client-created page is owned by this device's own real id, indistinguishable from one
the owner typed on purpose. So if the reference that prompted it is later edited away before this
device ever syncs, the page stays, empty, forever — the local-only mirror of the "junk a link edited
one character at a time leaves behind" problem `ref-pages.ts`'s header already names, just with no
cleanup mechanism on this side. Not solved here: doing so means either a client-side equivalent of
the server's unclaimed-page detection (a real, separate piece of work) or changing what "unclaimed"
means server-side to also recognize a client-origin page nobody has written into — both bigger
decisions than B-568's own scope, and lower priority given it is a small amount of clutter, not
data loss or a wrong reading of anything.

---

### B-581 · A direct cold navigation to a page with zero blocks hangs on "Loading…" forever
**Status:** not reproduced — the original repro was a probe artifact (2026-10-03); left open only
until someone who saw the hang by hand confirms or closes it · **Severity:** high if real ·
**Found:** 2026-09-15, found while investigating B-568 on desktop · **Test:**
`e2e/tests/desktop-page-creation-probe.spec.ts` "probe: direct cold navigation to a zero-block page
does not hang on 'Loading…' (B-581)" — now a real assertion, passes.

**2026-10-03 re-check.** The "`stuck on 'Loading…': true`" evidence came from
`page.getByText("Loading…").isVisible({ timeout: 8000 })`. Playwright's `isVisible` does not wait —
its `timeout` is ignored — so that `true` meant "Loading… was on screen the instant after `goto`",
which every cold load shows. Re-measured with a real wait: "Loading…" is visible right after `goto`
and gone ~80 ms later, 3/3 repeats (`B-581 probe: "Loading…" visible right after goto: true; gone
after 81 ms`). The original probe, run alone 3 times, logged `true` once and then failed its own
setup twice (below), so it never observed a hang either. The "snapshot at timeout" quoted in the
original entry is not in any kept artifact; if it was real it came from an earlier, unkept version.

Why the spec failed on every full run (both tests, ~10.4 s = the 10 s expect timeout): both typed
into `.journal-day-today .vr-draft-input`, which only exists while today's journal has no blocks.
The first test (or any earlier spec on the shared server) writes to today, so the locator was never
found (`Error: expect(locator).toBeVisible() failed … element(s) not found`). Fixed in the spec:
each test now seeds its own host page (`openEditing`) and a `runName` target, polls `search`/
`page.list` instead of a fixed sleep, and asserts "Loading…" clears within 15 s. Passes alone
(`--repeat-each 3`, 6/6) and after `autocomplete*`, `connectivity`, `journal-draft-sync`.

Original report, kept as written:

`page.goto()` to a page's URL directly — a deep link, browser back/forward, or simply the first time
anyone ever opens a freshly-referenced page — is a full cold client bootstrap (fresh worker, fresh
driver open), unlike navigating there via an in-app `<A>` click from a page already loaded. A page
snapshot captured at the moment of the hang showed the shelf/header had already resolved ("0 blocks
on <page>" — so the page itself loaded, the local replica knows it exists) while the block-tree
content area stayed on "Loading…" indefinitely. Any page with zero blocks hits this on its first
cold load, regardless of how it came to exist — B-568's client-side creation, the server's own
`ref-pages.ts`, or a page created any other way that happens to have no content yet all produce
exactly this state. Likely `usePageTree`/`BlockTree`'s handling of the zero-block case specifically
during a worker's cold start — not investigated past the repro; a real, separate, high-value fix,
independent of anything else in this session's iOS/mobile/desktop work.

---

### B-597 · Inside a `[[link]]` naming another page's alias, the popup offers "New page" for the alias name, and Enter creates a page with that name
**Status:** open, not investigated · **Severity:** low · **Found:** 2026-10-03, keys-small (B-592)
· **Test:** —

`Walkin Alias Holder` has `alias:: Walkin Unmade Page`; a block says `[[Walkin Unmade Page]]`.
Walking the caret into the link opens the `[[` popup, which lists `New page "Walkin Unmade Page"`
— `AutocompletePopup.tsx` checks `hasExact` (and `rowKeepingClosedLink`) against page titles only,
not aliases. Pressing Enter on it created a page "Walkin Unmade Page" (seen in `page.list` during
the B-592 rework, before that assertion was dropped from the test), so the alias now has a
same-named page competing with it. Expected, probably: the alias holder is the row that keeps the
link, and no "New page" for a name an alias answers. What the server does with a page whose key
equals another page's alias (link resolution afterwards) was not checked.

### B-605 · An ordinary page nothing references still opens as "doesn't exist yet / Create"; Logseq opens every missing page as an editable empty page
**Status:** deferred (coordinator decision 2026-10-03: keep as is for now) · **Severity:** low ·
**Found:** 2026-10-03, while doing B-595 · **Test:** none

Logseq 0.10.9 (`components/page.cljs`, `page` and `dummy-block`) gives any missing page a
"Click here to edit..." row. B-595 did this for journal days only. For ordinary names the gap is
small since ADR 024: a referenced name already exists and opens editable. The missing view is
also the signal for a deleted page, an unsynced name, and the two-device race (ADR 024 §7). Doing
it means generalising `VirtualJournalDay` into a page draft that writes nothing until typed.
Reasoning in `docs/progress/empty-journal.md`. Kept because the signal is worth more than the
parity for names nothing links to; revisit if it bites in daily use.

### B-620 · Plugin `rpc.expose` routes turn any thrown error into an unhandled 500
**Status:** open · **Severity:** low · **Found:** 2026-10-03, tasks-workflow agent (B-610) · **Test:** none

`plugins/server-context.ts`: unlike `ops.register`, which maps an `OpError` to its status, an
`rpc.expose` handler that throws returns an unhandled 500. B-610 was fixed inside word-count;
another plugin throwing `OpError` from rpc would 500 the same way.

### B-622 · `mcp/stdio-main.ts` defaults to the pre-ADR-025 `~/.nooklet/default/graph.sqlite`
**Status:** open · **Severity:** low · **Found:** 2026-10-03, pairing agent · **Test:** none

Run without `--data` it would create a stray legacy database beside `graphs/`. Dev-only: `nooklet mcp --stdio` goes through `cli.ts`.

### B-626 · The device's search tag filter is approximate
**Status:** open · **Severity:** low · **Found:** 2026-10-03, server-search agent · **Test:** none

`local-search.ts` matches `tags` from a block's own text plus `Task` for a marker; a `tags::` block property is not seen (the replica has no `ref` table). The server's answer, when merged, is exact.

2026-10-04: unblocked by B-641 (the replica now has `ref`), still open: `local-search.ts` reads through `queryAs`, which cannot drain the dirty ref queue first; needs the search read moved into the worker (or a drain RPC).

### B-627 · Search keeps the previous query's rows on screen until the device answers
**Status:** open · **Severity:** low · **Found:** 2026-10-03, server-search agent · **Test:** none

A resource keeps its last value while loading: 2–4 ms locally, invisible in practice; noted because a probe timing "first list change" misreads it (`tools/probes/search-latency.mjs`).

### B-628 · The OpenAI-compatible embedding provider never sends an API key
**Status:** open · **Severity:** low · **Found:** 2026-10-03, server-search agent · **Test:** none

`factory.ts` builds `new OpenAiCompatProvider({ baseUrl: host, model })` without `apiKey`, and no setting holds one, so a hosted `/v1/embeddings` API answers 401. Found by reading code only.

### B-635 · `popups.spec.ts` is not `--repeat-each`-safe
**Status:** open · **Severity:** low (test) · **Found:** 2026-10-03, e2e-green · **Test:** the spec itself

Fixed page names edited by the tests: lines 103, 223, 313, 578, 608, 619 fail on repeats 1–4.
Single runs are green. (Its two slash-menu tests that assumed `todo` on an empty graph, stale since
`34c8d3e`, are fixed: pinned `todo` in Settings.)

### B-636 · `sw-update.spec.ts` B-537 test failed once in 4 full runs with a worker left `waiting`
**Status:** open, not investigated · **Severity:** low (flaky; possibly a real takeover race) · **Found:** 2026-10-03, e2e-green final runs · **Test:** `sw-update.spec.ts:86`

`{controlled: true, installing: false, waiting: true}` for 60 s after the reload. Passed in 3 other
full runs and 10/10 alone. The reloaded app registers `/sw.js` again (one more update), so this
may be a real takeover race or a test timing issue.

### B-637 · Concurrent e2e runs in one checkout share `apps/web/dist`
**Status:** open · **Severity:** low (process) · **Found:** 2026-10-03, e2e-green · **Test:** none

One run's client build breaks the other's server (`web_client_missing`); separate ports do not
isolate them. Use separate worktrees for parallel e2e runs.

### B-639 · Desktop app showed a white screen after adding the test server; fine after relaunching
**Status:** open, cause suspected (not confirmed) · **Severity:** medium · **Found:** 2026-10-03, owner, real-device test step 6 · **Test:** none

Owner: after Switch Server… → Add a server → `http://127.0.0.1:6200`, the app restarted into a
white screen; running `pnpm desktop` again showed the app fine. No console was captured. The same
URL rendered fine in Playwright WebKit and Chromium, with and without a service worker and with
the desktop bridge (`__NOOKLET_DESKTOP__`) emulated exactly.

Suspected cause (timing only): `nooklet serve` serves the web client live from the repo's
`apps/web/dist`, and the owner's `pnpm ios:sync` (step 4) rebuilt that folder at 21:45–21:47,
around when the desktop window loaded it. A build deletes the old hashed chunks and writes new
ones; a page loaded in between gets an `index.html` whose scripts 404 → blank page. Same class as
B-637 (concurrent e2e runs sharing `dist`). If confirmed, candidate fixes: `serve` snapshots the
client dir at startup (or serves a versioned copy), and/or the runbook says not to build while a
test server is serving. To confirm next time it happens: Inspect Element → Console/Network (404s on
`/static/*.js` would confirm).

### B-652 · A reconnecting device can silently lose one side of a same-block conflict (push/pull race)
**Status:** open, suspected (code read only) · **Severity:** high if real (silent text loss) · **Found:** 2026-10-04, b642 agent · **Test:** none yet

Conflict detection in `SyncClient.pull()` needs the device's own `block.text` still in `pending_op`
when the other device's op is pulled. On `online`/`resume`/`visible`, `worker-core.ts` runs
`schedulePush(0)` and `pull()` concurrently; if the push response is applied before the pull response,
the pending row is gone, the pulled op meets no pending edit, and plain LWW drops one text with no
copy. The B-642 Playwright spec did not hit it in 9 runs (pull went first each time). Candidate fixes:
keep the base/text of recently acknowledged `block.text` ops until the next pull completes, or pull
before push on reconnect.

### B-653 · `--graph` and `--no-mirror` are missing from `nooklet --help`
**Status:** open · **Severity:** low · **Found:** 2026-10-04, public-docs agent (writing docs/guide against the code) · **Test:** none

The flags work but `--help` does not list them.

### B-654 · Rate limiting is documented (ADR 008, MCP spec) but nothing returns 429
**Status:** open · **Severity:** medium (security, public tier) · **Found:** 2026-10-04, public-docs agent (writing docs/guide against the code) · **Test:** none

No rate limiting or lockout exists anywhere. The public-tier checklist says to rate-limit at the proxy; see M13 backlog and the security review.

### B-655 · The `admin` token scope grants nothing beyond `write`
**Status:** open · **Severity:** low (security model clarity) · **Found:** 2026-10-04, public-docs agent (writing docs/guide against the code) · **Test:** none

No operation requires `admin`, so an admin token can do exactly what a write token can.

### B-656 · ADR 015's live-UI tool names differ from what the server exposes
**Status:** open · **Severity:** low (docs) · **Found:** 2026-10-04, public-docs agent (writing docs/guide against the code) · **Test:** none

The server exposes `ui_windows`, `ui_state`, `ui_run`, …; ADR 015 names them differently.

### B-657 · The old README advertised a Homebrew cask, Release downloads and a bare `/mcp` URL
**Status:** open · **Severity:** low (docs) · **Found:** 2026-10-04, public-docs agent (writing docs/guide against the code) · **Test:** none

No tap and no releases exist; bare `/mcp` answers 307. Fixed in the README rewrite (`36fdac6`).

### B-658 · `apps/web/README.md` and OPERATIONS §3 (restore paths) predate the current code
**Status:** open · **Severity:** low (docs) · **Found:** 2026-10-04, public-docs agent (writing docs/guide against the code) · **Test:** none

Both describe the pre-ADR-025 layout or older flows.

### B-659 · `/assets/<id>` needs no token
**Status:** open · **Severity:** medium (security, public tier) · **Found:** 2026-10-04, public-docs agent (writing docs/guide against the code) · **Test:** none

Open by design; with no rate limit, a public server's asset links can be brute-forced in principle (id entropy to be checked). Flagged to the security review.

### B-661 · A tap on the task marker does nothing in Chromium touch emulation
**Status:** open · **Severity:** low (iOS-only app today) · **Found:** 2026-10-04, phone-ui agent · **Test:** none

Its `onPointerDown preventDefault` swallows the click (probe `tools/probes/phone-ui/marker-tap-chromium.spec.ts`). iOS is fine (Simulator). Would affect Chromium on Android, and probably the R61 toolbar buttons (same pattern).

### B-662 · iOS: Return in an empty day's draft inserts a newline instead of creating a block
**Status:** open · **Severity:** medium · **Found:** 2026-10-04, phone-ui agent · **Test:** none

Simulator event log: `keydown Enter` then `beforeinput insertLineBreak`, draft `"ab\n"`; the keydown `preventDefault` does not stop it on iOS. Unverified on a physical iPhone.

### B-663 · `tasks.spec.ts` Mod+Enter tests are order-dependent since empty graphs default to `now`
**Status:** open · **Severity:** low (test) · **Found:** 2026-10-04, phone-ui agent · **Test:** none

Run alone (fresh server, empty graph) they expect TODO and get LATER (`34c8d3e`); in the full suite earlier specs leave TODO markers so the workflow is inferred `todo`.

### B-664 · After the toolbar's hide-keyboard button the toolbar stays at the bottom, scrolled sideways
**Status:** open · **Severity:** low · **Found:** 2026-10-04, phone-ui agent · **Test:** none

Phone UI agent, Simulator.

### B-666 · A page rename leaves its own blocks' `path_ref` under the old key
**Status:** open · **Severity:** low · **Found:** 2026-10-04 · **Test:** none

Server and replica alike: `reindexRefs` re-resolves references TO the page but never revisits the page's own blocks, so they are listed as linked references of the OLD name, and a full rebuild differs from the per-write path on exactly those rows. Pinned: `ref-index.test.ts` › "differs after a rename only where the per-write path is stale".

### B-667 · "Link all" fails offline when a server is configured
**Status:** open · **Severity:** low · **Found:** 2026-10-04 · **Test:** none

Fails after `callOp`'s time bound with an error line; local-only hides it. A device-side Link all would be local `block.text` ops.

### B-668 · The sqlite-wasm `SqlDriver` has no statement cache
**Status:** open · **Severity:** low (perf) · **Found:** 2026-10-04 · **Test:** none

Prepares every statement afresh and runs an extra `SELECT last_insert_rowid()` after every `run` (`apps/web/src/db/sqlite-wasm-driver.ts`); most of the ref index's per-block cost. A cache would speed every write path.

### B-669 · `shelf.test.ts` › "a shelf made before bootstrap set the graph survives the next load" is flaky
**Status:** open · **Severity:** low (test) · **Found:** 2026-10-04 · **Test:** none

Failed once in `pnpm -r test` while an e2e build ran; passed 3/3 alone.

### B-670 · A full e2e run can exit 1 after all tests pass
**Status:** open · **Severity:** low (test harness) · **Found:** 2026-10-04 · **Test:** none

`e2e/global-setup.ts:104` writes `<tmp>/server.log` after teardown deleted the temp dir → uncaught ENOENT.

### B-671 · `nooklet restore --graph <id>` is rejected as an unknown flag
**Status:** open · **Severity:** medium · **Found:** 2026-10-04 · **Test:** none

`RESTORE_FLAGS` in `packages/server/src/cli-args.ts` is `["data", "force"]` but `cli.ts`'s restore reads `graphIdFlag(args)`. Only the default graph can be restored from the CLI. Found by the infra agent.

## Fixed

### B-641 · Offline, the references panel says "Couldn't load references · Retry"
**Status:** fixed (2026-10-04, branch b641-local-references) · **Severity:** medium

Owner on the iPhone in airplane mode: references fail instead of working from the device. "I think
it should just work, not work only online." The replica has no `ref` table (B-626); references
are server-only (B-577's references branch).

**Fixed.** The replica keeps `ref`/`path_ref`/`page_tag`/`page_alias` (core's
`reindexRefs`, kept current by `ref_dirty` triggers + `drainRefIndex`, `apps/web/src/db/ref-index-client.ts`);
the worker answers `page.backlinks`'s reading locally; the server only when the replica has no
index. Tests: `e2e/tests/references-offline.spec.ts` (2), `apps/web/src/db/ref-index-client.test.ts`
(8), `packages/core/src/sync/ref-index.test.ts` (6), `packages/server/src/ref-index-ddl.test.ts`
(1), `apps/web/src/data/local-first.test.ts` (2), `views/ReferencesPanel.test.tsx` › "failure and
local-only (B-641)" (2), `e2e/tests/references.spec.ts` › "answers from the device when the
server's page.backlinks cannot be reached". Graph view and unlinked mentions also work offline now.

### B-665 · On web/desktop, loading `/g/X` while the active entry was `/g/Y` showed Y's data under X's address
**Status:** fixed (2026-10-04, desktop-local-graph agent) · **Severity:** medium · **Found:** 2026-10-04, desktop-local-graph agent · **Test:** `bootstrap.test.ts` "adoptAddressBarGraph" (3), e2e "once made, the new graph opens..."

The router followed the URL, every request followed the entry. Fixed by `bootstrap.ts#adoptAddressBarGraph`. Consequence: a bare address (redirected to `/g/default`) now opens default even if another graph was active.

### B-644 · New local graphs are all named "This device"
**Status:** fixed (2026-10-04, `884f469`)

Owner: generate a whimsical name from a list of ~100, adding a number if taken; renaming exists but
every new graph showing "This device" is confusing.

**Fixed.** Tests: `data/graph-names.test.ts` (6), `bootstrap.test.ts` "B-644:
each new local graph gets its own curated name", e2e `desktop-local-graph.spec.ts` "B-644: on the
phone...". Existing names (including "This device") are never renamed; the B-612 rescue still
labels the recovered graph "This device".

### B-643 · The desktop app cannot add a local graph ("This device") from the graph switcher
**Status:** fixed (2026-10-04, `884f469`)

Works on the phone; in the Mac app (remote mode, `http://127.0.0.1:6200`) the switcher's add flow
does not offer "This device".

**Fixed.** Cause: `GraphSwitcher.tsx` offered a local graph only when
`platform.name === "capacitor"`; the desktop app is the web platform. Model chosen: a new graph on
This Mac's bundled server (ADR 028), via a shell request the page makes by navigating to
`nooklet-desktop.invalid`. Tests: `e2e/tests/desktop-local-graph.spec.ts` (3 desktop cases),
`e2e/tests/desktop-launcher.spec.ts` two B-643 cases, `GraphSwitcher.test.tsx` "B-643: the
desktop app" (4), `desktop-shell.test.ts` (2), `cli-first-run.test.ts` "graph create" (2), Rust
`main.rs` tests (6). Real window unverified.

### B-651 · On the phone, no visible way to set a task to DOING, and the empty checkbox looks like a missing glyph
**Status:** fixed (2026-10-04, `a1b9e09`)

Owner: "not sure how to cycle through the In progress on a task. Also the empty square checkbox looks
like an error of unrendered char than what it does. Maybe with the checkmark it would be better."

**Fixed.** (a) Toolbar button 9 is now `task.cycle` (Mod+Enter's command; was
`task.toggleDone`, which never reaches DOING/NOW and was disabled on a non-task block) — Logseq
mobile's bar does exactly this: `(editor-handler/cycle-todo!)` with the "checkbox" icon,
`src/main/frontend/mobile/mobile_bar.cljs` @ 0.10.9. Respects B-608 (LATER→NOW→DONE under `now`).
(b) Markers drawn as lucide icons (square / square-dot / square-pause / square-check / square-x)
everywhere a task is drawn; the outliner marker is `role="checkbox"` + `aria-checked`
(`mixed` = DOING/NOW). **Test:** `phone-ui.spec.ts` "B-651: the toolbar's task button cycles…",
"B-651: the task checkbox is an icon…"; `navigation.spec.ts` "each task state renders its own
icon"; Simulator `4-cycled.png`, `6-checkbox-tapped.png`. Spec R60 table updated.

### B-650 · On the phone, the graph switcher does not close when tapping elsewhere
**Status:** fixed (2026-10-04, `a1b9e09`)

Owner.

**Fixed.** Outside `pointerdown` closes the switcher, as the "⋯" menu does. **Test:**
`phone-ui.spec.ts` "B-650…".

### B-649 · Go forward is not greyed out when there is nowhere to go
**Status:** fixed (2026-10-04, `a1b9e09`)

Owner, on the phone.

**Fixed.** Back/Forward `disabled` from the Navigation API (`canGoBack/canGoForward`),
else the router's `_depth` vs `history.length` (`shell/history-position.ts`). **Test:**
`phone-ui.spec.ts` "B-649…" (Chromium + WebKit), `history-position.test.ts`.

### B-648 · On the phone, opening Properties makes the page wider than the screen until the app is restarted
**Status:** fixed (2026-10-04, `a1b9e09`)

Owner: the viewport grows past the phone width and the page is centred, so content is cut off;
only an app restart restored the width.

**Fixed.** Cause: the property fields' 13px text (overriding the global 16px) made iOS
zoom the page in on focus (Simulator: `visualViewport.scale` 1.23) and iOS never zooms back;
plus the inputs' intrinsic width could push the add row past 390px. Fix: 16px under
`(pointer: coarse)` (also the search and task filter inputs, same override), `min-width: 0`.
**Test:** `phone-ui.spec.ts` "B-648: …within the screen, fields at 16px"; Simulator
`8-props-field-focused.png` (scale 1.00). The B-572 viewport meta needed no change.

### B-646 · Typing `/` on the phone does not open the slash menu
**Status:** fixed (2026-10-04, `a1b9e09`)

Owner on the iPhone app.

**Fixed.** Cause: two. (a) The slash menu only reads the block editor, and
an empty day's first line is a plain `<textarea>` (`VirtualJournalDay`) — on the phone that is
the first thing you type into; the iOS soft keyboard itself delivers normal `keydown`/`keyup "/"`
(Simulator log). (b) The toolbar's `/` needed `atLineStart` (caret at offset 0), so it was greyed
out anywhere else. Fix: a triggering `/` in the draft starts the day with the caret after it;
`CommandLayer` re-detects on `focusin` and `input` too; toolbar `/` works anywhere (adds a space
mid-word). **Test:** `e2e/tests/phone-ui.spec.ts` "B-646: …empty day's first line…", "…`input`
only…", "…toolbar's `/` works mid-block…" (Chromium + WebKit); `insert-logic.test.ts`
"insertSlash (R50, B-646)"; Simulator `tools/probes/phone-ui/1-draft-slash.png`.

### B-645 · The All pages view has no block/word counts and no row actions
**Status:** fixed (2026-10-04, `9407c8b`) · **Severity:** low (feature) · **Test:** `e2e/tests/all-pages.spec.ts`, `e2e/tests/all-pages-phone.spec.ts`, `apps/web/src/data/page-stats.test.ts`

Owner: extra columns such as word count or block count, and actions such as delete (with confirm).

**Done.** Sortable Blocks / Words / Created / Edited columns counted on the local replica (word rule shared with the word-count plugin, `plugins/word-count/src/count.ts`), per-row Delete through `deletePageWithConfirm` + the in-app confirm; name + blocks + a sort menu at phone width. Left out: backlinks column, bulk/orphan delete, pagination. Real-graph copy: counts painted 278 ms after navigation, 207 ms after an edit. Possible follow-up (owner's call): bulk select/delete and "remove orphaned pages" as in Logseq.

### B-660 · WebKit client logs `SQLITE_CONSTRAINT_FOREIGNKEY` on `INSERT OR REPLACE INTO block` while loading a page
**Status:** fixed (2026-10-04, `2cd8b92`) · **Severity:** high (a new device could come up missing data after `nooklet gc`) · **Test:** `apps/web/src/sync/e2e.test.ts` "a block moved under a block created after it (B-660)" (3 tests, red before)

Seen in the replica on a page freshly created via the API (`tools/probes/b640/row-mutations.mjs`
output). May be harmless ordering in a snapshot apply; worth a look (FK failures can mean a row was
dropped).

**Fixed.** `/sync/snapshot` lists blocks in creation order, so a block moved under a later-created one precedes its parent; the replica's immediate `parent_id` FK check failed and rolled back the whole bootstrap (Chromium too). The app then fell back to pulling the op log from 0 — which hides it while the log is complete but loses whatever `nooklet gc` trimmed — and re-downloaded (and failed) the snapshot on every cold start. Fix: `PRAGMA defer_foreign_keys = ON` in the bootstrap transaction. Probe: `tools/probes/b660/snapshot-fk.mjs`.

### B-640 · A synced block's text is invisible until the block is opened for editing
**Status:** fixed (2026-10-04, `49ddf1e`) · **Severity:** high (data looked lost; data was intact) · **Test:** `e2e/tests/row-paint-after-enter.spec.ts` (WebKit, red before, green after)

Owner: text typed on the iPhone reached the Mac app, but on the iPhone it was not visible, "almost
like the same font color was chosen as background". Seen on the Mac too after syncing the offline
edits: the top bullet "Ok these ones are added on mobile in airplane mode" shows as an empty row
with no bullet (its children render, indented) until the block is clicked into edit mode, where
the text and a collapse arrow appear. Screenshots in the session (2026-10-04). The block is in the
test graph `~/nooklet-test`.

**Fixed 2026-10-04.** The data was correct throughout (the test graph's block was plain: one line,
no properties, not collapsed). Cause: WebKit leaves a `content-visibility: auto` row unpainted when
it is inserted while focus moves into it, which is every Enter. Reproduced in a plain-DOM WebKit probe
(`tools/probes/b640/webkit-cv-focus.mjs`) and by replaying the owner's two-device session in two
WebKit contexts. Chromium unaffected. Fix: `.vr-row-editing { content-visibility: visible }`; rows
revert to `auto` once the editor leaves. Not verified on the real iPhone/Mac app.

### B-647 · The page icon editor is barebones: no picker on the phone, typing does not search
**Status:** fixed (2026-10-04, `f45e6bb`) · **Severity:** low · **Test:** `e2e/tests/page-icon-picker.spec.ts` (3),
`apps/web/src/views/EmojiPicker.test.tsx`, `apps/web/src/emoji/search.test.ts`

Owner: on the phone it just inserts a default smiling face; typing inputs raw characters instead of
searching emoji. Same on desktop.

**Fixed 2026-10-04.** The icon slot opens an emoji picker (`views/EmojiPicker.tsx`): search by English
name/keyword (emojibase-data 17, MIT, build-time trimmed to 1,898 emoji, lazy chunk 38 KB gz,
precached so it works offline), recents + category grid, arrows/Enter/Escape, touch at phone width,
Remove, typed/pasted emoji taken as is; stored `icon` property unchanged. Shaped after Logseq's
`components/icon.cljs` minus Tabler icons/colours/skin tones. Not checked on a real phone or in the
Capacitor app; no Czech keywords (the dataset has none).

### B-642 · A same-block edit conflict is kept as a `conflict_copy::` property instead of something readable
**Status:** fixed (2026-10-04, `1827b8c`, ADR 027) · **Severity:** medium (UX) · **Test:** `packages/server/src/conflict-copy.test.ts`,
`packages/server/src/sync/convergence.property.test.ts` (`conflictReport`), `apps/web/src/sync/e2e.test.ts`
"a same-block conflict leaves the losing text as a block after the winner (B-642)", `e2e/tests/sync-conflict.spec.ts` (8/8)

Owner edited one block on both devices; the loser's text became `conflict_copy: There is this`
under the winning text. "Shouldn't it be smarter than that, and e.g. added that as extra line?"

**Fixed 2026-10-04 (ADR 027, option a).** Clients still report `conflict_copy`; the server turns it
into a sibling block right after the winner, tagged `sync-conflict:: true` (a badge in the UI), and
clears the property. The id is derived from the winner + text, so two reports make one block and a
deleted copy doesn't come back; older clients benefit too. Rejected: appending to the winner (changes
agreed text silently), client-minted blocks (positions diverge). Existing `conflict_copy::` properties
are not migrated (`prop:conflict_copy` finds them). Cost: typing `conflict_copy::` by hand now makes a
block.

### B-638 · `nooklet serve --data <dir that does not exist yet>` dies at once: `ENOENT … root.token`
**Status:** fixed (2026-10-03, coordinator) · **Severity:** high (first start of any new server failed) · **Found:** 2026-10-03, owner, step 1 of the real-device test ·
**Test:** `packages/server/src/cli-first-run.test.ts` "first run: a data dir that does not exist yet (B-638)" — "serve creates the data dir and starts" (red before with the owner's exact ENOENT, green after)

The owner ran the runbook's first command on a fresh machine path:

```
$ pnpm nooklet serve --data ~/nooklet-test --port 6200 --host 0.0.0.0 --allow-host 192.168.1.5
nooklet: ENOENT: no such file or directory, open '~/nooklet-test/root.token'
```

`ensureRootToken` (`auth/root-token.ts`) writes `<dataDir>/root.token` without creating `dataDir`;
since ADR 025 graphs are mounted lazily, so nothing has created the directory by then. Every test,
probe and agent run used an existing `mkdtemp` directory, so none caught it.

**Fixed 2026-10-03.** `ensureRootToken` creates the data dir (`mkdirSync … recursive, mode 0o700`)
before writing `root.token`. `token create` on a missing dir already worked (B-607's registry path);
it now has a test too. The owner worked around it with `mkdir -p ~/nooklet-test` and continued.

### B-634 · A block shelf made on a tab's first load was gone after a reload
**Status:** fixed (2026-10-03, `19c5941`) · **Severity:** low (real regression) · **Found:** 2026-10-03, e2e-green · **Test:** `apps/web/src/app/shelf.test.ts` (red before), e2e shelf-crumb test in `views.spec.ts` (red 2/2 before, 5/5 after)

Since `c58ede4` (B-611's per-replica keys) the shelf's storage key was fixed before a graph was chosen.

### B-593 · `connectivity.spec.ts` "search returns rather than spinning forever" can time out when today's journal already has content
**Status:** fixed (2026-10-03, with B-543) · **Test:** `connectivity.spec.ts` 5/5

Run as `autocomplete-busy-replica, autocomplete-inside-link, autocomplete, connectivity,
desktop-page-creation-probe, journal-draft-sync` it failed with `locator.click: Test timeout of
30000ms exceeded … waiting for locator('.vr-outliner').first().locator('.vr-block-view').first()`.
It branches on `draft.isVisible()` immediately after `goto("/journals")` — the same "draft may be
swapped for the real outliner once the snapshot lands" race B-335 fixed in `openJournal` — and
`.vr-outliner` `.first()` is unscoped (an Upcoming day can render above today). Probably wants
`openJournal`. Not seen in the 2026-10-03 full run's failure list; logged, not fixed.

Fixed on main by the server-search agent (waits for draft-or-block); verified 5/5 by e2e-green.

### B-561 · `search-fallback.spec.ts` "a keyword search shows no fallback note" fails in a full run, passes alone
**Status:** fixed (2026-10-03, test only) · **Test:** `search-fallback.spec.ts`

Failed at the same place in both full runs, passed 4/4 when `search-fallback.spec.ts` ran on its own.
The assertion saw "2 results" where it expects "1 result": something else on the shared e2e server
matches the test's search word by the time it runs — another spec seeding the same word, or (new
since ADR 024) a page created from a reference that contains it. Fix: give the test a word no other
spec uses, the same way B-356/B-243's specs were made order-proof.

---

Cause reproduced: `popups.spec` also seeds "wombat". The spec now uses its own search words.

### B-624 · `page-delete.spec.ts` is flaky under `--repeat-each=2`
**Status:** fixed (2026-10-03, test only) · **Test:** `page-delete.spec.ts`, `autocomplete-inside-link.spec.ts` with `--repeat-each 5`

"Delete page from the … menu…" and "from the palette mid-typing…" fail intermittently on `4c28fad`.
`autocomplete-inside-link.spec.ts` (the B-382/B-592 test) was flaky the same way.

Cause: repeat/retry carry-over through `seedPage`'s `if_exists: "return"` — repeat 0 always passed, 1–4 always failed. Per-run names; the autocomplete walk is bounded by the rows offered.

### B-623 · `page-find.spec.ts` and `random-page.spec.ts` fail on every run
**Status:** fixed (2026-10-03, `cfc863b`) · **Severity:** medium (real regression) · **Test:** `page-find.spec.ts` (red before), `random-page.spec.ts`

On `4c28fad`, also alone (not order-dependent): `page-find.spec.ts` "Cmd/Ctrl+F narrows the
outline…" and "Enter and Shift+Enter step through the matches"; `random-page.spec.ts` "Open a random
page jumps to another page…" and "from a view that is not a page…". Same failures with B-609's files
reset.

**Fixed 2026-10-03.** Cause `6ddfc77` (B-595's `.page-view-body` wrapper): `PageFindBar.tsx` looked for `:scope > .vr-outliner`, so find-in-page filtered rows but drew no highlights and Enter/Shift+Enter no longer scrolled to the match — broken for real users. `random-page.spec.ts` had the same stale selector.

### B-633 · A graph-mismatched page may still sync its old replica with the server's new graph
**Status:** fixed (2026-10-03, coordinator) · **Severity:** high (confirmed: cross-graph mixing) · **Found:** 2026-10-03, b631 agent ·
**Test:** `e2e/tests/graph-mismatch-discard.spec.ts` "B-633: while the mismatch screen shows, the old replica does not sync with the server's graph"

`main.tsx` runs `initDb` with the server as sync target without looking at `graphMismatch`, so while
`GraphMismatchView` is on screen the OLD replica's worker can push its pending ops to, and pull from,
the DIFFERENT graph the server now serves — the cross-graph mix the view exists to prevent. The
B-631 e2e holds sync off, so it does not test this. Candidate fix: no sync target (or no `initDb`)
on a mismatch until the discard.

**Confirmed and fixed 2026-10-03.** With the fix reverted the test fails: the pending note reached
the server's different graph (`Expected: 0, Received: 1`). Fix: `main.tsx` opens the replica with no
sync target when `bootstrap.graphMismatch` is set; the discard is worker-local, so it still works.
Both tests in the spec pass with the fix.

### B-631 · "Discard the local copy and re-sync" deletes every graph's database on the device, including local-only notes
**Status:** fixed (2026-10-03, `926fdb4`) · **Severity:** high (data loss) · **Test:** `e2e/tests/graph-mismatch-discard.spec.ts`
(fails on the old code: local-only note lost), `db/sqlite-wasm-driver.test.ts` "discardReplicaFile",
`db/unapplied-ops.test.ts` "discardScopeBatches"

`GraphMismatchView`'s button deletes every OPFS entry, i.e. every graph's replica on the device.
It needs a worker method that unlinks one pool file (the mismatched graph's). Must be fixed before
anyone with a local-only graph hits a graph mismatch.

**Fixed 2026-10-03.** The discard closes the replica and unlinks only its pool file (sqlite-wasm
`PoolUtil.unlink`, plus `-journal`/`-wal`), plus that replica's B-247 batches, checkpoint, journal
drafts and shelf; it refuses (inline message, nothing deleted) when this tab is a follower or in
memory. Audit: no other device-wide delete exists. Not verified: the Capacitor checkpoint delete
against the real plugin.

### B-632 · On web, pairing on `/g/<slug>` verified the token against the default graph
**Status:** fixed (2026-10-03, connection-states) · **Severity:** medium · **Found:** 2026-10-03, connection-states agent (B-613) ·
**Test:** `ConnectView.test.tsx` "on /g/<slug>, verifies against that graph" (red without the fix)

`ConnectView`'s same-origin pairing verified at `/api/v1/graph.overview` with no `/g/<slug>`, which
the server's bare-origin 307 sends to the default graph, so on `/g/work` a valid `work` token read
as "rejected". `connectToGraph` now verifies at `samePathGraphPrefix()`. Not run in a real browser.

### B-618 · Graph switcher labels are generic and can't be told apart
**Status:** fixed (2026-10-03, connection-states, `acd0cc7..7131475`) · **Test:**

Repro: two-clients 1c. Entries read "This graph" and "Remote graph" rather than the server's graph
label or slug. In the desktop picker, two graphs on one server both have the title `127.0.0.1:6311`
and differ only in the subtitle URL. Adding the bare server address (no `/g/<slug>`) for a graph
already listed creates a duplicate entry with its own replica (two-clients 1d). The add form gives
no hint that `/g/<slug>` is expected, and nothing uses `GET /graphs` to offer a choice.

**Fixed 2026-10-03.** Test and details: `e2e/tests/graph-switcher.spec.ts` "B-618: rows carry the
server's graph names, a bare address is not added twice, and a root token lists graphs" (red on
38e17a6 at the label assertion; the duplicate-add part was not separately run red),
`e2e/tests/desktop-launcher.spec.ts` "B-618: two graphs on one server get distinct titles…" (red
on 38e17a6), `ops.http.test.ts` graph.overview label case, `bootstrap.test.ts` two B-618 cases.
Fix: see Done. API change: `graph.overview` output gains `graph: {id, label}`
(`docs/spec/mcp-tools.md` updated). Not done: the Capacitor ConnectView's own server field has no
`/g/<graph>` hint (only the switcher's add form and the desktop picker do); the desktop dedupe is
in the launcher JS, `main.rs#add_graph` still compares exact strings.

### B-615 · Plain-http non-loopback origin: token accepted, then a blank white page with no explanation
**Status:** fixed (2026-10-03, connection-states, `acd0cc7..7131475`) · **Test:**

Repro: `insecure-context.probe.ts` (`serve.sh <dir> 6311 <LAN-IP>`, open `http://<LAN-IP>:6311/`,
paste a valid token). Errors: `crypto.randomUUID is not a function` (`data/bootstrap.ts`,
`live/window-id.ts`, `app/hosts.ts`) and `navigator.locks` undefined. ConnectView could detect
`!isSecureContext` and say why. The same blank page is expected in the desktop app pointed at a
plain-http remote.

**Fixed 2026-10-03.** Test and details: `e2e/tests/insecure-context.spec.ts` (red on 38e17a6: blank
page), `insecure-context.test.ts`. Fix: the top of `main.tsx` gates before starting anything and
shows why plus the three fixes. The capability check (randomUUID,
locks) decides alongside `isSecureContext`. Capacitor `capacitor://localhost` = secure context per
the recorded Simulator probe (`tools/probes/capacitor-network/`, `docs/progress/real-device-test.md`);
not re-probed here. Desktop app pointed at a plain-http remote: expected to land on the same page
(same build), not run.

### B-614 · Sync indicator stays "Synced" while the server is down
**Status:** fixed (2026-10-03, connection-states, `acd0cc7..7131475`) · **Test:**

Repro: `edges.probe.ts`. Synced client, stop the server, don't type: "Synced" at 1/3/5/10/20/30 s,
with and without a proxy. The live WebSocket's `close` only schedules a reconnect
(`http-transport.ts`) and never changes the status. Only a failed push or pull does.

**Fixed 2026-10-03.** Test and details: `e2e/tests/sync-connection-states.spec.ts` "with nobody typing,
Synced gives way to Offline…" (red on 38e17a6) and "a blip … never changes what the dot shows"
(guard). Fix: WS close → 1.5 s grace → probe `pull()`; failure → `offline`; reconnect → pull →
`idle`. Each failed reconnect re-probes, so recovery is noticed even without the socket. Not
verified against a real killed server (the e2e uses a TCP proxy that stops listening).

### B-613 · Revoked or invalid stored token shows as "Offline", forever, with no way to re-pair
**Status:** fixed (2026-10-03, connection-states, `acd0cc7..7131475`) · **Test:**

Repro: `edges.probe.ts`. Join with a device token, `nooklet token revoke <id>`, reload, edit. The
indicator says "Offline — changes are kept and sent when back online" for 20 s+ and the edit never
reaches the server. The connect screen is not offered, because the entry still has a token. With a
memory replica the page reads "This page doesn't exist yet. Create …". A 401 on push is reported as
`offline` (`sync-client.ts` catch → `state: "offline"`).

**Fixed 2026-10-03.** Test and details: `e2e/tests/sync-connection-states.spec.ts` "a refused token says
so, keeps the edit, and re-pairing sends it" (red on 38e17a6); `sync-client.test.ts` "connection
states" block; `sync-indicator-state.test.ts` B-613 case; `connect-graph.test.ts`
`repairTargetFor`. Fix: 401/403 on push/pull/snapshot and WS close 4403 → `unauthorized`
(sticky until a request succeeds); indicator "Token rejected — changes stay on this device until
you enter a new token" + visible "Token rejected" button → re-pair screen (same entry, address
read-only, pending ops kept and pushed after reload). Also covers a loopback tab left open across
a server restart (its per-process web-client token is retired): the re-pair screen offers Reload.
Not verified: WebKit memory-replica variant from the sweep (the indicator logic puts
`unauthorized` ahead of `memory`, unit-tested only).

### B-630 · A relaunch or graph switch could start on an in-memory replica and lose everything at the next reload
**Status:** fixed (2026-10-03, local-graphs agent) · **Severity:** high for local-only · **Found:** 2026-10-03, local-graphs agent · **Test:** see below

A relaunch could start as an in-memory follower while the old page held the writer lock, and a graph switch could start on memory while the old page held the shared OPFS pool; with no server, everything written was lost. Tests: `local-graphs.spec.ts` 20-run test (fails with `data-state="memory"` when the pool retry is off); `relaunch-loss.probe.ts` for the follower case (no deterministic test: depends on teardown timing).

### B-629 · Under Capacitor, switching to a remote graph left the app for the server's web page
**Status:** fixed (2026-10-03, local-graphs agent) · **Severity:** low-medium · **Found:** 2026-10-03, local-graphs agent · **Test:** see below

`location.assign(<server URL>)` navigated the app away. Now reloads in place. Test: `data/bootstrap.test.ts` "graphEntryUrl under Capacitor".

### B-619 · Local-only draft-journal write can be lost on an immediate relaunch
**Status:** fixed (2026-10-03, `c58ede4`, `3e3c1c5`) · **Severity:** low-medium · **Test:** `views/VirtualJournalDay.test.tsx`
"keeps typed lines until they are ops" (3, incl. the coordinator's merge test for B-609 depths), `e2e/tests/local-graphs.spec.ts` B-619 (5 runs)

Repro: `local-then-server.probe.ts` with `SWEEP_LT_SETTLE_MS=0`: fill today's draft, Enter, Escape,
reload at once. One run showed the note momentarily, then an empty day. Possibly B-247 territory,
not narrowed down.

Cause: the draft's commit waits on `prepare()` before any op exists, so B-247's copy had nothing
to copy (lost 9/10 in the probe). Fixed: draft lines are kept in `localStorage` per replica until
they are ops (`data/journal-draft-store.ts`). Coordinator merge note: B-609's depths and this store
met in one merge; the store now keeps `{text, depth}` and reads an older string-only copy at depth 0.

### B-612 · Capacitor local-only graph disappears from the list once a server graph is added
**Status:** fixed (2026-10-03, `c58ede4`) · **Severity:** high · **Test:** `data/bootstrap.test.ts` "B-612: ...",
`e2e/tests/local-graphs.spec.ts` "an install stranded by the old ..." and the 20-run test's switch-back

Repro: as above, at any timing. "Just this device" creates no `nooklet.graphs` entry (`App.tsx` only
sets `skipped`), so after a server graph is added the switcher lists only "Remote graph". The
local-only replica, which uses the un-namespaced OPFS file, can no longer be reached. The relaunch
goes straight into the server graph.

Fixed: "Just this device" is a real graph-list entry that takes over the old local database; a device already stranded gets it back as "This device" at startup.

### B-611 · Local-only content leaks into a server graph after "Add a graph" (orphaned B-247 batches are not graph-scoped)
**Status:** fixed (2026-10-03, `c58ede4`, `3e3c1c5`) · **Severity:** high · **Test:** `apps/web/src/db/client-graph-scope.test.ts`,
`db/unapplied-ops.test.ts` "batches belong to the replica..." + "migrateUnscopedBatches", `data/bootstrap.test.ts`
"B-611: who could have written...", `e2e/tests/local-graphs.spec.ts` (20-run sequence: 0 leaks; deterministic unscoped batch)

Repro: `tools/probes/sweep-devices/local-then-server.probe.ts` with `SWEEP_LT_FAST=1 SWEEP_LT_SETTLE_MS=0`.
On an emulated Capacitor shell:
1. "Just this device", type a note in today's journal.
2. Relaunch at once, then "Just this device" again.
3. Within ~3 s, Switch graph → Add a graph → Sync with a server → `<server>/g/<id>` + token.

The note shows up in that server graph, and the server API returns it. This happened in 1 of 4
runs, plus the first exploratory run against `default`. Suspected cause, from the code:
`db/client.ts`'s unapplied-ops journal (`nooklet.unapplied-ops.v1:*`) is not keyed by graph entry.
A batch still held at the relaunch (seen in localStorage at that moment) replays into whichever
graph the next page load opens. A second suspect, same class, not seen to fire:
`db/capacitor-checkpoint.ts` uses one fixed `CHECKPOINT_PATH` for every graph entry, and restores it
into any graph's empty replica. The same orphan replay presumably applies to web/desktop graph
switching right after an edit (not tested).

**Fixed 2026-10-03.** Cause confirmed: the B-247 unapplied-ops journal was not keyed by graph, so
the next load replayed a batch into whatever graph it opened (deterministic test: 2 hits in the
server graph before, 0 after). The checkpoint file had the same flaw (not seen firing; fixed the
same way). The journal, the checkpoint and the shelf are now keyed by replica. Older unkeyed
leftovers go to a graph only if exactly one could have written them; otherwise they are set aside
and never replayed. Simulator run on a private headless device: local-only → relaunch → add a server
graph → switch back; the server graph held no local data.

### B-543 · `connectivity.spec.ts` › "search returns rather than spinning forever" fails most runs
**Status:** fixed (2026-10-03, server-search agent) · **Test:** the spec itself (3/3 fail before, 3/3 pass after)

On the unchanged base commit `9ac9e48` (port 6422, Chromium) it failed 3 of 4 runs, the same as on
`m11/quiet-topbar`: `locator.click` times out waiting for `.vr-outliner .vr-block-view`. The page
snapshot at the failure shows today's virtual journal with its "Start typing…" draft and no
outliner. Likely cause (read, not proven): the test decides which branch to take with a
non-retrying `await draft.isVisible()` straight after `page.goto("/journals")`, before the journal
has rendered, so it takes the "outliner" branch on a day that only has a draft. `openJournal` in
`e2e/helpers/editor.ts` waits for `draft.or(outliner)` first and does not have this race.

---

Fixed: `connectivity.spec.ts` waits for `draft.or(today's first block)` before branching.

### B-625 · Search had no local fallback: offline it failed after 10 s, local-only it said "Search needs a server"
**Status:** fixed (2026-10-03, `3844838`, `ba58947`) · **Severity:** high · **Found:** 2026-10-03, server-search agent (owner request) ·
**Test:** `apps/web/src/data/local-search.test.ts` (8), `apps/web/src/data/search-enrich.test.ts` (13),
`apps/web/src/views/SearchView.test.tsx` "SearchView: local first, then the server's semantic matches" (9),
`apps/web/src/data/api-client.test.ts` "callOp's time bound and cancellation" (2),
`e2e/tests/search-semantic-server.spec.ts` (5), `e2e/tests/search-local-only.spec.ts` (1)

The Search view only asked the server; the replica had no full-text index. **Fixed:** the replica
gets its own FTS index with the server's tokenizer (diacritics folded; the query parser moved to
core), rebuilt once for an existing replica (57 ms on the real 18.6k-block graph). Local results
show at once (2–4 ms); after a 250 ms pause the server's hybrid search is asked and its hits merged
in, marked "semantic", with a 6 s bound that only stops waiting for the server. Rows never re-sort
under the pointer/focus. A server hit the replica lacks shows "Not on this device yet". `[[`/`((`
autocomplete and the palette stay local. Design agreed with the owner: local first, then enrich.
Semantic search needs `nooklet embed model bge-m3 --provider ollama --host …` per graph (Ollama
recommended on homeserver, `OLLAMA_KEEP_ALIVE=-1`); `docs/progress/server-search.md`.

### B-609 · A zero-delay Enter/Tab burst on a brand-new journal day loses the Tab
**Status:** fixed (2026-10-03, `319d1e8`, `e65638a`) · **Severity:** low · **Test:** `e2e/tests/journal-draft-burst.spec.ts`
(3 tests; red before), `apps/web/src/views/VirtualJournalDay.test.tsx` "keeps Tab and Shift+Tab typed
while the replica has not answered…" and "Backspace at the start of an empty waiting line…"

**Severity:** low. At 60 ms/key the result is correct, but rows flicker for about 1.1 s, showing
`["","ccc"]`.
**Repro:** today is empty. Click today and type `aaa`⏎`bbb`⇥⏎`ccc`⇧⇥ with no delay. The server
gets `aaa`,`bbb`,`ccc`, all at depth 0, instead of `bbb` indented. The same burst on an ordinary
page is correct. Probe: `indent-render.mjs journal fast 0`.

**Fixed 2026-10-03.** Two causes. (1) The sweep's case is today with a page but no blocks (`BlockTree`): its page-tree
effect re-runs on every Enter (it tracks `editingId`) against the last fetch, and kept only the
edited block among this tab's unfetched creations — the block above vanished, so Tab had nothing to
nest under, and the rows flickered down to the edited one. Now every unfetched creation is kept.
(2) The draft (no page at all; `/journals` today, `/page/<date>`): a burst beats `prepare()`, so the
keys stay in the textarea (B-411) — where Tab moved focus to the Help button, Enter pressed it, and
`ccc` was lost. Tab/Shift+Tab now nest draft lines and the day is written as that tree. (3) The
flicker: the same effect re-ran on every Enter, and a fetch read before a Tab and answered after it
put the old place back. The effect now runs on fetches only, and moves/deletes are held until the
worker answers them (as text already was, B-303). Real-graph copy, 60 ms/key: the Tab showed undone
for 0.3-0.6 s in 4/7 runs before, 0/12 after. See `docs/progress/b609.md`.

### B-621 · After a deep link's reload, `App.getLaunchUrl()` re-delivered the same link, so the pairing confirm screen kept coming back
**Status:** fixed (2026-10-03, `fb31593`) · **Severity:** medium · **Found:** 2026-10-03, pairing agent on the Simulator · **Test:** `platform/launch-url.test.ts`; probe `tools/probes/pairing-link-ui/`

`getLaunchUrl()` is Capacitor's `lastURL`, so after `location.reload()` the same `nooklet://connect` link came back. Fixed in `platform/launch-url.ts`.

### B-616 · Behind a same-host reverse proxy, the app shell 403s with an MCP "Invalid Host" JSON-RPC error
**Status:** fixed (2026-10-03, `f177b35`) · **Test:** `http/web-client.test.ts` "serves the app shell behind a same-host proxy that rewrites Host (B-616)"

Repro: `serve.sh <dir> 6311` (bound 127.0.0.1, no `--allow-host`), then
`node host-proxy.mjs 6312 6311` (forwards `Host: nooklet.sweep.test`).
`curl 127.0.0.1:6312/g/default/` → 403 `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Invalid Host: nooklet.sweep.test"}}`,
while `/api/session` returns 200. The cause is `mountMcp`'s `"/"` sub-app guard
(`createMcpHonoApp({host})` auto-enables localhost Host validation). The workaround is
`--allow-host <name>`, but the CLI only suggests it for non-loopback binds.

The MCP Host guard applies only to `/mcp`, follows `--allow-host`, and its 403 and the server log suggest the flag.

### B-607 · `nooklet import` into a fresh data dir, then `nooklet serve`, crashes: `a graph called "default" already exists`
**Status:** fixed (2026-10-03, `228f942`) · **Test:** `graphs/registry.test.ts`, `cli-first-run.test.ts` (both orders failed before with `serve exited 1`)

**Severity:** medium. It blocks first start on a new server if the import comes first. Workaround:
run `serve` once before importing, or write `graphs/default/graph.json` by hand.
**Repro:** `nooklet import <graph> --data $D` on an empty `$D`, then `nooklet serve --data $D`. The
process exits 1. `import` creates `graphs/default/graph.sqlite` but no `graph.json`.
`GraphRegistry.list()` skips directories without one, so `cli.ts:286` calls `create("default")`,
which throws because the db exists. README also still says `~/.nooklet/default`, but the layout is
now `graphs/default`.

Same root cause as `nooklet token create` before the first `serve` (found by the b587 agent, `docs/progress/b587.md`): any command that opens a fresh data dir creates `graphs/default/graph.sqlite` without `graph.json`.

CLI commands write `graph.json`; `serve` adopts an existing `graph.sqlite` without one. README and OPERATIONS §2 paths updated.

### B-604 · `nooklet serve --host 0.0.0.0` prints `http://0.0.0.0:6100/...` as the address to use
**Status:** fixed (2026-10-03, `f19a64b`) · **Test:** `serve-banner.test.ts`

Not reachable from a phone; printing the machine's LAN IPs would save a lookup.

A `0.0.0.0` bind prints the LAN addresses (skipping VM/Docker bridges) and the exact `--allow-host` to restart with.

### B-603 · `nooklet://` deep links reach nothing
**Status:** fixed (2026-10-03, `0399e4e`, `fb31593`) · **Test:** unit tests in `docs/progress/pairing.md`; Simulator probe `tools/probes/pairing-link-ui/`

`platform.deepLinks.onOpen` has no subscriber anywhere in `apps/web/src` (grep), so opening `nooklet://anything` just foregrounds the app. A `nooklet://connect?url=…&token=…` link (or QR) would also remove the token-pasting step.

`nooklet://connect?url=…&token=…` opens ConnectView pre-filled and connects only on a tap; it adds a server graph and keeps local ones. Parsing rejects non-http(s) URLs, user-info and missing params. `nooklet token create --link <url>` prints the link. No QR (no library in the tree; adding one is an owner decision). The token sits in the URL: it can leak via clipboard/history — documented.

### B-602 · A WebSocket upgrade to an unrouted bare path hangs instead of failing
**Status:** fixed (2026-10-03, `b233294`) · **Test:** `graphs/mount.test.ts` "answers a failed upgrade with 404 at once … (B-602)" and "survives a client resetting the TCP connection mid-upgrade (B-589, kept by the new guard)"

`/sync/live` with no `/g/<id>` prefix: no 101, no error response (`tools/probes/ws-bare-origin.mjs`, "NEVER OPENED" after 5 s). The client fix (bare address → `/g/default`) avoids it; the server should answer 404.

Root cause: B-589's second `'upgrade'` listener — `@hono/node-server` only answers a failed upgrade when it has the sole listener, so every failed upgrade hung (unknown graphs too). The B-589 guard now attaches at `'connection'` (`http/upgrade-guard.ts`).

### B-600 · Security: the loopback auto-token was handed to every client behind a same-host reverse proxy
**Status:** fixed (2026-10-03, `b233294`, D3) · **Test:** `http/host-guard.test.ts` "--no-loopback-token (B-600, decision D3)"

The server gives a write token to any caller that looks local. A proxy on the server's machine that rewrites `Host` to its upstream made every client look local. **Fixed 2026-10-03** (`ee8c54c`) for any request carrying forwarding headers (`X-Forwarded-For`, `Forwarded`, …) in `http/app.ts`. Still open: a proxy that rewrites `Host` and adds no forwarding header is indistinguishable from a local browser (decision D3 in `docs/progress/real-device-test.md`). the home server's setup is not affected (the Tailscale proxy runs in a separate pod).

**D3 done 2026-10-03:** `nooklet serve --no-loopback-token`, set in the Dockerfile and the Helm chart (no browser runs in a container; port-forwards and sidecars arrive over loopback). Off by default in the CLI because the local desktop app relies on the auto-token.

### B-617 · Plugin "word-count" fails to activate for every graph after the first
**Status:** fixed (2026-10-03, `de59bf8`) · **Severity:** low · **Test:** `packages/server/src/graphs/mount.test.ts`
"activates every built-in plugin in each graph … (B-617)"

Repro: `nooklet serve` with two graphs, then hit `/g/<second>/…`. The server log shows
`[plugins] plugin "word-count" failed to activate: op "page.wordcount" is already registered`. The
op registry looks process-global across graph contexts.

Fixed: each graph gets its own op registry for plugin ops; mermaid and daily-summary checked too.

### B-610 · The word-count plugin returns 500 for a page just deleted
**Status:** fixed (2026-10-03, `69e9e99`) · **Severity:** low · **Test:** `packages/server/src/plugins/built-ins.test.ts`
"the status bar's rpc answers null, not a 500, for a page just deleted (B-610)"; e2e `plugins.spec.ts`
"deleting the open page asks word count about it without a 500 (B-610)"

**Severity:** low; it only adds console noise.
**Repro:** delete a page from Page actions. The server log shows
`OpError: no page named "…"` at `plugins/word-count … countPage`, and the browser logs a 500.

### B-608 · Mod+Enter ignores the owner's LATER/NOW workflow: a LATER task cycles to no marker
**Status:** fixed (2026-10-03, `69e9e99`) · **Severity:** medium · **Test:** `packages/core/src/task-workflow.test.ts`,
`apps/web/src/editor/task.test.ts` "under the `now` workflow (B-608)", `commands/registrations/index.test.ts`
"follow the graph's task workflow (B-608)", `SlashMenu.test.tsx` "LATER first under `now`",
`importer/logseq.test.ts` "task workflow (B-608)", `http/host-guard.test.ts` "task workflow", e2e
`e2e/tests/task-workflow.spec.ts`

**Severity:** medium. The owner's graph has `:preferred-workflow :now`, with 72 LATER, 5 NOW and
0 TODO blocks.
**Repro:** on `- LATER owner style`, press Mod+Enter three times. Markers go `null`, then `TODO`,
then `DOING` (`task-logic.ts#nextCycleMarker`). Logseq goes LATER→NOW→DONE, and a plain block
starts at LATER. Probe: `tasks.mjs`.

**Fixed 2026-10-03.** Logseq ref: 0.10.9 `util/marker.cljs#cycle-marker-state`: the next marker
depends on the current one (TODO→DOING→DONE, LATER→NOW→DONE); the workflow picks the start marker.
Per-graph setting in Settings → Tasks (per device, as settings don't sync yet); the importer reads
`:preferred-workflow`; with no setting the server infers from markers. Also changed to match Logseq:
WAITING/CANCELED + Mod+Enter → start marker; un-tick DONE → start marker; a repeating LATER/NOW task
reopens as LATER. `done::` on DONE→none left as is. **Coordinator follow-up:** an empty graph (or a
tie) now infers `now`, Logseq's own default and the owner's workflow (the agent had kept `todo`).

### B-606 · Clicking right of a block's text, or pressing End, puts the caret inside a trailing `[[link]]`
**Status:** fixed (`15a203c`) · **Severity:** high · **Found:** 2026-10-03, core readiness sweep ·
**Test:** `e2e/tests/caret-after-link.spec.ts` (all 14, Chromium and WebKit), `apps/web/src/editor/caret.test.tsx` "resolveClickOffset at a line's edges (B-606)"

**Severity:** high. Typing corrupts the link target and creates junk pages. "… with [[Person]]" is
a very common block shape. Not covered by B-325 or B-585.
**Repro:** seed `- plain text [[Balení]]`. Click in the empty space right of the rendered text and
type `Y`: the result is `plain text [[BalenYí]]`. Click the same block, press Home, then End, then
type `Z`: the result is `plain text [[BaleníZ]]`. A page named `BaleníZ` now exists and shows up in
Mod+K. Blocks that do not end in a link (`[[Inbox]] trailing words`, `text **bold** end`) behave
correctly. Probe: `tools/probes/sweep-core/end-after-link.mjs`. Likely cause: `livePreview.ts`
hides `]]` with `Decoration.replace` while the caret is not touching the link, so End stops before
it, and the click mapping in `caret.ts` lands in the link token. Not confirmed.

**Fixed 2026-10-03.** Two causes, one per gesture. (1) Click on the rendered block:
`caret.ts#resolveClickOffset` added the rendered character offset to the link's `data-from`,
which is its `[[`, so the end of `Balení` mapped to `[[Bale|ní]]` and nothing could map past
`]]` (same for a trailing `**bold**` and `((ref))`). Now a point with nothing rendered after it
on its line maps to the outermost enclosing token's `data-to` (start of line: `data-from`), and
characters inside an un-aliased link count from its target (`data-text-from`). (2) End, and a
click inside the editor: with `lineWrapping`, CM6's `moveToLineBoundary` hit-tests the editor's
right edge, which never lands past a zero-width hidden `]]`; `livePreview.ts` now wraps
Home/End/Cmd-Arrow and pointer selection to cross hidden markers at the line edge (Home before a
leading `[[` likewise). `#[[multi word]]` was never affected. Red before: 20 failed in Chromium +
WebKit; green after 28/28. Probe `end-after-link.mjs` on the real graph: all five blocks append
after the link, no `BaleníZ` page.
Not run in the real Mac app (Playwright WebKit stood in).

### B-587 · `verifyRebuildParity` diverges on the server after a "push first" name-collision-with-a-tombstone race — found via a full `pnpm -r test` run, not investigated
**Status:** fixed (2026-10-03, `0cb4a62`, ADR 026) · **Severity:** high (replicas diverged for good) ·
**Test:** `apps/web/src/sync/e2e.test.ts` "a page created under a name the server freed … (B-587)";
`packages/server/src/sync/convergence.property.test.ts`; `packages/core/src/sync/apply-ops.test.ts`

```
AssertionError: expected [ { table: 'page', …(2) }, …(1) ] to deeply equal []
- []
+ [
+   { "key": { "id": "1m2kcpq6nmw48w" }, "kind": "missing-in-rebuild", "table": "page" },
+   { "key": { "id": "1m2kcpq6nmw48x" }, "kind": "missing-in-rebuild", "table": "block" },
+ ]
```

Confirmed pre-existing in the same accumulated-but-uncommitted tree B-585 already covers (`git
stash` back to `629f572`, this test passes cleanly there) — not caused by ADR 025 / B-586, whose
code this test never touches (no `bootstrap.ts`/`GraphSwitcher.tsx` import). Given the scenario
(server-side "page of a name whose earlier page was deleted" + B-443's "never revive an unclaimed
tombstone" logic, right next to B-568's ref-page work this session already touched), this may share
B-585's upstream cause or may be a distinct correctness bug in the same area — not narrowed down,
only reproduced and confirmed real. Deliberately not investigated further here, same reasoning as
B-585: different subsystem than the multi-graph work in flight, flagged rather than silently
expanding scope. Whoever picks this up should start from `verifyRebuildParity`'s own divergence
report (`apps/web/src/sync/e2e.test.ts` imports it) — a `missing-in-rebuild` on both `page` and
`block` for what looks like device A's own newly-created page/block suggests the SERVER's replay of
the op log loses them, not that A's own local state is wrong (the test's own `live(driverA)` vs.
`live(s)` comparison a few lines above passes).

**Cause (2026-10-03):** flaky, not deterministic — 3 of 8 runs of `src/sync/e2e.test.ts` failed
after B-585's fix, and it was caught on "pull first" too. Op log from a failing run: the
reference rule's `page.delete` of "Ghost Name" is seq 5 with HLC `…:09.838Z-0002-00000000`; device
A's own `page.create` of "Ghost Name" is seq 6 with HLC `…:09.838Z-0000-562db010` — minted in
the same millisecond, before A had heard of seq 5, so it has the smaller HLC. Live, the server
applied them in seq order (name free, A's page lands). `verifyRebuildParity` replays in one
`applyOps` call, and core's `applyOps` sorts by HLC, so the create runs while the ghost is live and
is rejected `page-key-collision` → A's page and block `missing-in-rebuild`. Reproduced
deterministically by `tools/probes/b587-hlc-order-name-collision.ts`. Not related to B-585: the
test drives `SyncClient` directly, no client page minting involved. The real problem is that a
name collision is order-dependent while HLC order can disagree with the server's causal (seq)
order. Unverified: whether a third device pulling those ops in one batch diverges the same way —
if so this is a convergence bug, not just a verify false alarm. Fix options (not chosen): the
server re-stamps or rejects an op whose HLC is behind ops it already applied on the same name;
or replay/pull apply in seq order rather than HLC order.

**Settled (2026-10-03):** a convergence bug, not only a verify false alarm. Deterministic test
(A's clock 5 s behind): a replica that bootstrapped before the delete and then pulled the delete
and A's ops in one batch ended with no live "Ghost Name" and without A's block — for good; a
replica pulling the whole log in one batch lacked the old page's tombstone. Live replicas and a
later snapshot were fine. **Fix:** batches read out of the server's log are applied in `seq`
order as given — `applyOps(…, { order: "seq" })` in `SyncClient.pull()`, push-response
corrections and `verifyRebuildParity` (sql-schema.md rule 26 already said `seq`). Rejected: the
server re-stamping or rejecting the late op (ADR 026). **Tests:** `apps/web/src/sync/e2e.test.ts`
"a page created under a name the server freed, with an HLC older than the freeing op, converges
on every replica (B-587)" (fails before: `[ 'C', 'D' ]`); `packages/server/src/sync/
convergence.property.test.ts`; `packages/core/src/sync/apply-ops.test.ts` `order: "seq"`.
`e2e.test.ts` 20/20 runs green. Probes: `tools/probes/b587-hlc-order-name-collision.ts`,
`tools/probes/b587-three-device-http.ts`.

### B-491 · `window.confirm()` is always "Cancel" and `window.alert()` shows nothing in the desktop app
**Status:** fixed (2026-10-03, `f3a0d78`) · **Severity:** high · **Test:** `e2e/tests/history.spec.ts`
(Undo/Restore confirm in-page), `e2e/tests/refactor.spec.ts` "a failed Turn into page says so in the
page…", `e2e/tests/page-rename.spec.ts` (clash notice), `apps/web/src/source-guards.test.ts`
"native dialogs (B-491)" (guard), `apps/web/src/plugins/host.test.ts` "dialogs (B-491)"

The desktop app is a WKWebView through wry 0.55.1, whose `WKUIDelegate`
(`wry-0.55.1/src/wkwebview/class/wry_web_view_ui_delegate.rs`) implements the file-upload panel,
media-capture permission and new windows — and none of the JavaScript panel methods
(`webView:runJavaScriptConfirmPanelWithMessage:…`, `…AlertPanel…`, `…TextInputPanel…`). WebKit then
answers without showing anything. The probe builds exactly that (a UI delegate with no panel
methods) and prints `confirm returned false after 0 ms` / `alert returned undefined after 1 ms`.

What that breaks in the app today, found by grep, none of it verified in a built app:

- History view: "Undo" and "Restore this version" both open with `window.confirm`
  (`views/HistoryView.tsx`) — on the desktop app they silently do nothing.
- Every failure reported through `window.alert` is invisible there: "Turn into page / Move to page /
  Merge page failed" (`app/refactor-host.tsx`), "Rename failed" (`views/PageView.tsx`), "Could not
  clear the local copy" (`views/GraphMismatchView.tsx`). The action fails with no word.

Chromium (the e2e suite) shows real dialogs, which is why no test noticed. Fix direction: an
in-page dialog. `apps/web/src/app/confirm-dialog.tsx` (added for Delete page on this branch) is a
drop-in for the confirms; the alerts want the same or an inline error line. Not done here — those
call sites belong to other workstreams.

---

**Fixed 2026-10-03:** History confirms through `confirmDialog`; refactor failures through a new
one-button `noticeDialog`; rename failure on the title-row notice (now role=alert for errors);
graph-mismatch failure as an inline role=alert line (no test); plugin `ctx.confirm` now uses the
in-page dialog, `ctx.prompt` still unsupported (no in-page text dialog). A source-guard test forbids
any new `window.confirm/alert/prompt`. Only run in Chromium, not in the built desktop app.

### B-595 · Opening a journal day that has no blocks yet shows "This page doesn't exist yet", not an editable empty journal
**Status:** fixed (2026-10-03, `6ddfc77`) · **Severity:** low · **Found:** 2026-10-03, while doing B-560 ·
**Test:** `apps/web/src/views/PageView.test.tsx` (4 tests; 3 failed before the fix);
`e2e/tests/empty-journal-page.spec.ts` (2 tests: date URL, and today's heading in a fresh graph,
both checking that viewing creates no page and typing creates the blocks on the server).

Opening a not-yet-created journal day's page (today's heading before today has a block, or any date
link) shows the generic "This page doesn't exist yet / Create" view instead of the journal stream's
draft input (`JournalDayOutline`'s virtual day). Logseq shows an editable empty journal there.

**Fixed 2026-10-03**: `PageView` shows a whole-day date route with no page as the journal stream's
draft (`VirtualJournalDay`). Typing creates the day (page, template, blocks) in one batch, and
viewing writes nothing. After the first write the draft stays mounted (B-411). Logseq does the same
(`components/page.cljs` 0.10.9, `dummy-block`), although Logseq also creates the page entity on
view, which nooklet does not (that would be B-579's junk). Found along the way and fixed in the same
change: as a bare fragment, the page header growing after the first write *moved* the draft's DOM
node and blurred the editor (caret lost right after Enter); the section is now wrapped in one
element. Ordinary missing pages keep "doesn't exist yet / Create" — see B-605. The three
`ref-pages.spec.ts` failures the agent saw were B-585 (its branch predated that fix's merge).

### B-601 · The container image failed on first run: the official Node Linux binary needs `libatomic1`
**Status:** fixed · **Severity:** low (deploy only) · **Found:** 2026-10-03, real-device-test agent ·
**Test:** manual: `docker run` of `deploy/docker/Dockerfile`'s image

**Fixed 2026-10-03** (`ee8c54c`) by installing `libatomic1` in the image. Possibly also affects the Linux desktop sidecar on minimal distros; not investigated.

### B-599 · A server address typed without a path (`http://host:6100`) never opened live sync
**Status:** fixed · **Severity:** high · **Found:** 2026-10-03, real-device-test agent ·
**Test:** `apps/web/src/data/connect-graph.test.ts`, updated `ConnectView.test.tsx`/`GraphSwitcher.test.tsx`; probe `tools/probes/ws-bare-origin.mjs`

The address was stored as-is; HTTP worked via the server's 307 to `/g/default`, but `/sync/live` never opened (WebSockets don't follow redirects), so live sync silently never connected. **Fixed 2026-10-03** (`ee8c54c`): `connect-graph.ts#graphBaseUrl` stores a bare address as `<address>/g/default`.

### B-598 · The iOS app could not reach any server: no CORS on the server
**Status:** fixed · **Severity:** critical (iPhone sync impossible) · **Found:** 2026-10-03, real-device-test agent ·
**Test:** `packages/server/src/graphs/mount.test.ts` "CORS for nooklet's own app shells"; probe `tools/probes/capacitor-network/` (Simulator, before/after)

Preflights got 401 (graph routes) or 307 (bare origin) without `Access-Control-Allow-Origin`; WebKit reported "TypeError: Load failed" for every fetch from `capacitor://localhost`. **Fixed 2026-10-03** (`ee8c54c`) in `graphs/mount.ts`: an allowlist of `capacitor://localhost` (never `*`). Verified on the iOS Simulator: 5/5 fetch checks failed before, 11/11 pass after; a block written on the server appeared live in the real app over a LAN IP. Not verified on a physical iPhone.

### B-592 · The B-382 e2e test's precondition ("a link to a page that does not exist") cannot hold since ADR 024
**Status:** fixed (`4c233f1`) · **Severity:** low (test only) · **Test:** the reworked test itself

Fails every time, alone or with neighbours:
`Expected substring: "New page" / Received string: "Walkin Unmade Page"` at the
`.cmd-row--active` check — the popup offers the real page, so there is no "New page" row to press.
The test seeds `- alpha [[Walkin Unmade Page]] omega` through `page.create`; since ADR 024
(`c162820`, after B-382's `dc86f5b`) `serverApplyOps` mints every referenced page in the same
transaction, so "Walkin Unmade Page" exists before the browser opens. **Not B-585:** checked out
`629f572` (no `local-ref-pages.ts` at all) in a worktree and ran the spec with `--repeat-each 3` —
the same test failed 3/3 with the same received string, the other six passed. Earlier green runs
(e.g. `f2b21b0`'s "634 passed") are unexplained — presumably the "pages list not loaded yet" race
the B-382 entry mentions, which used to leave "New page" as the only row. To fix the test (not
done here): it needs a link whose page does not exist, which ADR 024 forbids for anything written
through the server — e.g. type the link in the browser with the page list known not to contain it,
or assert the B-382 guarantee (Enter leaves the whole link) for whichever row is active.

**Fixed 2026-10-03.** Trashing the page after seeding does not restore the precondition — a
still-referenced page is minted again (`ref-pages.ts`: "Deleting a page that is still referenced
cannot make it go away"), checked: `page.list` still had it. The one stored state where a link's
page does not exist is a link naming another page's alias (`ref-pages.ts` deletes "unclaimed
pages whose name an alias now answers for"), and the popup's "New page" check compares titles
only, so the row is offered there. The test now seeds "Walkin Alias Holder" with
`alias:: Walkin Unmade Page`, asserts the row reads `New page "Walkin Unmade Page"` (the whole
link — B-382's fix), walks to it if ranking put another row first, presses Enter, and checks the
link is whole and no "Walkin Unm" page exists. Red with B-382's `createName` fix reverted
(no row with the whole name), green with it. If "New page" stops being offered for an alias name
(see the new entry below), this test needs another missing-page state.

### B-594 · The Diagnostics panel does not close on Escape
**Status:** fixed (`4c233f1`) · **Severity:** low · **Found:** 2026-10-03, while fixing B-591 ·
**Test:** e2e/tests/diagnostics.spec.ts "closes on Escape, like every other overlay (B-594)"

Every other overlay (HelpMenu, the confirm dialog, the context menu) closes on Escape. The
Diagnostics panel (`views/DiagnosticsPanel.tsx`) closes only on a backdrop click or its Close
button, so a keyboard user has to tab to Close.

**Fixed 2026-10-03.** `DiagnosticsPanel.tsx` handles Escape as `HelpMenu` does: a `document`
keydown listener (focus on the panel or the page) plus a `claimPopupKeys` claim, so an editor
still focused underneath does not read the same Escape as "leave editing" (B-72). The test closes
it once with focus on its Close button and once with nothing focused. Not tested: Escape with a
block editor focused underneath (opening the panel takes a click, which ends editing).

### B-450 · With a block selection standing, Enter on a focused button opens the block instead of pressing the button
**Owner decision 2026-10-03:** mimic Logseq. Being implemented (see `docs/progress/keys-small.md`).

**Status:** fixed (`4c233f1`) · **Severity:** low · **Found:** 2026-09-13, keys-in-fields · **Test:**
e2e/tests/keys-in-fields.spec.ts "Enter on a button focused outside the outline presses it, not
the selected block (B-450)" and "click the title, Tab to the History link, Enter follows the link
with a block selected (B-450)"

Select a block (Escape), focus a button outside the outliner (`.help-fab`, focused with
`locator.focus()`; whether a mouse click leaves a button focused differs by engine — not checked),
press Enter: the button is not activated (help menu stays shut) and the
selected block opens for editing — `block.editSelected` matches in the capture-phase dispatcher and
prevents the default. Space does activate the button (nothing binds Space). Backspace on the focused
button deletes the selected block on the server — arguably intended (the selection is still what the
keyboard acts on), which is why this is a decision, not a bug fix: B-300's option (c) named
inputs, textareas and contenteditables only. Candidates: count `button`/`[role=button]`/`a[href]`
as fields for Enter and Space only; or end a standing selection when focus moves to a control
outside the outliner.

Links too, and reachable by keyboard alone (verifier, 2026-09-13, `tools/probes/keys-in-fields-verify.spec.ts`
case F and A): with a block selected, Tab from the page title lands on the "History" link
(`a.page-history-link`); Enter there ran `block.editSelected` (the block opened for editing, focus in
`.cm-content`) and the link was not followed. So "click the title, Tab, Enter" opens a block instead
of the page's history.

---

**Fixed 2026-10-03 (owner decision: mimic Logseq).** What Logseq does, read from its source
(`docs/progress/keys-small.md` has the files and quotes): a window `pointerdown` listener
(`components/container.cljs#hide-context-menu-and-clear-selection`) clears the block selection
unless Shift/Meta is held or the target is an input/textarea, a block or `[data-keep-selection]`;
no focus listener clears it, but Tab is a global shortcut key there that indents the selection, so
keyboard focus never walks out of a selection to a button. `BlockTree.tsx` now (1) copies the
pointer rule, with the chrome that already keeps an editing session alive as the
`data-keep-selection` equivalent, and (2) ends the selection on `focusin` to a button or link
outside the outline — needed because here a field owns Tab (B-300), so "click title, Tab" reaches
the History link with the selection standing, a state Logseq does not produce. Effect: Enter and
Space press the focused control, Backspace there deletes nothing. A click into a text field still
keeps the selection (Logseq's `util/input?` exemption; B-300's tests rely on it). Both e2e tests
were red with the new effect disabled. Unverified: WebKit; Logseq's Tab-indents-selection is read
from its keymap, not run.

### B-585 · B-568's client-side ref-page creation loses keystrokes / mints junk pages / times out restoring — found via a full e2e run, not yet fixed
**Status:** fixed (2026-10-03, `7784d54`) · **Severity:** high (silent data loss) ·
**Test:** the four e2e specs (ref-pages.spec.ts:123, :171, :280; remote-rewrite.spec.ts:344) — now
pass, --repeat-each 3; plus `data/store-apply-ops.test.ts` and `db/worker-core.test.ts`
"WorkerDb.applyLocalOps: pages a write references (B-568, B-585)"

**Confirmed NOT caused by this session's multi-graph work** (ADR 025, B-562 through B-584): `git
stash`-ed the entire working tree back to the last commit (`629f572`, before B-568's client-side
ref-page creation existed at all) and ran these tests in isolation — all passed cleanly (the
`page-delete.spec.ts` case specifically: ~1s, vs. an ~11s timeout on the current tree). Restored the
stash (all work intact) and re-ran the same tests in isolation against the current tree — all still
fail, unrelated to test order (ran alone, not as part of the full suite). So this is a real,
standing defect in B-568's own work (`apps/web/src/data/local-ref-pages.ts` + its integration into
`data/store.ts#applyOps`), sitting uncommitted in the tree since earlier this session, never caught
because nothing ran these specific specs against the full accumulated changes until this
multi-graph verification pass did.

**Root cause, narrowed but not confirmed to the exact line:** `store.ts#applyOps` now calls
`planLocalReferencedPages` — which, whenever the batch's content contains ANY `[[ref]]`/`#tag`
(the common case for these failing tests, not the "references nothing" fast path the module's own
header describes) — awaits a worker round-trip (`pageExists`) and, for each missing name, another
(`workerNextHlc` inside `mint`) before `applyOps` calls `workerApplyOps` at all. This is new
latency `applyOps` never had before B-568 (previously closer to a single worker call). The
"editing one character at a time" case makes this concrete: while `flushPendingEdit()`
(`BlockTree.tsx`)'s own ~500ms debounce is unrelated to and not broken by this, EVERY intermediate
substring of a link being retyped (`"...F"`, `"...Fi"`, `"...Fin"`, ...) is a syntactically complete
`[[...]]` reference to a page that does not exist yet — so once ANY one of these debounced flushes
does land mid-edit (a real Playwright `keyboard.type()` run can be slower than 500ms per
character, or the test may be asserting on an intermediate state), `planLocalReferencedPages` mints
a real page for it, which is the literal junk-page symptom. Separately, `remote-rewrite.spec.ts`'s
lost-keystroke symptom ("[[Probe start]]" instead of "[[Probe start kickoff]]" after typing
continues right after a "Turn into page" command) looks like the SAME added latency landing in a
timing-sensitive window in `BlockTree.tsx`'s `commit()` (used for structural ops, calls
`void applyOps(ops)` un-awaited, then `syncSurfaceFromTree()`) or the `unansweredText`/
`textVersions`/HLC-based reconciliation `createEffect` (lines ~262-300) that exists specifically to
stop a stale refetch from clobbering live typing (B-66/B-192) — plausible that the now-slower
`applyOps` resolves later than before, landing in a window that reconciliation logic was not built
to expect, but this was not confirmed against the actual code path before time was spent instead
writing this diagnosis up. `page-delete.spec.ts`'s restore-from-trash case (found in a second pass)
fits the same pattern — restoring a page recreates it and its blocks, the same
`applyOps`/local-ref-pages-adjacent path, now slow enough that the test's normal poll window reads
as a hang rather than the ~1s the baseline takes. All three symptoms share the same upstream cause
(added async latency in a path that used to be fast, landing in timing-sensitive editor/UI code
that was not written expecting it); whether the FIX is "make the common case in
`local-ref-pages.ts` avoid the round-trip" or "make the editor's debounce/reconciliation robust to
a slower `applyOps`" is an open question for whoever picks this up.

**Not B-585 (2026-10-03):** `autocomplete-inside-link.spec.ts` "Enter on New page inside a link
to a page that does not exist keeps the whole link (B-382)", which `docs/progress/coordinator.md`
listed as "likely" B-585, fails identically on `629f572` (before any B-568 client code) — see B-592.

**Deliberately not fixed in this session's multi-graph pass**: different subsystem (client-side
ref-page creation + CodeMirror/editor debounce interaction), pre-existing in the uncommitted tree
from earlier this session's B-568 work, not touched by ADR 025's server routing/storage/client-list
changes at all. Flagging rather than silently expanding scope, per this repo's own convention —
the e2e specs named above already catch it; whoever fixes it should confirm all of them pass, in
isolation AND as part of a full suite run, before considering this closed.

**Real cause (2026-10-03): two, not one, and the "added latency" theory was half right.** Settled
by two experiments. (A) Keep `store.ts#applyOps`'s planning with every await, but drop the ops it
minted: all three ref-pages tests pass, remote-rewrite:344 still fails — so the junk pages were the
minted `page.create` ops themselves. They carry this device's real id, and the server's junk
cleanup only ever reclaims `REFERENCE_DEVICE_ID` pages, so on a synced device every intermediate
name of a slowly-typed link ("… F", "… Fi", "… Fin", "… Fina" — the failing run's list) and every
page of a deleted link became permanent (B-579, but on every device instead of only local-only
ones). (B) Skip the await for batches that reference nothing: remote-rewrite:344 passes 3/3.
`refactor-host.tsx#write()` does `flushTyping(); await forceSync()`; with an `await` in front of
`db/client.ts#applyOps`, the forceSync message reached the worker first, so the push carried the
block without " kickoff" and the server turned "Probe start" into the page. It also delayed
B-247's crash-safe copy of the batch, and let any batch naming a page be overtaken by a later one.
page-delete.spec.ts passed on fd779f4 before the fix; not reproduced.

**Fix:** planning runs synchronously inside the worker (`WorkerDb.applyLocalOps`, and
`replayLocalOps`), same batch/transaction as before; `store.ts#applyOps` posts at once again.
It runs only when `WorkerDbOptions.localReferencePages` — set by `db.worker.ts` when no server
will see this session's writes (no sync base URL, Capacitor "Just this device"; or no token, the
web/desktop "Just this device"). A synced device leaves minting to the server, as ADR 024 says.
**Consequence to note:** a synced device that is offline no longer gets the page locally until it
syncs (the pre-B-568 behaviour); B-568's reported case (no server) is unchanged —
local-page-creation.spec.ts passes.

### B-596 · Linked-references heading counted every block, not Logseq's number
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13 (B-550's open question); owner
decision 2026-10-03 · **Test:** `apps/web/src/views/ReferencesPanel.test.tsx`,
`apps/web/src/views/referenceNesting.test.ts` "countDirectReferences …",
`packages/server/src/ops/page-backlinks-totals.http.test.ts` "page.backlinks direct references",
`e2e/tests/references-render.spec.ts`

The heading counted every `path_ref` block, so a journal block linking `[[@Alex]]` with ten
children counted 11 (756 on `@alex`, shown as 91 rows). Logseq 0.10.9
(`frontend/components/reference.cljs`, `top-level-blocks` / `filter-n`; read via a fetched summary,
not a local clone) counts blocks whose own refs name the page or an alias, and under a filter shows
"F of T". **Fixed 2026-10-03** (`7d34d03`): `page.backlinks` marks each linked item `direct` and
returns `linked_direct_total`; the panel counts direct blocks (`referenceNesting.ts#countDirectReferences`,
with Logseq's parent add-back under a filter) and reads "F of T" when filtered. Unlinked count
unchanged (Logseq counts every mention too). Details: `docs/progress/refs-count.md`.

### B-380 · Enter on the `#` autocomplete that walking into an existing `#tag` opened duplicates the tag's tail
**Status:** fixed (owner chose option c) · **Severity:** low · **Found:** 2026-09-13, fixing B-294 ·
**Test:** `e2e/tests/autocomplete-inside-tag.spec.ts`; probe `tools/probes/autocomplete-tag-walk.spec.ts`

`- alpha #WalkTagTarget omega`, Home, ArrowRight ×12 (caret after `#WalkT`): the tag autocomplete
opens; Enter picks `WalkTagTarget` and replaces only `WalkT`, giving `alpha #WalkTagTarget!agTarget
omega` (with `!` typed after). The `[[link]]` form was B-294, fixed by replacing through the link's
`]]`. A tag has no closer, and the probe's second case shows what that costs: `- alpha omega`, `#WalkT`
typed straight before `omega`, Enter → `alpha #WalkTagTarget!omega` today; a "swallow the rest of the
tag" rule (text up to a `TAG_STOP` character, `core/tokens.ts`) would delete `omega` there, and the
two cases look identical to the popup (same text before and after the caret). Options: (a) leave it;
(b) swallow the tail only when the popup was opened by caret movement rather than typing (needs
`CommandLayer` to remember how each trigger opened); (c) do not open the `#` popup when the caret is
inside a word that already follows `#`.

---

**Fixed 2026-10-03 (option c, `c6fe3bc`).** The tag popup no longer opens when the text after the caret
continues the tag: `commands/autocomplete/trigger.ts#matchTagTrigger` takes the text after the
caret (passed by `app/CommandLayer.tsx`'s keyup re-detection) and refuses when the run up to the
next tag stop (whitespace, `, ; ) ] } ' "`), less trailing `.!?:`, is non-empty — the same rule
as `core/tokens.ts`. Enter there is a plain Enter (splits the block). Cost, as accepted: `#` typed
straight before a word (`#Wa|omega`) gets no popup either. Caret at the end of a tag, a fresh
`#ta`, and `#[[multi word]]` still open it. **Test:** `e2e/tests/autocomplete-inside-tag.spec.ts`
"walking into an existing #tag opens no popup, and Enter does not duplicate its tail (B-380)" — red
before (popup count 1), green after; three guards green before and after. Unit: `trigger.test.ts`
"matchTagTrigger — caret inside an existing tag (B-380)" (3). Spec R57 updated.

### B-560 · Journal date headings are not clickable
**Status:** fixed (2026-10-03) · **Severity:** low · **Found:** 2026-09-13, owner request ·
**Test:** `apps/web/src/views/JournalStreamView.test.tsx` "links every day heading to that day's
page, under the graph prefix too (B-560)" (failed before the fix); `e2e/tests/journal-heading-link.spec.ts`
(3 tests, incl. keyboard and a non-default `/g/<slug>` graph).

"Clicking on the date in journal should make it focus on the page with the date, i.e. headings with
dates should be clickable." In the journal stream each day's heading (`.journal-day-title`) is plain
text; clicking it should open that day's page (`/page/<ISO date>`), as Logseq does.

---

**Fixed 2026-10-03** (`9f41585`): each day heading's text is a router `<A>` to
`pageRoutePath(isoJournalName(day))` (`JournalStreamView.tsx#DayTitleLink`): upcoming, today (also
while virtual), pinned and earlier days. Styled as the heading (`.journal-day-link`: inherited
colour, underline on hover only). Found along the way: B-595.

### B-591 · `biome check .` is not clean on `main`: five a11y lint errors in three files
**Status:** fixed · **Severity:** low (lint only) · **Found:** 2026-10-03, coordinator cleanup pass ·
**Test:** `pnpm exec biome check . --diagnostic-level=error` is the test

`pnpm exec biome check .` exits 1 on `629f572` (checked in a clean worktree of that commit, not just
the dirty tree): `BlockContextMenu.tsx:165` (`useSemanticElements` on the `role="separator"` div),
`BlockRowView.tsx:131` (`noStaticElementInteractions` on the row), and three in
`DiagnosticsPanel.tsx`'s backdrop, whose `biome-ignore` comment sits one line too low (biome also
reports it as an unused suppression). `HelpMenu.tsx:130,190` carries suppressions biome calls unused.
Earlier "biome clean" claims in progress files were per-package or per-file runs, not the whole
repo. The same pass removed the other four errors — formatter noise in generated files — by
excluding `apps/desktop/src-tauri/gen` and `apps/web/ios` in `biome.json`.

**Fixed 2026-10-03** with correctly placed `biome-ignore` comments, each giving the real reason, on
BlockContextMenu's separator, the BlockRowView row, and the DiagnosticsPanel backdrop and dialog. The
misplaced DiagnosticsPanel suppression and two unused HelpMenu suppressions are removed. DOM, roles
and handlers are unchanged. Verified: `pnpm exec biome check . --diagnostic-level=error` exits 0,
which is the test. Found along the way: B-594.


### B-590 · Two calendar tests (unit and e2e) fail on the 3rd of every month
**Status:** fixed · **Severity:** low (test only) · **Found:** 2026-10-03, full `pnpm -r test` on
that date · **Test:** `apps/web/src/shell/CalendarButton.test.tsx` (the two tests themselves)

The test picked "day 3 of the current month" as a day that is never special, and commented that it
held "regardless of what now is". But picking Today deliberately clears the pin
(`app/journal-nav.ts#pinJournalDay`), so on any 3rd both "picking a day pins it…" and "does not
navigate away…" saw `undefined` instead of the day. Fixed by choosing day 4 when today is day 3.
Verified by running the file on 2026-10-03, where it had failed: 6/6 pass.

Sibling in e2e, same date: `e2e/tests/views.spec.ts` "the calendar popover marks days that have
journal content, and leaves others plain (B-583)" asserted day 3 was plain, but on a shared e2e
server other specs write journal days at offsets 0..12 from today, so on the 3rd it had content
(failed in the 2026-10-03 full run). The test now looks up a day of the month with no content via
`page.read` before asserting. Passes alone and after `journal-agenda.spec.ts`; not yet re-confirmed
inside a full-suite run on a 3rd.

### B-589 · `pnpm nooklet serve` crashes the whole process on an ordinary client disconnect during a WebSocket upgrade
**Status:** fixed · **Test:** `tools/probes/upgrade-socket-error.mjs` (isolates the
exact mechanism; `--fix` flag toggles the patch) · **Severity:** critical (the entire server dies —
every client, every graph it hosts — from one ordinary client-side disconnect, not misbehavior) ·
**Reported:** 2026-09-16, owner, verbatim, with the crash log: "and then open the app the serve
crashes?"

```
node:events:505
    throw er; // Unhandled 'error' event
Error: read ECONNRESET
    at TCP.onStreamRead (node:internal/stream_base_commons:216:20)
Emitted 'error' event on Socket instance at:
    at emitErrorNT (node:internal/streams/destroy:170:8)
    at emitErrorCloseNT (node:internal/streams/destroy:129:3)
```

Root cause: `@hono/node-server@2.1.1`'s own `setupWebSocket()` (the code behind `serve()`'s
`websocket` option, which `packages/server/src/cli.ts`'s `serve` case uses for `/g/<id>/sync/live`
and `/g/<id>/ui/live`) registers `server.on("upgrade", async (request, socket, head) => { ... })`
— it `await`s the app's own `fetch` callback (our auth + multi-graph dispatch, ADR 025; genuinely
slow the first time a graph is resolved) BEFORE calling `wss.handleUpgrade()`, and never attaches a
`socket.on("error", ...)` listener for the whole time that is in flight. A client that resets the
TCP connection during that window — a page navigating away mid-handshake, a reconnect loop
superseding its own earlier attempt, nothing exotic — fires an unhandled `'error'` event on the raw
socket, which Node treats as fatal with no listener: the entire process dies, taking down every
client's connection to every graph the server hosts, not just the one that disconnected.

Confirmed the exact mechanism, not just a plausible-sounding theory: isolated
`@hono/node-server`'s precise `server.on("upgrade", ...)` pattern in a minimal standalone server
(`tools/probes/upgrade-socket-error.mjs`) and reproduced the IDENTICAL stack trace on demand by
resetting a real TCP connection mid-handshake. Also read `@hono/node-server`'s own source directly
(`node_modules/.pnpm/@hono+node-server@2.1.1.../dist/index.mjs`, `setupWebSocket`) and confirmed it
never calls `socket.on("error", ...)` anywhere in that function. Attempting to force the crash
against the REAL server (raw-socket race probes, 200+ concurrent connect-then-reset attempts
against both warm and cold graphs, a real Chromium browser abruptly closed mid-navigation, and the
real compiled desktop app pointed at a scratch instance) did NOT reliably reproduce it on demand —
the real app's async window is apparently narrow enough that only one ambient occurrence (this
session's own scratch server, coinciding with an already-running desktop dev session on the same
port) was actually caught in the act — but the isolated repro proves the mechanism is real and
exact, independent of how hard it is to force in practice, and the fix is unconditionally safe
regardless of the precise trigger.

Fix: a SECOND `'upgrade'` listener, registered on the same `http.Server` `serve()` returns (`cli.ts`
now captures it instead of discarding the return value), that attaches `socket.on("error", () =>
{})` on every upgrade attempt. Verified this still closes the gap even though it is registered
*after* `@hono/node-server`'s own listener: Node's `EventEmitter` calls listeners synchronously in
registration order for one `emit()`, and an async listener only yields control at its first
`await` — so the second (synchronous) listener always runs before the first listener's async
continuation can ever resume, regardless of how long that continuation's work takes. Confirmed via
the same probe (`--fix` flag) that the identical scenario now survives, and confirmed a normal WS
connection through the real server still opens, exchanges messages, and closes cleanly with the fix
in place — this isn't just "swallow all upgrade errors," it targets exactly the pre-handshake gap
the vulnerability lives in.

2026-10-03: the guard moved to `http/upgrade-guard.ts` (attached at `'connection'`) as part of B-602's fix.

### B-588 · Desktop picker (local/server switch) made the owner manually quit and reopen the app every time
**Status:** fixed · **Test:** `e2e/tests/desktop-launcher.spec.ts` (B-584's regression
case, exercises the same `restart_app` path) · **Severity:** low (annoying, not broken — the app
worked, it just made the owner do a manual step it could do itself) · **Reported:** 2026-09-16,
owner, verbatim: "why is there this 'nooklet will quit now' after selection of local mode or server
mode. Can we not do it? super annoying."

Every confirmation in the desktop picker (`apps/desktop/launcher/index.html`) — picking a graph,
adding a server — and `Switch Server…` from the menu bar ended with `quit_app`, a plain
`app.exit(0)`: real, necessary (which server to spawn/connect to is decided once, at process start),
but the owner then had to go find the dock icon and reopen the app themselves every time.

Fix: `quit_app` renamed `restart_app`, now calling Tauri's `AppHandle::request_restart()` instead of
`exit(0)` — the app relaunches itself; the owner never has to. `request_restart()` (not the noreturn
`restart()`) is the version documented as reliable from any thread, and it still delivers
`RunEvent::Exit` first, so a spawned local server child is still killed cleanly before the restart,
same as the old quit did. Used both by the picker (`finishAndRestart`, renamed from `finishAndQuit`)
and by `MENU_SWITCH_SERVER`, so neither path needs a manual reopen any more. The "Saved" message
changed from "nooklet will quit now. Open it again to use this setting." to "Saved — restarting
nooklet to apply it…", so the window closing and reappearing reads as expected rather than
perplexing.

**Found in passing**: `e2e/tests/desktop-launcher.spec.ts`'s B-584 regression test had gone stale
during the M6 list-based picker rewrite (`docs/progress/multi-graph-hosting.md`'s M6 section) — it
still injected the pre-M6 `remoteUrl` shape and clicked `#choice-local`, an id that rewrite removed,
and stubbed the now-gone `set_remote_server`. Never re-run against the M6 tree until fixing this.
Updated alongside this change; full detail in the progress doc.

**Verified for real**: `cargo test` (11) and the e2e spec (5) both green; then, since no test proves
an OS process actually restarts, a real devtest `.app` (custom probe page via a `frontendDist`
override, never touching the real launcher) called `restart_app` repeatedly and confirmed via `ps`
that each call produced a genuinely new process with a new PID while the old one cleanly exited.
Full method in the progress doc's M6 follow-up section.

**Follow-up, same conversation**: owner, immediately after — "I also ideally want some kind of a
'periodic check' on a page with selection of mode in case some server becomes available again."
When the picker shows because the ACTIVE entry stopped answering (not `forcePicker`/"Use a
different server…" — a deliberately-opened picker is never auto-navigated out from under a choice
being made), `launcher/index.html` now re-checks that address every 3s in the background
(`scheduleRecheck`/`stopRecheck`, independent of the `loop()`/`loopStopped` machinery that exists to
REACH the picker, not leave it) and, the moment it answers, shows "‹address› is back —
reconnecting…" and navigates there on its own — no click needed. Verified for real, not just by
reading the code: a devtest `.app` pointed at a port nothing was listening on yet (confirmed the
picker's error state, no navigation); started a throwaway HTTP server on that exact port a few
seconds later; confirmed, with zero manual interaction, the app navigated there within one recheck
interval — proven the same way the M6 injection contract was earlier, by having that page report
back what `window.__NOOKLET_DESKTOP__` actually contained.

### B-586 · Switching to a same-origin graph under a different `/g/<slug>` prefix updates the data source but never the URL, leaving the router and every generated link pointed at the OLD graph
**Status:** fixed · **Test:** `e2e/tests/graph-switcher.spec.ts` (both cases; failed
against the pre-fix code with the exact URL mismatch below, passes now) · **Severity:** high (any
link click, share, or bookmark after this happens silently serves the WRONG graph's content, or a
404) · **Found:** 2026-09-15, writing `e2e/tests/graph-switcher.spec.ts` (M5's own verification step
for ADR 025) — the very first real run of "add an existing remote graph" against a second
same-origin graph failed immediately:
```
Expected pattern: /\/g\/gs-second\//
Received string:  "http://127.0.0.1:6389/g/default/journals"
```

`shell/GraphSwitcher.tsx`'s `switchTo`/`addServer`/`submitPromote` and `views/ConnectView.tsx`'s
`connect` all finish by calling `location.reload()` — which reloads whatever path the browser is
currently on. That is correct when the new graph lives on a different ORIGIN entirely (Capacitor,
where `apiBaseUrl()` returns an absolute URL and the page itself never had a `/g/<slug>` prefix to
begin with), but wrong whenever the new graph is same-origin with a DIFFERENT slug than the one the
page is currently rendered under — the situation any web/desktop user hits the moment they add or
switch to a second graph on the same server. `data/bootstrap.ts#apiBaseUrl()` correctly resolves to
the new entry's `baseUrl` (so the API calls a reload's `initBootstrap()` makes DO reach the right
graph), but `App.tsx`'s `<Router base={samePathGraphPrefix() ?? ""}>` reads the prefix off
`location.pathname`, which a bare reload never changes — so the app ends up fetching graph B's data
while the router, the address bar, and every `rawAnchorHref()`-generated link stay stamped with
graph A's `/g/<slug>` prefix. The very next full navigation (a link click, a bookmark, a shared URL)
goes to `/g/<A>/...` and the server's own routing (`packages/server/src/graphs/mount.ts`) genuinely
serves graph A, not B — not a display glitch, a real wrong-graph response.

Fix: a shared `graphEntryUrl(entry, location)` helper in `data/bootstrap.ts` builds the correct
destination (the entry's own `baseUrl` — absolute or `/g/<slug>` — plus the CURRENT app-relative
path, via `appRelativePathname(location.pathname)`, plus `location.search`/`hash`);
`GraphSwitcher.tsx`'s three post-mutation call sites (`switchTo`/`addServer`/`submitPromote`, plus
`addLocalOnly` for consistency) go through a new `goToActiveGraph()` that navigates there
(`location.assign`, a real navigation, so a same-URL case still reloads exactly like the old
`location.reload()` did) instead of blindly reloading in place. `ConnectView.tsx` needed no
equivalent change — it only ever pairs a token to the graph the page is ALREADY serving (web) or
sets an absolute Capacitor `baseUrl` with no path prefix involved either way, so it can never
introduce the same-origin-different-slug mismatch this bug is about. `GraphSwitcher.test.tsx`
updated to mock `location.assign` instead of `location.reload` and assert the destination URL, not
just that a reload happened. `e2e/tests/graph-switcher.spec.ts` is the regression test — it failed
against the pre-fix code with the exact URL mismatch above.

**Found in passing, NOT itself a real bug:** the promote test also failed the first time it was
attempted for an unrelated reason — its own seeding technique (a bare `kind: "local"` entry injected
directly into `nooklet.graphs`, simulating Capacitor's "Just this device" from a plain web
browser) sat on a page still served from `/g/default/...`, so `apiBaseUrl()`'s fallback to
`samePathGraphPrefix()` silently resolved `/api/session` against graph "default" and stamped
its `graphInstanceId` onto the entry — read as a genuine mismatch once promote later pointed the
same entry at the real, different-identity `gs-promoted` graph, and `GraphMismatchView` rendered
instead of the journal. Confirmed this can't happen for a real user: it requires a `kind:"local"`
entry with no `baseUrl` viewed from a page that DOES have a `/g/<slug>` prefix, which only Capacitor
can produce that entry shape for, and Capacitor pages never have such a prefix
(`samePathGraphPrefix()`'s own doc comment). Fixed in the test itself (mocks `/api/session` during
the local-only phase, unrouted before promoting — see the comment in
`e2e/tests/graph-switcher.spec.ts`), not in application code.

### B-584 · Picking "Just this device" from the desktop picker, after "Switch Server…", hung forever on "Starting nooklet…"
**Status:** fixed · **Severity:** high (app becomes unusable — no way back into a
local graph from the picker without force-quitting) · **Found:** 2026-09-15, owner report,
verbatim: "ok, seems to work, but when i click on just this device, it just shows 'nooklet is
starting' and never starts." · **Test:** `e2e/tests/desktop-launcher.spec.ts` (new case, below).

`main.rs`'s `setup()` decides once, at process start, whether to spawn the bundled server. When
`show_picker` is true (the one-shot sentinel `MENU_SWITCH_SERVER` leaves for the next launch, see
`picker_sentinel_path`), it deliberately takes the "nothing local to spawn" branch and never calls
`spawn_server` — `ServerProcess.status` sits at its unused `Starting` default all launch, per that
branch's own comment ("nobody asks it anything in this branch"). The launcher
(`apps/desktop/launcher/index.html`) shows the picker outright in that case (`forcePicker`).

The `choice-local` ("Just this device") handler only relaunched the app (`finishAndQuit`, which
quits so the next launch starts clean) when `remoteUrl` was set — i.e. when switching *away from* a
configured remote server. It treated every other case, including "already local, re-confirmed
local from the forced picker," as a no-op (`cancelPicker()`, resume polling in place). But nothing
was running to poll: this launch never spawned a server, so `server_status` answers `Starting`
forever and the launcher's own poll loop (300ms while "starting") spins with no way to ever leave
that state — exactly the reported hang. (Coming from remote mode did work, because that path always
relaunched via `finishAndQuit`, which happens to land on a normal, spawning launch next time.)

Fix: `choice-local`'s no-relaunch fast path now requires `!forcePicker` too, not just `!remoteUrl` —
`forcePicker` is precisely "this launch skipped spawning," so any launch reached via `Switch
Server…` must quit and relaunch on "Just this device" regardless of whether a `remoteUrl` was
previously configured, to reach a normal launch that actually spawns the local server.
`e2e/tests/desktop-launcher.spec.ts` gained a case with `forcePicker: true`, `remoteUrl: null`,
`server_status` stubbed to stay at `starting` forever, and `quit_app` stubbed to record whether it
was called: clicking "Just this device" now calls `quit_app` (proving the relaunch path was taken)
instead of leaving the page polling a status that will never change. Confirmed the test fails
against the pre-fix handler (times out waiting for `quit_app`) and passes after.

**Found in passing while writing that test:** `desktop-launcher.spec.ts`'s three pre-existing
`page.locator("h1")` assertions had silently gone strict-mode-ambiguous — the standalone-vs-remote
picker markup (added earlier this session, B-563/remote mode) put two more `<h1>` elements in the
DOM (`hidden` on an ancestor, but still present and still matched by a plain CSS locator), and this
spec was never re-run against that change until now. All three broke with the picker markup in
place, unrelated to B-584 itself. Fixed by scoping them to `#title` (the status page's own
heading), the only one of the three `<h1>`s with an id.

### B-583 · The journal calendar was a full-width inline toggle at the top of the stream, not the small top-bar popover PLAN.md's UI called for
**Status:** fixed · **Severity:** low (cosmetic/IA, not data-affecting) ·
**Found:** 2026-09-15, owner report, verbatim: "calendar selector should be smaller, should be icon
at the top bar next to cloud. and should open a small popup ideally distinguishing dates for which
there is something in their journal pages." · **Test:** `shell/CalendarButton.test.tsx` (new,
6 cases: trigger shape, Escape-to-close, content-day marking, live range on month paging, pin+jump
navigation from elsewhere, no navigation when already on `/journals`); `views/JournalStreamView.test.tsx`'s
B-177 case updated to pin through the shared signal directly instead of clicking now-removed UI;
e2e — `e2e/tests/views.spec.ts` (month nav + close, content-marking, both new), plus
`pages.spec.ts`, `templates.spec.ts` and `journal-day-start.spec.ts`'s own `calendarPick` helpers
updated to click the new trigger — all run for real against `nooklet serve` and passing.

The calendar used to be `JournalStreamView.tsx`'s own inline "Calendar"/"Hide calendar" toggle
button, opening a full-size grid inline at the top of the stream — taking a full row of vertical
space even when closed, and only reachable from `/journals` itself. It also had no way to tell,
before clicking through, which days actually had something written on them.

Fix: moved the trigger into the top bar as a small icon (`shell/CalendarButton.tsx`), placed next
to `SyncIndicator` per the owner's own words, mirroring `live/ConsentBadge.tsx`'s icon+anchored-
popover shape rather than a full modal — a calendar is a quick jump, not a destination. The old
inline toggle+grid was removed entirely from `JournalStreamView.tsx` rather than kept alongside the
new one: a calendar reachable in two places, one of them a whole row of space in the stream, was
worse than one clear entry point, consistent with this codebase's existing avoid-redundant-surfaces
stance (`PaletteButton.tsx`). Since the trigger is no longer a child of `JournalStreamView`, picking
a day now writes to a new shared module-singleton signal (`app/journal-nav.ts`, same pattern as
`live/consent.ts`) instead of local component state, and — new behavior the old inline placement
never needed — jumps to `/journals` first if invoked from elsewhere (`useLocation`/`useNavigate`).

Which days have content is a new `data/store.ts` hook, `useJournalDaysWithContent(firstDay,
lastDay)`, bounded to the popover's own visible month (not scanning the whole graph): pages with a
`journal_day` in range that have at least one non-deleted block. `views/Calendar.tsx` grew
`daysWithContent`/`compact`/`onMonthChange` props to render the dot and the smaller size without
forking the component.

**e2e caught a real, visible bug unit tests couldn't:** the popover's CSS positioned it `right: 0`
of its own wrapper (copied from `live/live.css`'s `.vr-live-popover`, whose icon sits at the *far
right* of the top bar). The calendar icon sits near the *left* of the top bar instead (before the
sync indicator), so a right-anchored popover overflowed entirely off the left edge of the viewport
— every day cell before roughly the 20th of the month, and both month-nav buttons, were outside the
visible page and unclickable. `views.spec.ts`'s month-navigation test failed with Playwright's
"element is outside of the viewport" on the very first real run; a screenshot confirmed the popover
was clipped at x=0. Fixed by anchoring `left: 0` instead. This would not have been caught by the
component test suite (jsdom has no real layout/viewport).

**Note:** per the task this was executed under, no commit was made — the working tree has these
changes staged as edits only (`apps/web/src/shell/CalendarButton.tsx` and `calendar-button.css`
new; `views/Calendar.tsx`, `AppShell.tsx`, `JournalStreamView.tsx`, `JournalStreamView.test.tsx`,
`data/store.ts`, `styles/views.css` modified; `app/journal-nav.ts` new; the four e2e spec files
above modified). Whoever commits this should keep this entry's Status as `fixed` once it lands.

### B-582 · The very first worker call after page load could lose a startup race and throw, silently breaking whatever depended on it
**Status:** fixed · **Severity:** high (app-wide — any first-render worker call, not just the
sidebar) · **Found:** 2026-09-15, owner report: "clicking on the sidebar icon in desktop app doesnt
open the sidebar" — reproduced independently in a plain browser (not Tauri-specific), root-caused,
fixed, and verified fixed, all against the real client · **Test:**
`e2e/tests/worker-init-race.spec.ts` (reproduces the exact failure mode against a real Worker/
Comlink boundary — confirmed failing before the fix, passing after) plus an updated
`db/client-unapplied.test.ts` case for the now-correct call ordering.

`db/client.ts`'s worker-backed functions (`query`, `getPageTree`, `getJournalStream`, `nextHlc`,
`getDeviceId`, `applyOps`, `getSyncStatus`, `forceSync`) called `getWorker()` directly — which only
lazily creates the `Worker`/Comlink proxy, saying nothing about whether `WorkerApi.init()` had
actually been dispatched to it yet. `main.tsx` calls `initDb(...)` and renders `<App/>` in the same
tick without awaiting it, so the app's very first render always raced its own resources against
`init()` completing — a race `init()` used to win by luck. Option C's `readCheckpoint()` step
(`docs/proposals/004-capacitor-storage-durability.md`, earlier this session) added one more
microtask hop before `api.init(...)` is even dispatched, enough to make the race reliably lose:
`db.worker.ts`'s `requireRetry()` throws `WorkerApi.init() must be called before any other method`
for any call that arrives first, an uncaught error that silently prevents Solid from rendering
whatever depended on it — which is why this looked like "the sidebar button does nothing" rather
than an obviously worker-wide failure; `Sidebar.tsx`'s data happened to be what the owner's repro
hit, but any first-render worker call was equally affected. Diagnosed directly (a Playwright probe
with console/page-error capture — `body has sidebar-open class: true` but `aside.app-sidebar count:
0` and three `WorkerApi.init()...` page errors), not guessed.

Fix: a `readyWorker()` helper (`db/client.ts`) that awaits `initDb()` — idempotent, so this always
awaits the one real init `main.tsx` already kicked off, never starts a second one — before every
worker call. `applyOps` keeps its unapplied-ops write (B-247) synchronous and *before* this await,
unchanged; only the worker dispatch itself now waits.

---

### B-580 · `pnpm desktop` silently serves a stale sidecar bundle, with zero warning
**Status:** fixed · **Severity:** high (caused real, extended debugging confusion this session) ·
**Found:** 2026-09-15, coordinator — the owner reported B-568's fix "not working" and an old
(pre-B-540) text-pill consent badge on the desktop app; both were explained entirely by
`apps/desktop/sidecar/web/` being **two days stale** (dated Sep 13), never rebuilt during this whole
session's work · **Test:** none yet (a build-pipeline gap, not application logic)

The desktop Tauri app does not read `apps/web/dist` directly — `main.rs#spawn_server` launches the
sidecar from `apps/desktop/sidecar/`, a separate copy `build-sidecar.mjs` assembles (`web/` among
several other pieces: `server.mjs`, a bundled `node`, `vec0.dylib`, `esbuild`, built-in plugins).
`desktop:build` (root `package.json`) runs `pnpm --filter @nooklet/desktop run sidecar` before
`tauri build`, so a full production build always picks up fresh source — but plain `pnpm desktop`
(`tauri dev`, what this session's own instructions recommended for iterating) does **not**, and
nothing about the running app hints that its `web/` is stale; it just quietly serves whatever was
last assembled, however old. `apps/web/dist` being rebuilt (the ordinary web/PWA/iOS build step used
throughout this session) has no effect on it at all — two entirely separate staleness traps stacked
on each other is what actually produced the confusion.

Fix: `desktop` (root `package.json`) now runs the sidecar step first too, matching `desktop:build`'s
already-correct pattern — `dev` no longer has a cheaper, staler path than `build`.

---

### B-578 · Graph hidden on Capacitor for now
**Status:** done (product decision, not a bug) · **Severity:** — · **Found:** 2026-09-15, owner,
after seeing B-577's Graph error: "also graph showing some nonsense? (not sure we need it on the
ios)", then "hide the graph for now" · **Test:** verified by rebuild + Simulator boot

The Graph nav item (`shell/Sidebar.tsx`) and the `/graph` route (`App.tsx`) are hidden/redirected
(to `/journals`) whenever `platform.name === "capacitor"` — not conditional on sync mode, a direct
"hide it on iOS" per the owner's own phrasing. `graph.links` is entirely server-dependent regardless
of sync target, and arguably isn't a natural phone surface either way. B-577's fix still applies
everywhere `callOp` is reachable, in case this decision is revisited.

---

2026-10-03: `nav.graph` (the "⋯" menu's Graph, and "Open graph" in the palette) is left out of the registry on Capacitor (`app/CommandLayer.tsx`).

### B-577 · Server-dependent views show a raw, alarming error instead of calm "needs a server" messaging in local-only mode
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-15, two owner screenshots on the same
Simulator session: the References panel showing "Couldn't load references. Retry" in red under a
freshly-typed `[[ref]]`, and the Graph view showing a raw red error line containing
`capacitor://localhost` over an empty graph box. · **Test:** `data/api-client.test.ts` ("B-577:
callOp fails fast with no fetch at all when there is no sync target", 5 cases across every
`apiClient`/`undoBatch` op), `views/SearchView.test.tsx` (1 new case) — 1348/1348 full suite passing.

The third occurrence of the exact pattern B-571 already fixed once for the sync indicator/
Diagnostics: a feature that genuinely needs the server (`data/api-client.ts`'s own doc comment lists
`search`, `page.backlinks`, `graph.links` as "the read ops the local replica cannot answer on its
own") fails in local-only mode — correctly, there's nothing to reach — but the failure renders as a
raw, technical, alarming error (`ReferencesPanel.tsx`'s "Couldn't load references", `GraphView.tsx`
surfacing the fetch's own `capacitor://localhost` URL in the message) rather than calm, expected
messaging. B-571 fixed this for exactly two places (the sync indicator, Diagnostics) by checking
`data/bootstrap.ts#hasSyncTarget()` at each call site — doing that again per-surface for References,
Graph, Search, and whatever else calls through `data/api-client.ts#callOp` doesn't scale and *will*
miss one (this entry exists because it already did, twice).

Fixed at the source: `data/api-client.ts#callOp` now checks `hasSyncTarget()` and, when false,
throws a dedicated `ApiError` (`NO_SYNC_TARGET_CODE = "no_sync_target"`) before ever attempting the
fetch — no more `capacitor://localhost` leaking into user-facing text, since the fetch never
happens. `ReferencesPanel.tsx`, `GraphView.tsx`, and `SearchView.tsx` (found while searching for
other affected surfaces, exactly as expected — confirmation the fix belongs at this layer, not
scope creep) all render a calm, muted message on that specific code instead of their alarming
failure state, leaving the real-failure path (a configured server that's actually unreachable)
unchanged. **Not yet covered**: `SettingsPanel.tsx`'s three `callOp`-backed resources (embeddings
status, diagnostics/about, templates) will now also throw the same fast-fail error but weren't given
calm rendering in this pass — same pattern, deliberately left for a follow-up rather than expanding
this one further.

---

2026-10-03: the Search branch is superseded by local-first search (local-only now searches the device). References/graph branches unchanged.

2026-10-04: its References and Graph branches are superseded too — local-only shows references and draws the graph from the device (B-641). Graph stays hidden on Capacitor (B-578).

### B-576 · Sidebar drawer cannot be closed by tapping outside it
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-15, owner report: "also it cannot be
closed by clicking outside of it" · **Test:** none — the tap-to-close interaction itself needs a
real device/simulator tap, which nothing in this environment can automate (same limitation as this
session's other on-device-only findings); verified only that the build still boots correctly

Every other overlay in this app — Settings (`set-backdrop`), Diagnostics (`diag-backdrop`), the help
menu (`help-backdrop`) — is a backdrop `<div>` with `onClick={onClose}` wrapping the panel. The
sidebar has no equivalent: `shell/AppShell.tsx` renders `<Sidebar />` directly, and it's shown/hidden
by toggling a `sidebar-open` class on `<body>` (`Sidebar.tsx`'s own header comment), not by mounting/
unmounting behind a dismissible backdrop. On desktop this is invisible — the sidebar sits in-flow,
squeezing the content, so there's no "outside" to tap. On phone (`position: fixed`, overlaying
content per B-575's same media query) it's a real, expected drawer interaction that's simply missing.
Fix: add a backdrop element for the phone-width case (or a document-level click-outside listener
while `sidebar-open`), following the existing `*-backdrop` pattern rather than inventing a new one.

---

### B-575 · Sidebar drawer has no safe-area padding on phone — content sits under the status bar / Dynamic Island
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-15, owner screenshot on the Capacitor
iOS Simulator: the sidebar's first row ("Command palette") renders partly behind the status bar
time and the Dynamic Island. · **Test:** verified by rebuild + Simulator boot (screenshot); no
automated test (a phone-width CSS regression, same category as B-562, which also has none)

Same class of bug as B-562 (`ConnectView`), fixed earlier this session, but a different component
that was missed: `shell/sidebar.css`'s phone-width rule (`@media (max-width: 44rem)`) makes
`.app-sidebar` `position: fixed; inset: 0 auto 0 0` — pinned to the physical top of the screen — with
no `env(safe-area-inset-top)`/`--sat` in its padding. `styles/shell.css` already defines `--sat` on
`:root` (the same token B-562's fix used), so it's available here too; `sidebar.css` just isn't using
it in the phone-width block. Fix: add `var(--sat)` to `.app-sidebar`'s top padding/inset, phone-width
rule only — the desktop layout (in-flow, not fixed) doesn't have this problem and shouldn't change.

---

### B-574 · `ResumeRetry` stays armed after a successful call, wider masking window than documented
**Status:** fixed · **Severity:** low · **Found:** 2026-09-15, coordinator reviewing B-573's
`reopen-on-resume.ts` before reporting it done · **Test:** `reopen-on-resume.test.ts`, "a successful
call after resume disarms it — a later unrelated failure does not reopen"

The file's own doc comment claims the retry "disarms itself the moment either a retry is attempted
or a call succeeds without needing one" — only the first half was implemented. `armed` was set back
to `false` inside the catch/retry path but never on a plain successful call, so after one `resume`
event it stayed `true` indefinitely until *some* call eventually failed — at which point an entirely
unrelated bug, possibly much later, would get one spurious reopen-and-retry cycle before propagating
(not silently swallowed forever, since a second failure still propagates per the existing "disarms
after one retry" test, but a real error gets an unnecessary detour and confused diagnostics). Fix:
reset `armed = false` on the successful path too, matching the doc comment exactly.

---

### B-573 · "Just this device" storage has no eviction backstop — `docs/PLAN.md`'s iOS mitigation assumed a server always exists
**Status:** fixed (for automatic eviction and the documented backgrounding failure; user-initiated
clearing and app uninstall are explicitly out of scope — the owner's own call: "user initiated
clearing is totally fine of course, that's their mistake. same on uninstall... it's fine") ·
**Severity:** high · **Found:** 2026-09-14, coordinator, answering an owner question about whether
local-only mode persists durably · **Test:** `db/reopen-on-resume.test.ts` (7 cases, after B-574),
`db/sqlite-wasm-driver.test.ts` (3 cases), `db/capacitor-checkpoint.test.ts` (6 cases) — the actual
backgrounding scenario cannot be verified without a real device/simulator background cycle, which
nothing in this environment can automate; a rebuild+boot was verified not to break startup with the
new code and dependency, but B itself (reopen-on-resume) needs an owner-driven manual test.

The iOS Capacitor build's storage today is the same as the PWA's — SQLite-WASM over OPFS
(`opfs-sahpool`), real on-disk persistence, not memory — see `platform/capacitor.ts`'s trailing doc
comment for why native SQLite isn't wired up yet. `docs/PLAN.md`'s risk table has always carried
"iOS storage eviction" with mitigation *"Server is truth; outbox flushed within seconds; snapshot
re-bootstrap"* — which assumes a server exists to re-bootstrap from. B-563 (this session) made
"never configure a server" a first-class, supported, encouraged choice on the very first screen a
new device sees. For that device, if iOS ever evicts its local storage under disk pressure — a real
iOS behavior, not hypothetical — there is nothing to recover from; the notes are simply gone. Related
to B-571 (the UI should at least be honest that this mode has no backup) and to the multi-graph
proposal this session also started (`docs/proposals/003-independently-started-graphs.md`) — both are
the same underlying theme: local-only was added as a UX choice without revisiting the durability
assumptions the rest of the design was built on. Also turned out to be a smaller, more specific
problem than "eventual eviction": PowerSync's own report says OPFS access handles close every time a
Capacitor app backgrounds, not just under rare disk pressure — see
`docs/proposals/004-capacitor-storage-durability.md` for the option analysis and a recommendation
(reopen-on-resume + a native-filesystem backstop, short of the full async-driver rewrite).

Implemented (Options A–C of that proposal), 2026-09-15:
- **A**: `platform/capacitor.ts`'s `persist()`/`persisted()`/`estimate()` now call the real
  `navigator.storage` APIs (were hardcoded no-ops), same implementation as `platform/web.ts`.
- **B**: `db/reopen-on-resume.ts` — a generic one-retry-after-`resume` wrapper (`ResumeRetry<T>`),
  wired into every `db.worker.ts` API method in place of the old bare `requireDb()`. Armed by
  `notifyLifecycle("resume")`, disarmed after one retry attempt either way, so a real second failure
  propagates rather than looping. Fully unit-tested with fakes; the actual OPFS-closes-on-
  backgrounding trigger itself is unverified outside a real device.
- **C**: `db/capacitor-checkpoint.ts` (new `@capacitor/filesystem@8.1.3` dependency) — a debounced
  (60s after a write, immediate on `pause`) export of the live SQLite bytes
  (`sqlite3.capi.sqlite3_js_db_export`, exposed via a new `WorkerApi.exportSnapshot()`) to native
  app-sandbox storage, and a restore path on startup (`sqlite-wasm-driver.ts`'s
  `shouldRestoreCheckpoint`: only into a pool with nothing under the replica's filename yet — never
  over an existing replica, and app uninstall wipes the checkpoint too, so this combination can only
  mean genuine automatic eviction, per the owner's explicit scoping above). Verified: full rebuild +
  simulator boot with the new plugin bundled does not break startup (screenshotted). Not verified:
  an actual eviction-then-restore cycle, which needs a real device.

---

### B-572 · The app randomly pinch-zooms on its own, cutting off parts of the UI
**Status:** fixed (believed — the specific mechanism is addressed, but the actual "does the random
zoom stop happening" needs the owner's own device use to confirm, same as this session's other
gesture/backgrounding-dependent fixes) · **Severity:** medium · **Found:** 2026-09-14, owner feedback
on the Capacitor iOS build: "it somehow weirdly zooms in/out putting some parts of the app out of the
focus." · **Test:** none — a real-device gesture-timing bug, not something a unit or component test
can exercise; verified only by confirming the build still boots after the change (Simulator
rebuild+screenshot) and by reading `editor/gestures/` to confirm no conflict (below).

`apps/web/index.html`'s viewport meta tag is `width=device-width, initial-scale=1, viewport-fit=cover,
interactive-widget=resizes-content` — no `maximum-scale=1`/`user-scalable=no`, and no global
`touch-action` CSS constraining it either. That leaves WebKit's own pinch-zoom AND double-tap-to-zoom
gestures live over the whole app; a real device log captured earlier this session while a normal tap
landed showed WebKit's own gesture recognizer explicitly evaluating a double-tap-driven zoom on an
ordinary tap ("Potential tap may cause significant zoom. Wait." / "Single tap identified. Request
details on potential zoom.", `com.apple.WebKit:ViewGestures`) — consistent with two taps landing
close together in time/position (not unreasonable during normal use) being misread as the start of a
zoom gesture, not a deliberate pinch.

Fixed with `touch-action: manipulation` on `html, body` (`styles/shell.css`) rather than the viewport
meta's `user-scalable=no`: `manipulation` specifically disables the double-tap-zoom heuristic while
leaving real pinch-zoom available, unlike `user-scalable=no`, which would also take away zoom as an
accessibility tool for low-vision users (a real WCAG 1.4.4/1.4.10 concern, not a hypothetical one) —
the evidence points at double-tap misfiring specifically, not a deliberate pinch, so this is the
narrower fix for the actual mechanism. Confirmed no conflict with `editor/gestures/` (`swipeAttach.ts`
sets `.vr-row` to `touch-action: pan-y`, `longPressDragAttach.ts` sets `.vr-bullet-wrap` to `none`):
both declare their own explicit value, which wins over the new `html, body` rule for touches starting
on those elements — only surfaces with no rule of their own (most of the app's static chrome) are
newly affected, which is exactly the gap that let the bug happen.

---

### B-571 · The sync indicator has no "local only" state — it either says nothing is wrong or looks broken
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-14, owner feedback after using the
Capacitor iOS build in "Just this device" mode (B-563): "the sync icon showing even though it's in
local-only mode (maybe could show some local only version). + I want the icon on the desktop and web
app too, not just 'synced'" and "when clicking the sync icon, it shows a lot of red text as 'not
connected' etc. but that's expected, maybe we should show 'runs in local mode' or something?" ·
**Test:** `sync-indicator-state.test.ts` (3 new cases: `local` derivation, priority under
`memory`/`follower`, its `syncLabel` copy). No component test for `DiagnosticsPanel.tsx` — none
existed before this fix either; verified by reading the render logic and a Simulator rebuild that
the app still boots, not by exercising the panel itself (no tap automation available).

`shell/sync-indicator-state.ts#SyncView` has exactly these states: `starting`, `synced`, `pending`,
`offline`, `error`, `memory`, `follower` — no state means "this device was never configured to sync
at all," which is a real, deliberate, permanent condition (B-563's whole point) rather than a
transient one like `offline`. `deriveSyncView` falls through to `offline`/`error` for it today, so
the indicator (`shell/SyncIndicator.tsx`, mounted unconditionally in `shell/AppShell.tsx` — already
shown on every platform, not mobile-only, so "I want the icon on desktop and web too" is really "I
want the fix to apply everywhere," which it will since this file is platform-agnostic) shows
whatever `offline`/`error` shows, and `views/DiagnosticsPanel.tsx`'s "Sync" row (`s().state` printed
raw in red via `<Status ok={state !== "offline" && state !== "error"}>`) and its "Backend" row
("Could not reach the API: …", `diag-bad`, `role="alert"`) both read as active failures — alarming
and wrong for a mode where not reaching a server is the deliberately chosen, correct state, not an
error. Fixed: a `local` `SyncView` (`shell/sync-indicator-state.ts`, recognized via `data/
bootstrap.ts#hasSyncTarget()` — B-567 landed that exact signal concurrently this session, reused
rather than re-derived), a calm hollow-ring icon for it (`sync-indicator.css`, plain `--muted`, not
`--danger`/`--ok`/`--dot-pending`) and label ("Local only — not syncing to any server"), and
`DiagnosticsPanel.tsx`'s Sync row and Backend section both read calmly ("local only — not configured
to sync" / "This device isn't configured to sync, so there's no server to check") instead of
reporting `offline`/`error` — and the Backend section's `system.diagnostics` fetch is now
source-gated to never even fire in this mode, rather than firing a doomed request and softening its
error after the fact. A real error on a device that *does* have a server configured still shows the
real alarm styling, unchanged. Applies on every platform (the indicator was already mounted
everywhere, not mobile-only), so "I want the icon on desktop and web too" is satisfied by the same
fix. Not fixed here, noticed while touching the file: the "Credentials" row has the identical
"reads as an error, is actually expected" problem in this same mode — separate, narrower, not in
this bug's original scope, worth its own entry if it bothers anyone.

---

### B-569 · "Just this device" still stuck on "Loading…" after B-566's timeout fix — a different, permanent failure, not a hang
**Status:** fixed · **Severity:** high · **Found:** 2026-09-14, owner re-test on the Capacitor iOS
Simulator build after B-566 landed: "i clicked it" / "and still see loading" · **Test:**
`db/worker-core.test.ts`, describe block "WorkerDb.start (B-569)" (2 cases).

B-566 assumed (and its Chromium-based e2e repro showed) a *hung* `/sync/*` request. On the real
Simulator it was still broken after that fix shipped, which meant the real cause was something
else. Diagnosed by instrumenting the app itself (temporary on-screen debug log, since neither Xcode
nor the system log surfaces this WKWebView's JS console) and screenshotting a fresh launch: the
real failure is a **synchronous throw**, not a hang — `sync-client.ts#bootstrap()`'s
`transport.snapshot()` and `http-transport.ts#connectLive`'s `wsUrl()` both throw `SyntaxError: The
string did not match the expected pattern.` near-instantly, because resolving a relative `URL()`
against this dedicated Worker's own `self.location` does not behave the way it does on web/PWA when
the worker is loaded from Capacitor's `capacitor://` scheme. `WorkerDb.start()`
(`db/worker-core.ts`) only wrapped `bootstrap()` in `try/catch` — the uncaught throw from
`connectLive()` right after it made `start()` itself reject, which permanently poisons
`db.worker.ts`'s cached `dbPromise`: every later worker RPC (`getPageTree`, `getJournalStream`, the
sidebar's `useAllPages`/`useFavoritePages` queries) rejects too, forever, for the life of that
worker — and with no `ErrorBoundary` anywhere in the app (B-400), the UI just freezes on whatever it
rendered first, the "Loading…" placeholder. B-566's timeout fix was still correct and worth
keeping (a genuine hang is a real, separate risk), it just wasn't *this* bug.

Fix: wrap `connectLive()` (and `pull()`'s kickoff) in `WorkerDb.start()` with the same tolerance
`bootstrap()` already had, and guard `connect()`'s own `new WebSocket(wsUrl())` call in
`http-transport.ts` too, since reconnect attempts call it again from inside a `setTimeout` where an
uncaught throw would otherwise become an unhandled worker error. Not yet re-verified on the real
Simulator after this specific fix (owner interaction needed) — verified so far by a unit test that
reproduces the exact exception (`DOMException("The string did not match the expected pattern.",
"SyntaxError")`) thrown from a fake transport's `connectLive()`/`snapshot()`, proving `start()` now
resolves regardless.

---

### B-568 · Typing `[[a new page]]` in a bullet does not create the page — confirmed still broken, real cause found
**Status:** fixed for `[[page]]`/`#tag`/`#[[multi word]]` refs and the `Task` tag from a freshly
created marked block, plus namespace ancestors — the owner explicitly chose client-side creation
over the calmer-failure alternative ("of course I want client side creation to[o]") · **Severity:**
high · **Found:** 2026-09-14, owner report, then independently reproduced by the owner on the
current build (screenshot: typed `[[something]]`, clicked it, landed on "This page doesn't exist
yet. `Create \"something\"`") · **Test:** `data/local-ref-pages.test.ts` (10 cases, pure — no
worker/DB/HLC needed, `pageExists`/`mint` injected), `e2e/tests/local-page-creation.spec.ts` (the
real bar: no server configured at all, type `[[Local Only New Page]]`, click the rendered link,
land on a real page, not "doesn't exist yet") — both new, both pass (2026-10-03: the real-server sibling, `desktop-page-creation-probe.spec.ts`'s first test, was failing only on its journal-draft setup — fixed, passes; see B-581); full `pnpm --filter
@nooklet/web test` (1358) and `typecheck` clean.

Fix: `data/local-ref-pages.ts`, a scoped client-side mirror of `packages/server/src/ref-pages.ts`'s
`planReferencedPages` — that mechanism is genuinely server-only (its own doc comment: "Only the
server decides... Clients never create a page implicitly"), so this is a parallel client-side
equivalent, not a workaround. Reuses `@nooklet/core`'s already-portable `extractRefs`,
`namespaceAncestors`, `normalizePageName`, `canonicalRefName`, `parseJournalTitle` — no new core
exports needed, no duplicated extraction logic. Wired into `data/store.ts#applyOps`, the one
function every client write already goes through: before handing a batch to the worker, it scans
any `block.text`/`block.create` payloads for references, checks each (plus namespace ancestors, in
`A` → `A/B` order) against the local `page` table, and prepends a `page.create` for anything
missing — into the SAME batch, so it lands in one worker transaction alongside the edit that named
it. Uses this device's own real id, never `REFERENCE_DEVICE_ID` (`ref-pages.ts`'s reserved
sentinel — spoofing it would violate the invariant that no real device can produce it). Convergence
once this device syncs: the client's own `page.create` op travels the normal `pending_op` outbox
alongside the edit, so by the time the server's `planReferencedPages` looks at the reference it
already resolves, and does not mint a competing one — verified by reading `ref-pages.ts`/
`apply-ops.ts`, not just assumed.

**Deliberately deferred, not silently missing**: refs inside property values (`tags::` etc.) and
the `Task` tag from a `block.prop` marker change on an already-existing block (only a freshly
created marked block is covered) — both server-only for now, same shape of gap, lower priority than
the reported case. See B-579 for the other deliberate gap (junk-cleanup).

The "likely resolved by B-566/B-569" theory this entry carried earlier was wrong; the owner's
re-test on the current build (after B-566/B-567/B-569 all landed) reproduces it cleanly. Real cause,
confirmed by reading `packages/server/src/ref-pages.ts`'s own doc comment: **"Only the server
decides... Clients never create a page implicitly."** Page auto-creation (ADR 024) is a
`serverApplyOps`-only mechanism — it runs after a batch reaches the server, and every device learns
of the new page only by syncing the correction back. A device in "Just this device" mode (B-563) has
no server at all, so no batch it writes can ever reach `planReferencedPages` — this was never going
to work for a local-only device, by the architecture's own design, not a bug that regressed. The
same root cause explains the screenshot's second symptom, "Couldn't load references": backlinks are
also a server-only read (`data/api-client.ts`'s own doc comment: "the read ops the local replica
cannot answer on its own") — see B-577, which is the same underlying gap surfacing on three
different screens.

**This is a scope decision, not a bug fix**, and is the owner's call: (a) implement page creation
client-side too (a real feature — locally apply an optimistic `page.create` the moment a reference
resolves to nothing, reconciled against the server's own version once/if this device ever syncs —
touches `packages/core`/`applyOps`, meaningfully bigger, and raises the same identity-collision
questions `docs/proposals/003-independently-started-graphs.md` already flagged for two independently
-started histories), or (b) accept it as a documented limitation of local-only mode and make the
failure calm and honest instead of surprising — which the existing "This page doesn't exist yet —
Create" screen mostly already is; what's missing is explaining *why* typing the reference alone
wasn't enough, so the click-through isn't a surprise. (b) is a small, consistent extension of B-577's
fix; (a) is real, separate feature work.

---

### B-567 · A device with no configured server (B-563's "Just this device") pays a 10s timeout on every cold start, not just the first
**Status:** fixed · **Severity:** low · **Found:** 2026-09-14, reading `db/worker-core.ts#start()`/
`sync/sync-client.ts#isBootstrapped()` while verifying B-566's fix · **Test:**
`db/worker-core.test.ts`, describe block "WorkerDb.start (B-567)" (2 cases: skips
bootstrap/connectLive/pull with no target, still attempts them with one).

B-566's timeout stopped the hang from being infinite, but for exactly the audience B-563's "Just
this device" choice exists for — a client that will never have a server configured — it did not
stop the wait from recurring: `WorkerDb.start()` calls `SyncClient.bootstrap()` whenever
`!isBootstrapped()`, and a device with nothing to reach fails every time, so the flag never gets set,
so every cold start repeated the same 10s wait.

Fix: `db/worker-api.ts#WorkerInitOptions.syncBaseUrl`'s own doc comment already said "omit to run
local-only" — nothing honored that contract. `data/bootstrap.ts` gained `hasSyncTarget()` (same
origin is always real on web/PWA/desktop; under Capacitor, only a real `storedServerUrl()` counts).
`main.tsx` now omits `syncBaseUrl` entirely when `hasSyncTarget()` is false, instead of passing
`apiBaseUrl()`'s `""`. `db.worker.ts#openDb` derives `hasSyncTarget: opts.syncBaseUrl !== undefined`
and passes it to a new `WorkerDbOptions.hasSyncTarget` (default `true`, so every existing caller/test
is unaffected); `WorkerDb.start()` returns immediately when it's `false`, skipping
bootstrap/connectLive/pull entirely rather than attempting and timing out against a target known not
to exist. A device with a real but currently-unreachable server still retries exactly as before —
this only short-circuits the provably-nothing-to-reach case.

---

### B-566 · A hung `/sync/*` or `/api/v1/*` request left the outliner, sidebar and every worker-backed view on "Loading…" forever
**Status:** fixed · **Severity:** high · **Found:** 2026-09-14, owner report after choosing "Just
this device" on the Capacitor iOS build: "the bullet point shows loading, and diagnostic page also
shows errors, and sidebar doesn't load, overall bad." · **Test:** `e2e/tests/sync-timeout.spec.ts`
("a hung sync backend times out instead of stalling the outliner forever") — reproduces the stuck
`.vr-draft-pending` state by forcing `/sync/*` to hang in an ordinary Chromium session (no Capacitor
needed to prove the fix), then asserts it clears within the new timeout.

One root cause behind all three symptoms, not three bugs: `db.worker.ts#openDb` awaits
`WorkerDb.start()` before `dbPromise` resolves, and `db/worker-api.ts`'s `requireDb()` — which
EVERY worker RPC (`getPageTree`, `getJournalStream`, the plain `query()` the sidebar's
`useAllPages`/`useFavoritePages` go through) awaits — never resolves until it does. `start()`
already wraps `SyncClient.bootstrap()` in a `try/catch` so a *failed* bootstrap falls back to an
empty local replica (by design), but nothing bounded a bootstrap/pull/push that never resolves at
all — only fails fast. A real server always answers, even with a 401, which is why this never
showed up against `pnpm nooklet serve`. A Capacitor build with no server configured is the one
environment where it reliably does: a relative fetch resolves against `capacitor://localhost`,
which has no route for `/sync/*` and, unlike a real server, doesn't have to answer at all. Every
worker-backed view was stuck on "Loading…"/its pending placeholder as a result — the journal's
`vr-draft-pending` bullet, the sidebar's page list, everything. Diagnostics *showing an error*
("Could not reach the API") in this same scenario is separately verified as correct, not a bug —
`views/DiagnosticsPanel.tsx:115-117` already renders that state clearly; it just isn't the same
failure as the other two.

Fix: bound every one of this client's own `fetch` calls with `AbortSignal.timeout(10_000)` — the
three places that had none: `sync/http-transport.ts` (`push`/`pull`/`snapshot`, `SYNC_TIMEOUT_MS`),
`data/api-client.ts#callOp` (`API_TIMEOUT_MS`; the same class of bug in the sibling path
`search`/`page.backlinks`/`system.diagnostics` all use), and `data/bootstrap.ts#initBootstrap`
(`SESSION_TIMEOUT_MS`) — the most severe of the three, since `main.tsx` awaits it before anything
renders at all, so a hang there is a blank screen forever, not just a stuck bullet.

---

### B-565 · Settings panel's close button scrolls off-screen and becomes unreachable on a phone
**Status:** fixed · **Severity:** high · **Found:** 2026-09-14, owner report on the Capacitor iOS
build: "setting window somehow takes over everything in that small viewport and cant be even
exited." · **Test:** `e2e/tests/phone.spec.ts`, "the settings panel's close button stays reachable
after scrolling on a phone screen" — reproduced first (`toBeInViewport` failed, "viewport ratio 0"),
confirmed fixed after (passes, plus the rest of `settings.spec.ts`/`phone.spec.ts`, 14/14).

`.set-backdrop` (`settings.css`), not `.set-panel`, is the scroll container (`overflow-y: auto`);
`.set-header` (holding the only close control, `aria-label="Close"`) is a plain flow element inside
`.set-panel`, not `position: sticky`. The panel's real content (Appearance, Search & embeddings,
Templates, Plugins, About) is taller than a phone viewport (confirmed: exceeds an iPhone 13's 844px),
so scrolling into it — which a phone user must do to reach most of the panel at all — carries the
header, and the only way out, off the top of the screen with it. The backdrop's own click-to-close
does not rescue this: on a narrow viewport `.set-panel`'s `width: min(38rem, 100%)` leaves only a
sliver of backdrop at the sides, easy to miss and easy to read as "there is no way out" exactly as
reported. No keyboard Escape path either (the file's own comment says so: "the close button is the
keyboard path out" — fine on desktop, a dead end on a device with no keyboard). Fix: make
`.set-header` sticky within `.set-panel` with an opaque background so it never leaves the viewport
while its own content scrolls underneath it.

---

### B-564 · Keyboard-shortcuts list shown in the `?` help menu on touch/mobile, where there is no keyboard
**Status:** fixed · **Severity:** low · **Found:** 2026-09-14, owner feedback while looking at the
Capacitor iOS build: "probably shouldn't have keyboard shortcuts on the mobile app too in the help
menu." · **Test:** `HelpMenu.test.tsx` (new file, 2 cases).

`shell/HelpMenu.tsx`'s `?` menu always lists "Keyboard shortcuts" regardless of platform. On a
touch-primary device with no hardware keyboard the whole dialog is dead weight — every row lists a
key combination nothing can press. `commands/keymap/platform.ts#detectPlatformFromEnvironment()`
already exposes `mobile` (touch-primary, ios/android) for exactly this kind of decision elsewhere in
the app. Fix: hide the "Keyboard shortcuts" menu item (and by extension the dialog, since nothing
else opens it on the client side — the desktop native menu's own `Keyboard Shortcuts` item is
unaffected, it is never mobile) when `mobile` is true.

---

Also applies to the "⋯" menu (2026-10-03): its Keyboard shortcuts item runs `app.showShortcuts`, whose `when` is `!mobile` (`MoreMenu.test.tsx`, `more-menu-phone.spec.ts`).

### B-563 · `ConnectView` reads as "syncing is mandatory"
**Status:** fixed · **Severity:** low · **Found:** 2026-09-14, owner feedback after seeing the real
screen on the iOS Simulator: "it also says that the device needs server's address and token, but it
should be optional, i.e. maybe some screen where the user can choose from 'I don't have a Nooklet
server to sync this device with' and 'I do have a server' and only the second option would go
there." · **Test:** `ConnectView.test.tsx`, describe block "B-563: choice screen precedes the form
whenever a skip path exists" (4 cases) — also confirmed visually on the iOS Simulator.

Skipping sync already worked (`onSkip` → "Continue without syncing"), but it was a second button
sitting next to the required-looking address/token fields, which read as "fill this out" rather
than "here are two equally valid choices." Fix: when a skip path exists, show an upfront choice
screen (just this device / sync with a server, one icon each — `Smartphone`/`Server` from the
already-installed `lucide-solid`) before the form; only picking "sync with a server" reveals the
address/token fields. No behavior change when there is no skip path (nothing to choose between).

---

### B-562 · `ConnectView`'s heading is obscured by the status bar / Dynamic Island in the Capacitor iOS shell
**Status:** fixed · **Severity:** low · **Found:** 2026-09-14, first-ever launch of the generated
`apps/web/ios/` project in iOS Simulator (iPhone 17, iOS 26.5) · **Test:** none — verified only by
re-screenshotting the same Simulator run before/after; not covered by any automated suite (Playwright
drives Chromium, not a built Capacitor shell), so "fixed" here means "believed fixed" per this file's
own convention.

`ConnectView.tsx` renders outside `AppShell` (it's `App.tsx`'s `<Show>` fallback, shown before the
`Router`/`AppShell` tree mounts), so it never gets whatever safe-area handling normal routes get.
`connect.css`'s `.connect` rule pads with `clamp(2rem, 6vw, 4.5rem)` and no `env(safe-area-inset-*)`
component — on a device with a Dynamic Island/notch, the `<h1>Connect this device</h1>` heading
renders partly underneath it. Screenshot evidence: first Simulator launch, "Connect this device"
reads as "Connect t[obscured]e" with the status bar's time and the Dynamic Island pill overlapping
the text. `styles/shell.css` already defines `--sat`/`--sab`/`--sal`/`--sar` (`env(safe-area-inset-*,
0px)`) on `:root`, so they're available here despite `AppShell` not being mounted — `connect.css`
just isn't using them. Fix: add `var(--sat)` to `.connect`'s top padding.

---

### B-541 · In the desktop app the top bar's controls sit under the macOS window buttons, so Settings, Graph and the sidebar are unreachable
**Status:** fixed · **Severity:** high ·
**Found:** 2026-09-13, owner report ("I don't see any settings dialog anywhere, nor the question mark
icon in the desktop app. not even graph?") · **Test:** none yet

`main.rs` opens the window with `TitleBarStyle::Transparent` and a hidden title, so the page starts
under the title bar; at the default 1100×800 the client's top-left controls (Toggle sidebar, Back,
Forward) are exactly where the traffic lights are, the sidebar starts collapsed, and Settings and
Graph live only in the sidebar or the palette. Also checked: the app's WebKit store holds a service
worker and precache from Sep 11, so a stale client is a second possible cause.


**Owner, 2026-09-13:** "we also should have some icon for settings? or maybe three dots at top right with
dropdown for these?" Decision: a "⋯" menu at the top right, as Logseq has — Settings, All pages, Graph,
Trash, Keyboard shortcuts / Help, Diagnostics — next to the quiet sync icon and the agent-access icon
(B-540). Settings also on Cmd+, (native menu). Built as a follow-up once `m11/desktop-shell` and
`m11/quiet-topbar` land, so the three top-bar changes do not collide.


**Resolved 2026-09-13 — the hypothesis was wrong.** Checked in a real test window (m11/desktop-shell, B-531): `TitleBarStyle::Transparent` starts the page below the title strip; the traffic lights never cover the toolbar, and real clicks reached Toggle sidebar, Graph, Pages, "?" and Settings. The owner's missing controls were an OLD client kept by the service worker (B-532, fixed: `skipWaiting` + `clientsClaim`). The top-right "⋯" menu the owner asked for is still a to-do.

---

**Follow-up done 2026-10-03** (`8578821`): the top-right "⋯" menu — `shell/MoreMenu.tsx`, last in
the top bar after the sync cloud and the agent badge — with Settings (Cmd+,), All pages, Graph,
Trash, Keyboard shortcuts, Diagnostics. Each item runs a command (new: `nav.allPages`, `nav.graph`,
`nav.trash`, `app.showShortcuts`, `app.openDiagnostics`; Settings is `app.openSettings`), so the
palette reaches the same places. Graph is not registered on Capacitor (B-578); Keyboard shortcuts
has `when: "!mobile"` (B-564). Settings moved out of the `?` menu (one pointer route); the `?` FAB
stays for docs, bug/feature links and the version. **Test:** `e2e/tests/more-menu.spec.ts` (opens
each item), `e2e/tests/more-menu-phone.spec.ts`, `e2e/tests/desktop-shell.spec.ts`,
`apps/web/src/shell/MoreMenu.test.tsx`. Not run in the real Tauri window or iOS build.

### B-531 · Hypothesis refuted: the traffic lights do NOT cover Toggle sidebar / Back / Forward
**Status:** not a bug · **Severity:** — · **Found:** 2026-09-13, desktop-shell ·
**Evidence:** `shots/01-base-default-size.png` (client `52e5d20`), `shots/10-final-default-size.png`
(this branch's app, menu and client) · **Test (guard):** `e2e/tests/desktop-shell.spec.ts` › "at the
desktop window's size, Settings, Graph, All pages and Help are reachable by pointer"

The suspicion was that `TitleBarStyle::Transparent` + `hidden_title` puts web content under the
title bar, so the macOS window buttons would sit on the top bar's first three controls and leave
no visible way into the sidebar (and so to Graph and Pages). At the default 1100×800 window, with
the client from `52e5d20`, the screenshot shows otherwise: `Transparent` only makes the title bar
transparent (Tauri's `Overlay` is the style that lays content under it). The title bar is its own
~32 pt strip; the 44 pt top bar starts below it with Toggle sidebar, Back and Forward fully
visible; the sidebar is collapsed; the `?` help button is visible bottom-right. So at the default
size the current client offers Toggle sidebar → Graph / Pages, and `?` → Settings / Keyboard
shortcuts, without a shortcut. The owner's app builds from the same `main.rs`, so it has the same
geometry. What the owner saw is B-532.

~~Unverified: that those controls respond to a real click in WKWebView.~~ **Verified in the app**
(verification pass): the window's style mask has no full-size content view; `contentLayoutRect` and
the web view both start at y = 32 pt; the traffic lights sit at y 9–23 pt. Native hit-tests at the
centres of Toggle sidebar, Back, Forward and `?` land on the `WryWebView`; at (16, 16) on
`_NSThemeCloseWidget`; in the empty strip on `NSThemeFrame`. Clicking Toggle sidebar → Graph → Pages →
`?` → Settings at the default 1100×800 did each thing (`shots/verify/v01…v06`).

Window dragging: the 32 pt strip is AppKit's own title bar (`NSThemeFrame`, `isMovable` true), which is
what moves a window with this style; the web top bar has no drag region and needs none while
nothing overlaps it. A synthesized drag moves nothing either way — the window server drags title
bars from the real pointer — so a drag itself is still unverified.

---

### B-534 · Links that open a new window do nothing in the desktop app — every external link in a note, and Help's Documentation / Report a bug
**Owner decision 2026-10-03:** "don't need zotero" — keep the allowlist (`http`, `https`, `mailto`); app schemes stay dead in the desktop app. Closed.
**Status:** believed fixed (no test can click in the app here) · **Severity:** high · **Found:**
2026-09-13, desktop-shell (reading Tauri's source for the Help menu) · **Test:** none — see below

Note links render as `<a target="_blank">` (`editor/render/tokens.tsx`), Alt+Enter on a link calls
`window.open(url, "_blank")` (`app/hosts.ts`), and the help menu's Documentation / Report a bug /
Request a feature are `target="_blank"` anchors. In WKWebView a new-window navigation goes to the
UI delegate, and wry 0.55.1 (`src/wkwebview/class/wry_web_view_ui_delegate.rs`,
`create_web_view_for_navigation_action`) returns `None` — nothing happens — unless the app set a
new-window handler (`WebviewWindowBuilder::on_new_window`). `main.rs` sets none.

Verified by reading the source of the exact versions in `Cargo.lock` (tauri 2.11.5, wry 0.55.1),
NOT by clicking a link in the app: this environment cannot send clicks to it (see the top).

**Fix.** `WebviewWindowBuilder::on_new_window` in `main.rs`: hand the URL to the system browser
(`open` on macOS, `xdg-open` / `explorer` elsewhere) and deny the in-app window. Only `http`, `https`
and `mailto` leave the app — `open file:///…/Some.app` launches a program, and a link in a note is
not a reason to run one; anything else is logged and dropped. The Help menu's Documentation /
Report a Bug items use the same function.

**Owner decision needed:** app links (`zotero://select/…`, `obsidian://`, `things:`) stay dead in
the desktop app. `editor/render/safe-href.ts` deliberately lets them render (B-268: people link to
apps, and a browser hands them to the OS after its own prompt), but `open` has no prompt — letting
any scheme through would open `file://` (a `.command` file runs in Terminal), `smb://`, `ssh://` the
same way, from text an agent or another device can write. Options: keep the allowlist (current); add
named app schemes to it; or ask with a native confirmation before any other scheme.

~~Believed fixed, not tested.~~ **Verified in the app** (verification pass; the harness build logs
the URL instead of running `open`): a click on an `https://` link in a journal block, the `?` menu's
Documentation anchor, and Help → nooklet Documentation / Report a Bug… each logged `OPEN <url>` and
the window stayed on the client; a `zotero://` link logged `REFUSED`; a `file://` link never reached
the handler at all (WebKit refuses a file URL from an http page first). Still untested: Alt+Enter's
`window.open`, and the real `open` spawn (deliberately — it would open the owner's browser).

---

### B-503 · The focus log recorded some typed characters as themselves
**Status:** fixed · **Severity:** low (a debug log the owner pastes into bug reports; its promise is
"no text you type is recorded") · **Found:** 2026-09-13, verifying m11/webkit-focus, by reading
`app/focus-log.ts#keyCategory` · **Test:** `apps/web/src/app/focus-log.test.ts` "reports a
character key as `char` and named keys by name, with modifiers"

`keyCategory` treated any `KeyboardEvent.key` longer than one UTF-16 unit as a named key and logged
it verbatim. A character outside the BMP (an emoji) is two units, a decomposed accent (`e` + U+0301)
is two, so either went into the log as typed. Now only the shape named key values have (UI Events:
an ASCII word starting with a capital — `Enter`, `ArrowUp`, `F5`, `Dead`) is logged by name;
everything else is `char`. The unit test fails before (`😀` logged) and passes after.

---

### B-502 · In WebKit, a refresh that moves the block being edited puts the caret at the start, with the `[[` popup left open
**Status:** fixed (in Playwright's WebKit; not checked in the desktop app) · **Severity:** medium (the Mac app's engine; the next keystroke lands in the wrong
place) · **Found:** 2026-09-13, verifying m11/webkit-focus (probe
`tools/probes/refresh-focus-structural.spec.ts`) · **Tests:**
`e2e/tests/edited-row-move-caret.spec.ts` "another device moving the block you are typing a link
into keeps the caret and the popup (B-502)"; `e2e/tests/focus-log.spec.ts` "recording changes
nothing about editing: a refresh mid-link, another device's move, undo" (both chromium + webkit)

Type `base testing [[dru` in a block so the `[[` popup is open. Another device (here an API
`block.move`) moves that block above its sibling. After the pull: in Playwright's WebKit the editor
still has focus but the caret is at offset 0, the popup is still showing, and the next key types at
the START of the block (`gbase … testing [[dru`) and closes the popup. Chromium keeps the caret at
the end and `g` completes `[[drug`. The verification's other structural refreshes (a block inserted
above, siblings reordered around the edited one, the edited block indented, a child added above, a
real second client editing the block below, typing straight through remote inserts) keep focus and
caret in both engines.

Mechanism, traced (probe `tools/probes/edited-row-move-mechanism.spec.ts`, which logs activeElement
and the DOM selection around the native `insertBefore`, `selectionchange`, focus events and
`focus()` calls): the keyed `<For>` moves the edited row's node; in BOTH engines `activeElement`
becomes `<body>` and `BlockTree.tsx#refocusAfterReorder` calls `surface.focus()` in a microtask.
Chromium fires `focusout` on the move, CM6's blur handler clears its cached DOM selection, and
`view.focus()` writes the state's caret back (head 46 → 46). WebKit fires NO `focusout`: CM6 keeps
the stale cache, its `updateSelection` compares the state with that cache, finds them equal and
writes nothing, while WebKit's own focus has put the DOM caret at the start of the content; the
`selectionchange` that follows is read into the state (head 44 → 0).

Same cause as B-501 (Alt+Up/Down), which is the same DOM move made locally. Whether it is what the
owner sees as B-42 is not established: the owner's report (pause mid-link, a refresh, focus gone)
does not involve anything moving the block, and this leaves the editor focused rather than
unfocused.

**Fixed 2026-09-13** in `editor/surface.ts#focus` (the only caller is `refocusAfterReorder`): after
`view.focus()`, if the document selection disagrees with the editor state, write the state's
selection into it in the same task, before any `selectionchange` — the repair
`commands/focus-return.ts` already makes for B-296. No timer, no BlockTree change. The test above
fails in WebKit before (2/2, caret 0) and passes after (2/2), Chromium passes both. Full measurement
on port 6416, `edited-row-move-caret` + `focus-log` + `webkit-refresh-focus`, both projects: pre-fix
`surface.ts` 15 passed / 3 failed (all WebKit, all caret 0); fixed 18/18. Guards added with it, which
pass before and after: undo of Alt+Up; a mid-line caret on a line whose `[[ ]]`/`**` markers the
live preview hides (the fix writes through `domAtPos`, where DOM and document offsets differ).

---

### B-501 · In WebKit, Alt+Up/Down moves the block but the caret jumps to the start of it
**Diagnosed and fixed 2026-09-13 (verification):** the same DOM-move mechanism as B-502 below,
same fix. Test `e2e/tests/edited-row-move-caret.spec.ts` "Alt+Up moves the block being edited
without moving the caret (B-501)" failed in WebKit (caret 0) before, passes after; Chromium both.
`focus.spec.ts` "Alt+Up/Down moves the block and keeps the editor in it (R22)" also passes in WebKit
now (it failed there before).

**Status:** fixed (in Playwright's WebKit; not checked in the desktop app) · **Severity:** low · **Found:** 2026-09-13,
m11/webkit-focus, running `focus.spec.ts` in Playwright's WebKit · **Test:** `e2e/tests/focus.spec.ts`
"Alt+Up/Down moves the block and keeps the editor in it (R22)" fails in WebKit (it runs only in
Chromium in the suite)

Editing `two` on `one, two` with the caret at the end, Alt+ArrowUp: the block moves up and the
editor keeps focus, but the caret is at offset 0 instead of 3 (`{anchor: 0, head: 0}`). Chromium
keeps it at 3. Same result on `52e5d20` (this branch's base) with none of this branch's changes, so
not caused by the focus log. Not yet checked in the real desktop app (WKWebView), where it would
matter; not diagnosed. A guess worth testing first, not a finding: the keyed `<For>` moves the row's
DOM node, WebKit resets the document selection when the focused node moves, and CodeMirror reads
that selection back on refocus instead of writing its own.

For the record, the same WebKit run (`popups`, `focus`, `focus-return`, `editing`,
`editing-row-leaves`, `autocomplete`, `autocomplete-busy-replica`, `follow-link-popup`,
`journal-stream-editing`, `diagnostics`, `storage`, `webkit-refresh-focus`, `focus-log`: 101
passed, 6 failed) had five more failures, all of one kind and all also failing on `52e5d20`: a
reload or `page.goto` shortly after typing (`editing.spec.ts` "text survives blurring…", "Enter
creates a second bullet…", "typing immediately after Enter…"; `focus.spec.ts` "text typed just
before an in-app navigation…"; `popups.spec.ts` "Table on an empty block…"), each at its first
assertion after the reload or `goto` (lines 69, 98, 134, 382, 594). Playwright's WebKit has no OPFS
in workers and runs the in-memory replica (B-43), whose queue of unpushed ops dies with
the page — expected there, and why the webkit project does not run the suite. Not a bug by itself.

---

### B-407 · B-403's race is also in the two sibling "failed … load" tests, and under load it fails them nearly every time
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, verification of m10/tests-desktop
(B-403's claim "the whole spec: 7 passed" under load) · **Test:**
`e2e/tests/review-reactivity.spec.ts` "a failed trash load says so and Retry recovers…" and "a
failed history load says so and Retry recovers…" (B-131)

Under 56 busy loops (load average ≈ 70), `-g B-131 --repeat-each=12` (stopped after 32 tests):
"a failed Older changes…" (B-403's fixed test) 10 of 10 passed, "a failed history load…" 6 of 11,
"a failed trash load…" 0 of 11 — each failure the 30 s test timeout on `locator.click` of the Retry
button, `element was detached from the DOM, retrying`, with the page showing the loaded view. Both
passed 3 of 3 without the busy loops. Neither test is changed on this branch.

Cause, from the trash failure's trace (network and actions on one clock): the routed `trash.list`
aborted at 44427 ms and the error rendered; the fresh context's `/sync/snapshot` answered only at
44762; its bootstrap ChangeEvent refetched `trash.list` twice (B-404) at 44794, as the test
unrouted (44796) — the pending requests fell through to the network, answered 200, the error
unmounted, and the click waited on a Retry button that no longer existed. It is B-403's race: a view
that fetches over HTTP renders its error before a fresh context's replica has bootstrapped, and the
bootstrap's refetch lands inside the test's error-then-retry sequence. Load only makes the snapshot
late enough to hit it every time. The product does the right thing (it recovered on its own).

**Fixed 2026-09-13.** Both tests now call the spec's new `bootstrapReplica(page, name)` first —
seed a page, open it, wait for a row from the replica — the same step B-403's fix inlined, and only
then route the failure and load Trash / History (a warm start). Proof, under 56 busy loops: the fixed
pair `--repeat-each=8`, 16 of 16 (load average 39-63 as the loops started); and in one control run
with the branch-head copy of the spec beside the fixed one, `--repeat-each=4` (load average
59-69): the old tests failed 1 of 4 each (trash, history), the fixed ones passed 8 of 8.

---

### B-406 · A plugin op whose REST alias lacks `method` or `path` still stops the whole server from starting
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, verification of m10/tests-desktop
(B-402's fix) · **Test:** `packages/server/src/plugins/host.test.ts` "a REST alias missing its method
or path is that plugin's error, and the server still starts (B-406)"

B-402's check (`plugins/ops-bridge.ts#assertCompleteOpDef`) refuses an op missing a top-level
required field, but mounting a REST alias reads two more that it does not check. With every
top-level field present, `expose: { http: { method: "GET" } }` throws `TypeError: Cannot read
properties of undefined (reading 'replace')` (`registry.ts#toHonoPath`) and `expose: { http: { path:
"/x" } }` throws `… (reading 'toUpperCase')` (Hono's `app.on`), both from `mountHttp` outside any
per-plugin guard — the plugin test harness's setup itself threw, as B-402's did before its fix. Same
failure as B-402: `nooklet serve` and the desktop app exit at startup over one malformed plugin.
(Checked alongside and fine: a method Hono does not know, a lower-case method, and `mcp: true`
without `render`, which the registry already makes the plugin's error.)

**Fixed 2026-09-13.** `assertCompleteOpDef` also requires a string `method` and `path` when
`expose.http` is an object, and names `expose.http's method and path` as missing otherwise — the
plugin's error, as for B-402. Test: the one above, two such plugins beside a working one; with the
new check disabled it fails at setup with `TypeError: Cannot read properties of undefined (reading
'toUpperCase')`, with it both are `error` and the working plugin's op answers 200. Server
`src/plugins` 62 of 62.

---

### B-405 · B-333's new tokenizer line-length check is itself a load flake on a machine with efficiency cores
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, verification of m10/tests-desktop ·
**Test:** `packages/core/src/tokens.test.ts` "costs the same per character on a line four times as
long"

The check B-333 added compared the best of three ~3 ms CPU runs over an ~83k-character line with the
best of three ~25 ms runs over a ~333k one and required the ratio under 8. Run on its own under 84
busy node loops (load average 100-140), an exact copy of it logging the ratio read **8.32** (1 of
50) and **8.16** (1 of 45) — failed — with a median of 5.8 against 4.4 idle and several runs at
7.0-7.6; at 56 loops the top was 7.61. `process.cpuUsage()` does not cancel load out on this M4 Pro
(10 performance + 4 efficiency cores): a busy scheduler runs the thread on an efficiency core for
whole quanta, which bills about twice the CPU time for the same work. The short side's minimum, a
window under one quantum, nearly always caught an undisturbed stretch; the long side's, spanning
several, often did not — so the ratio was biased upward exactly under load, the thing B-333 was
about.

**Fixed 2026-09-13.** Both sides now tokenize the same number of characters (the short line four
times, the long one once — ~2 ms of CPU each, under a quantum), alternate, and keep the least of
fifteen; the limit is 2 (linear 1, quadratic 4), which is the old 8 over 4. Measured in the same
vitest runs as the old form, at the same load (84 loops, load average 100-140, 45 runs): old form
median 5.81, top 8.16 (failed); new form median 1.083, range 0.92-1.18. Idle: 1.08-1.10. Detection
unchanged: with length-quadratic work planted in `tokenizeContent` (a rescan to the end from every
Nth character), both forms fail for N = 512, 1024, 2048 (new 3.45, 3.01, 2.67), and N = 4096 sits at
the limit in both (new 2.08-2.15 and once under 2; old 8.7-10.1 here, 6.2 in B-333's run). Proof:
the committed test 30 of 30 under 84 loops (load average ≈ 105), and `packages/core` 399 of 399
twice, niced, at the same load.

---

### B-403 · `review-reactivity.spec.ts` "a failed Older changes says so…" loses its older page to the replica's first sync
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, m10/tests-desktop (final full e2e
run, chunk `replace.spec.ts`…`views.spec.ts`, load average ≈ 4-6) · **Test:**
`e2e/tests/review-reactivity.spec.ts` "a failed Older changes says so instead of silently
re-enabling the button (B-131)"

After unrouting and clicking "Older changes" a second time, `.history-batch` stayed at 25 for the
whole 10 s (`Expected: 26, Received: 25`, 24 polls). The spec alone passed straight after; that
rerun overwrote the failed run's trace, so the cause was then pinned with a probe instead.

Cause: a race between the test and the DB worker's start, in the test. The History view's first page
comes over HTTP (`data/history.ts#fetchPageHistory`) and is on screen before a fresh context's
replica has bootstrapped. When the first `/sync/snapshot` lands, `SyncClient`'s `onBootstrap` fires a
ChangeEvent naming every table, `usePageHistory`'s first page refetches, and a refetch drops the
appended older pages and discards one still in flight — deliberately (B-132: their cursor belonged
to the previous first page). If that lands just after the retry click, nothing clicks again and the
view stays at 25. Probe `tools/probes/history-older-vs-first-sync.spec.ts`:
- A (forced: snapshot held until the retried older page is in flight, released before its answer):
  25, 7 of 7 over three runs.
- C (unforced: ten runs of the 70c9bb9 flow, logging each `page.history` fetch and click in the
  page): under 56 busy loops (load average ≈ 70), 1 of 10 at 25 — `click@475 older>475 first>490
  (x4) older<491 first<493…496`, the refetches clearing the older page just appended — and in the
  other nine the refetches had been answered 3-195 ms before the retry click (two more unlogged
  batches of ten with the same busy loops: 20 of 20 at 26). With no busy loops (load average 30-50 from
  other agents), 3 of 10 at 25, the refetches starting 0-21 ms after the older answer, and five of
  the seven passes had simply finished before the first sync landed at all. Not a load flake, then:
  it hits when the test outruns the worker.

Not a product bug as the view is designed, and not changed: a person who pages back within the
first half second of a browser's first ever start sees the older batches vanish and "Older changes"
come back, and one more click brings them. (Keeping older pages when the refetched first page is
identical would avoid that, but — by `ops/page-history.ts`'s header — a block moved to another
page takes its history with it, which can empty part of the tail without changing the first page, so
a kept tail could list batches the server no longer does, and Restore walks that list. Left for the
owner.)

**Fixed 2026-09-13.** The test opens the page itself first and waits for its 26 rows — which come
from the replica, so it has bootstrapped — and only then loads History; a warm start fires no
bootstrap and an empty pull names no tables, so nothing refetches. It also names its page with
`runName` so it can be repeated. Test that would have caught it: the spec itself (the forced and
unforced probes show the old flow failing). Proof: the new flow in probe B and the "warm" half of
C (plus a batch of ten logged from the test process) — 37 of 37 at 26, each with exactly one first-page fetch (and, in
B, no second snapshot); the test alone,
`--repeat-each=16` under 56 busy loops (load average 60-87): 16 passed; the whole spec under the same
load: 7 passed.

---

### B-402 · A plugin op missing `annotations` stops the whole server from starting
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, m10/tests-desktop (verifying B-336)
· **Test:** `packages/server/src/plugins/host.test.ts` "an op missing required OpDef fields is that
plugin's error, and the server still starts (B-402)"

A plugin whose `ctx.ops.register(defineOp({...}))` leaves out `annotations` does not just fail to
load: `nooklet serve` exits at startup with `nooklet: Cannot read properties of undefined (reading
'readOnlyHint')`. Reproduced both ways: with the repo's `pnpm nooklet serve` on a scratch data dir,
and with the built desktop sidecar — where it means the Mac app never starts, and a person cannot
reach Settings → Plugins to turn the plugin off. The op in question was B-336's own probe plugin
(`name`, `description`, `input`, `output`, `scope: "read"`, `handler` — no `summary`,
`annotations`, `scopes`). TypeScript would have refused it, but a plugin is bundled with esbuild,
which does not type-check. `ops/registry.ts#register` checks the name, MCP tool-name clashes and
`render`, but not the rest of `OpDef`'s required fields; mounting the HTTP route then reads
`op.annotations.readOnlyHint` (`registry.ts`, the `GET` alias) and throws outside any per-plugin
guard. The policy the host already follows for other plugin faults (`host.test.ts` "an unsupported
api major is a per-plugin error that never aborts the server") says this should be that plugin's
error, not the server's.

**Fixed 2026-09-13.** `packages/server/src/plugins/ops-bridge.ts#wrapPluginOp` — the one path every
plugin op takes into the registry (`server-context.ts`'s `ctx.ops.register`) — first checks the
fields the registry relies on (`name`, `summary`, `description`, `input`/`output` as schemas with
`safeParse`, `annotations`, `scopes`, `handler`) and throws `op "hello.say" is missing summary,
annotations, scopes — see defineOp's OpDef in @nooklet/plugin-api`. Thrown inside `activate()`, the
host records it as that plugin's error; core ops (TypeScript-checked, and not wrapped) are
untouched. Test that would have caught it: `host.test.ts` "an op missing required OpDef fields is
that plugin's error, and the server still starts (B-402)" — before the fix the test setup itself
threw `TypeError: Cannot read properties of undefined (reading 'readOnlyHint')` at
`registry.ts:493`; after, the plugin is `error` with the fields named and a sibling plugin's op
answers 200. Server unit 670/670. By hand: the same scratch-data `pnpm nooklet serve` that exited
now comes up healthy and logs `plugin "hello" failed to activate: op "hello.say" is missing summary,
annotations, scopes …`; and a rebuilt sidecar, started on a scratch `NOOKLET_DATA` holding that
plugin beside a working one, came up healthy, logged the same error, and served the working plugin's
op and client half.

---

### B-336 · In the desktop app a user's own plugin cannot import `@nooklet/plugin-api` or `zod`
**Status:** fixed · **Severity:** low (as B-180) · **Found:** 2026-09-13, verifying B-180 on `m9/cleanup` ·
**Test:** none; probe `tools/probes/sidecar-user-plugin.mjs` (exits 1 while this holds)

B-180's fix ships the BUILT-IN plugins pre-bundled; a plugin the user drops into
`<data>/plugins` still goes through the runtime loader, and in the sidecar that fails. The loader
(`packages/server/src/plugins/bundler.ts#hostAliasMap`) resolves the host-provided specifiers
(`@nooklet/plugin-api`, `@nooklet/core`, `zod`, `hono`) with `createRequire(import.meta.url)` —
the server's own `node_modules`, which a bundled `server.mjs` does not have — so the alias map is
empty and esbuild cannot resolve them. Reproduced with a built sidecar copied out of the repo and a
five-line plugin shaped like `plugins/word-count` (a `defineOp` from `@nooklet/plugin-api`, a
`z.object` from `zod`): the log says `plugin "hello" failed to activate: Build failed with 2
errors: … Could not resolve "@nooklet/plugin-api" … Could not resolve "zod"`, and its op answers
404. `nooklet serve` from the repo loads the same plugin. So every plugin written the documented
way (ADR 007, docs/spec/api-and-plugin-types.md) is dead in the Mac app, although `main.rs` sets
`ESBUILD_BINARY_PATH` precisely so user plugins can be bundled there. Not caused by `m9/cleanup`
(the resolution path is unchanged) and outside its brief. Likely fix: ship the host-provided
modules as files beside `server.mjs` (as `bundled.ts` does for the built-ins) and alias to those
when `NOOKLET_BUNDLED_PLUGINS_DIR` is set — or bundle them into a `plugins/_host/` the loader
points esbuild at.

**Fixed 2026-09-13.** Reproduced first at `70c9bb9`, with a sidecar built by `apps/desktop/build-sidecar.mjs`
and `tools/probes/sidecar-user-plugin.mjs apps/desktop/sidecar 6412`: `hello.say -> 404`, log `plugin
"hello" failed to activate: … Could not resolve "@nooklet/plugin-api" … Could not resolve "zod"`.

The fix ships the host-provided modules as files and points the loader at them:
- `packages/server/src/plugins/bundled.ts#packageHostModules(outDir)` writes `@nooklet/plugin-api`,
  `@nooklet/core`, `zod` and `hono` as one ESM file each (`nooklet__plugin-api.mjs`,
  `nooklet__core.mjs`, `zod.mjs`, `hono.mjs`; 7 KiB, 0.2, 0.7, 0.1 MiB), resolved from the server
  package's own dependencies, platform-neutral so a client half can use them too, each keeping the
  OTHER host modules as imports so a plugin that imports two of them still gets one copy of each.
- `bundler.ts#hostAliasMap` uses `$NOOKLET_HOST_MODULES_DIR/<file>` when the variable is set and the
  file exists, BEFORE `require.resolve` — so a sidecar never picks up a copy from some
  `node_modules` above wherever the app sits. Unset (every `nooklet serve` from the repo), nothing
  changes.
- `build-sidecar.mjs` step 7 writes `sidecar/host-modules/`, and `server.mjs`'s banner sets
  `NOOKLET_HOST_MODULES_DIR` beside `NOOKLET_BUNDLED_PLUGINS_DIR`, so `main.rs` needs no change (the
  whole `sidecar/` directory is already a Tauri resource).

Tests that would have caught it: `packages/server/src/plugins/bundled.test.ts` "a user's plugin
where the host modules are shipped as files (B-336)" — "aliases every host-provided import to the
shipped file, not to node_modules" and "builds, activates, answers its op, and bridges its OpError"
(also checks the plugin's bundle names `zod.mjs`/`nooklet__plugin-api.mjs` as inputs and no
`node_modules/…zod`). With `hostAliasMap` made to ignore the variable (the old behaviour) both fail;
with the fix, server unit 669/669. The whole path is the probe: with a freshly built sidecar,
`hello.say -> 200 {"hi":"there"}`, exit 0; the same sidecar with `host-modules/` deleted: 404 and
the two `Could not resolve` errors again. Also run by hand, the sidecar started as `main.rs` does
on a scratch `NOOKLET_DATA` with a user plugin that has a server half (`defineOp` + `OpError` + `zod`)
and a client half (importing `zod`): the op answered `{"greeting":"Ahoj, Dan!"}`, its `OpError` came
back as 404, the client bundle was served (200), neither bundle mentions `node_modules`, and the
built-ins are listed as before (`tools/probes/sidecar-plugins.mjs`: all checks ok).

The probe's own plugin had to change: it declared an op without `summary`, `annotations` or
`scopes`, and once its imports resolved that op crashed the server at startup — B-402.

---

### B-337 · `build-sidecar.mjs` ships whatever `apps/web/dist` happens to hold
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, verifying B-180 on `m9/cleanup` (by
reading, and by an e2e run that had just rebuilt `dist` from other sources) · **Test:** none

Step 5 builds the web client only when `apps/web/dist/index.html` is missing, then copies `dist`
into the sidecar. `dist` is rebuilt by every e2e run and every `vite build`, from whatever sources
the checkout had then — during this verification it held a build of `cf08d19`'s client for a few
minutes, while the server being bundled was HEAD's. A local `pnpm desktop:build` /
`pnpm desktop:install` after switching branches (or after an e2e run on another tree state) ships
that older client next to a newer server, with nothing to say so. CI starts from a fresh checkout,
where `dist` is missing and gets built, so the release workflow is not affected. Likely fix: always
run `pnpm --filter @nooklet/web build` in step 5 (Vite is quick), as `e2e/global-setup.ts` does for
the same reason.

**Fixed 2026-09-13.** Reproduced first with the new probe `tools/probes/sidecar-web-freshness.mjs`,
which plants a stale client in `apps/web/dist` (an `index.html` saying so, plus a marker file) and
runs the sidecar build: at `70c9bb9` it printed `STALE: sidecar/web/index.html is the planted one;
sidecar/web holds the marker; …`. Step 5 of `apps/desktop/build-sidecar.mjs` now runs `pnpm --filter
@nooklet/web build` every time (Vite empties `dist` first) and fails if that leaves no
`index.html`; the probe then prints `fresh: sidecar/web is a client built by this run`. Test that
would have caught it: that probe (there is no test suite for `apps/desktop`; the probe is the check,
and it exits 1 on a stale client). Cost: the web build, seconds, on every sidecar build.

---

### B-371 · `EditorSelection`'s documentation still says its text is the block's content
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, fixing B-361 · **Test:** none (comment
only)

`apps/web/src/commands/hosts/editor-host.ts` documents `EditorSelection.content` as "the focused
block's whole logical content" with `start`/`end` "offsets into `content`", and `replaceRange` as
writing into "the same logical content string". Since B-101 the real host
(`app/editor-host.ts#createEditorHost`) returns the CM6 editing buffer — content plus property
lines — and its offsets are buffer offsets; `insert-logic.ts` (B-153) and `templates.ts` (B-154)
already split it with `splitBlockText`. A caller that believes the comment gets B-361. Not changed
on this branch (a second bug found while fixing the first is logged, not fixed): the fix is to say
"editing text" in those three places and point to `editor/editText.ts`.

**Fixed 2026-09-13.** `apps/web/src/commands/hosts/editor-host.ts` now says "editing text" wherever
it said content: the file's design notes (with a paragraph on why the buffer is not the content, for
which blocks the two coincide, and where the split happens — `splitBlockText` in
`registrations/insert-logic.ts` and `registrations/templates.ts`, `editor/editText.ts` as the
boundary), `EditorSelection.content` and its `start`/`end`, `ReplaceRangeSpec.from`/`to`, and
`EditorHost.getSelection`/`replaceRange`. The field keeps its name `content` (renaming it touches
every command; the doc says so). Comment only, no test; checked against the real host
(`app/editor-host.ts#createEditorHost` reads `surface.content()`, the CM6 document).

---

### B-333 · `packages/core`'s performance and sync property tests fail under heavy machine load
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, m9 cleanup, final `pnpm -r
test` · **Test:** the tests themselves

With load average 62–84 on the shared machine, `pnpm -r test` stopped at `packages/core`, and a
rerun of that package alone failed the same four: `src/tokens.test.ts` "stays far away from
quadratic" (1,488 ms against its 500 ms budget) and three in `src/sync/sync.property.test.ts` —
"dense adversarial moves on a small block pool…" (timed out at 30 s), "converges regardless of
interleaving…" and "content and each prop key converge independently…" (5 s each). This branch
changes nothing in `packages/core` (`git diff cf08d19 -- packages/core` is empty). Not rerun on a
quiet machine; not investigated. A wall-clock budget and fixed per-test timeouts are the likely
reason — the property tests' run counts, not their assertions, would be what to look at. The same
package passed 393/393 minutes later at load average 26.

**Reproduced 2026-09-13 (m10/tests-desktop).** Not at 56 busy loops (all 398 passed; the property
tests at 6-8x their idle time). With `packages/core`'s suite run under `nice -n 20` and 140 busy
loops (load average 102-140): 3 of B-333's 4 failures — "stays far away from quadratic" (673 ms
against 500), "converges regardless of interleaving…" (6,260 ms against 5 s) and "content and each
prop key converge independently…" (5,358 ms against 5 s); "dense adversarial moves" took 16.8 s of
its 30. Cause, as the entry guessed: wall-clock limits. Nothing in these tests is broken, and
nothing in the property tests measures cost at all — a Vitest timeout is the only clock in them.

**Fixed 2026-09-13.**
- `packages/core/src/tokens.test.ts` measures PROCESS CPU TIME (`process.cpuUsage()`) instead of
  `performance.now()`, keeping the 500 ms budget. Probe `tools/probes/cpu-vs-wall-under-load.ts`
  (same 20,000 blocks): idle 18-20 ms CPU and wall; under 140 busy loops, niced (load average
  85-142), 19-32 ms CPU against 144-684 ms wall. That budget never could see what "quadratic" in
  a tokenizer usually means — cost growing with LINE length; its blocks are 70-90 characters — so a
  second test, "costs the same per character on a line four times as long", compares CPU time for
  one ~83k-character line against a ~333k one (best of three each, short first after a warm-up)
  and requires growth under 8 (linear is 4, quadratic 16). Measured growth: 4.4 idle, 4.4-5.1 at
  load average 122-153. It was checked against injected regressions: a char-by-char rescan from
  every 1024th character read 8.3 and failed; every 4096th, 6.2, and every 16384th, 4.9, passed —
  it catches a quadratic once that costs about as much as the tokenizer itself at ~300k characters,
  not a milder one. Both tests take a 60 s Vitest timeout as a hang guard (the scaling check took
  2.7 s of wall time at that load for ~0.2 s of CPU).
- `packages/core/src/sync/sync.property.test.ts`: every fast-check property gets a 120 s Vitest
  timeout, documented at the top of the file as a hang guard only (~100x the slowest idle time).
  `numRuns` is unchanged: these assert over a fixed number of runs, and trimming runs to fit a clock
  is how coverage disappears.

Tests: the tests themselves. Proof: the whole `packages/core` suite three times under `nice -n 20`
and 140 busy loops (load average 122-153): 399 passed each time, with "stays far away from
quadratic" at 451-661 ms wall (the old wall budget would have failed 2 of 3), "converges regardless
of interleaving" at 4.7-5.7 s (over the old 5 s twice) and "dense adversarial moves" at 16-20 s.
Idle: 399 passed.

---

### B-323 · `references.spec.ts` "shows a count and collapses" once sat on the page view's "Loading…"
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, e2e run on
`m9/render-views` · **Test:** —

In one combined run (render-views, pages, references, references-cap, references-filters,
tagged-pages, journal-agenda, journals, page-rename, navigation, link-unlinked — 51 of 52 passed) the
test's `/page/Refs%20Target` showed only `p.page-view-loading` "Loading…" for the whole 10 s
expectation: the ARIA snapshot had the top bar, "Loading…" and Help, no title and no outline. The
spec alone passed straight after (4/4), and the same combined set passed 52/52 on the next run. The
machine was shared by about a dozen agents, so load is the first suspect; recorded because
`page.loading && page() === undefined` holding for 10 s is also what a page-by-name resource that
never settles would look like. Not investigated; the failed run's trace was overwritten by the rerun.

**Diagnosis 2026-09-13 (m10/tests-desktop).** A product bug, not load. Reproduced in the entry's own
combined set (render-views, pages, references, references-cap, references-filters, tagged-pages,
journal-agenda, journals, page-rename, navigation, link-unlinked) under 56 busy loops, first try:
the same failure, and the same page — top bar, "Loading…", Help, with the sync indicator EMPTY
(its accessible name fell back to its title, "Show diagnostics"), i.e. the DB worker never finished
starting. The trace's network log has no `/sync/snapshot` request after the second `goto` at all,
and its console has the cause:

    nooklet-opfs-sahpool: Error: SAH pool is full. Cannot create file /nooklet.sqlite3-journal
    sqlite3_step() rc= 14 SQLITE_CANTOPEN SQL = CREATE TABLE page (…
    SQLite3Error: SQLITE_CANTOPEN … at new WorkerDb (ensureSchema)

`opfs-sahpool` gives SQLite one file from a fixed pool per file it opens: the database, and its
rollback journal from the first write. sqlite-wasm 3.53.4 fills the pool (six files) only when it
finds it EMPTY (`OpfsSAHPool` constructor: `getCapacity() ? … : addCapacity(initialCapacity)`), one
file at a time, awaiting each. The spec loads `/journals` (a fresh context, so a first-ever start)
and navigates away ~90 ms later; when that teardown lands inside `addCapacity`, the pool is left
with fewer than six files, and no later start adds any. With one, the database takes it, creating
the schema needs the journal, the journal cannot be opened, `WorkerDb`'s constructor throws, and
every query waits on a worker that never comes up. Load only widens the window. For a person: a
reload or closed tab in the first tenth of a second of the app's first start in a browser leaves
that browser's copy of the app on "Loading…" on every start after (by reading: the pool lives in
OPFS and nothing tops it up; not re-run across a second start). Measured separately with probe
`tools/probes/page-boot-under-load.spec.ts`: when the start is NOT cut short, the page renders in
0.1-0.4 s even at load average 74 or with the e2e server SIGSTOPped 80% of the time — which is why
"load" alone never explained a 10 s hold.

**Fixed 2026-09-13.** `apps/web/src/db/sqlite-wasm-driver.ts#openSqliteWasmDriver` calls
`poolUtil.reserveMinimumCapacity(6)` on every start, before opening the database, so a short pool
is topped up (and a browser already in that state recovers on its next start). Test that would have
caught it: `e2e/tests/opfs-pool.spec.ts` "a start cut short while the OPFS pool was being created
does not leave the app dead" — builds the state an interrupted first start leaves (the pool's
`.nooklet-opfs-sahpool/.opaque` directory holding ONE zero-length file, created from `/icon.svg` so
the app never runs first), then opens a page, checks the indicator says synced (OPFS, not the memory
fallback), edits, and reloads. At `70c9bb9`'s driver it failed with the B-323 page exactly
("Loading…", indicator empty); with the fix it passes (3 of 3 with `storage.spec.ts`; 8 of 8 in the
96-test run under 56 busy loops). The combined set, three fresh runs under 56 busy loops (load
average 60-75): 56 passed each. `references.spec.ts` keeps its extra `/journals` load: it is what
exercised this path.

**Verified 2026-09-13 (second agent).** `e2e/tests/opfs-pool.spec.ts` passes at the branch head
(2 of 2) and fails with the one line commented out (`element(s) not found` for "still here"). The
two things the entry had by reading only, now run: (1) a REAL first start cut short leaves a short
pool — probe `tools/probes/opfs-pool-interrupted-start.spec.ts` navigated away 70-113 ms after
`/journals` committed and found 1, 1, 1, 2, 4 and 5 files in 6 of 60 runs, every next start on the
fixed client rendering and synced; on the unfixed client 3- and 4-file pools still worked, so only a
one-file pool is fatal. (2) A browser the OLD client already broke recovers on the fixed one — probe
`tools/probes/opfs-pool-upgrade-recovery.mjs`, one persistent profile and origin with the server
restarted between an unfixed and a fixed client build: unfixed, `SAH pool is full. Cannot create file
/nooklet.sqlite3-journal`, nothing rendered, the one file now the database's (4096 bytes); fixed,
same profile, the page rendered, `synced`, an edit survived a reload and reached the server, and the
pool held six files. One tightening to the test: its storage check was `/synced|syncing/`, which
"synced via another tab" — an in-memory follower, the very fallback the comment rules out — also
matched; now anchored, `/^(synced|syncing \(\d+\))$/` (3 of 3).

---

### B-356 · `page-icons.spec.ts` "clearing the field removes the icon" reads the server before the clear has synced
**Status:** fixed · **Severity:** low (test harness) · **Found:** 2026-09-13, qafix-m8-views, running
nearby specs under load · **Test:** the spec itself

In an 11-spec run (7 minutes, shared machine) the test failed with `expect(received).toBeUndefined()
— Received: "🇨🇿"`: the title row already showed the empty icon slot, and the `page.read` right after
it still returned the old icon. The spec reads the API once instead of polling, so it races the
client's push. Passed on an immediate rerun (3/3). Fix: `expect.poll` around the `page.read`. Not
changed here (outside this branch's findings).

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

---

2026-10-04: `page-icons.spec.ts` "…clearing the field removes the icon" now clears through the emoji picker's Remove button (same server-poll assertions).

### B-335 · `editing.spec.ts`'s `openJournal` can wait 30 s to blur a journal draft that has already become an outline
**Status:** fixed · **Severity:** low (test harness) · **Found:** 2026-09-13, m9 cleanup, e2e
run of the first 38 specs (alphabetical) on port 6405 at load average ~40 · **Test:** the spec
itself

"types a whole sentence into a bullet without editing dying" and "Enter creates a second bullet and
both keep their text" failed with `locator.blur: Test timeout of 30000ms exceeded … waiting for
locator('.vr-draft-input').first()` (`editing.spec.ts:29`): `openJournal` saw a virtual draft,
`fill`ed it, and by the time it blurred, the draft had been swapped for the real outline (or was
never the only journal day on screen — earlier specs leave other days in the shared server's
stream). The same spec alone right after: 5/5. Same family as B-233 (specs sharing today's journal
on one server); nothing in this branch touches the journal views. Likely fix, as B-233 says: give
these tests their own page, or wait for the outline instead of blurring the draft.

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

### B-292 · `editing.spec.ts` "typing immediately after Enter is not discarded" cannot run with `--repeat-each`
**Status:** fixed · **Severity:** low (test harness) · **Found:** 2026-09-13, m9/focus (re-running
it to rule out load) · **Test:** the spec itself

It appends `- alpha` to a fixed page "Enter Probe" and then expects exactly one row, so on one server
the second run sees 2 rows, the third 3 (`Expected: 1, Received: 2…5`, `--repeat-each=5`). Passes
once per server, which is all a normal run does; it just cannot be looped to separate load from a
regression, which is the first thing a flaky-looking failure calls for. Fix: a page name per
`repeatEachIndex`/`retry`, as `views.spec.ts`'s palette test now has. Not changed here (not this
branch's spec).

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

### B-526 · `search-fallback.spec.ts`'s "not set up" test fails whenever `search-cleared.spec.ts` runs before it
**Status:** fixed · **Severity:** low (test only) · **Found:** 2026-09-13, search-fallback verify ·
**Test:** the e2e test itself, run as `search-cleared.spec.ts tests/search-fallback.spec.ts`

The e2e server and its graph are shared by every spec in a run. `search-cleared.spec.ts` seeds a
page named "Cleared Search Quokka"; the fallback test searches "quokka" and asserts
`.search-summary` is exactly "1 result". Run together (alphabetical order puts search-cleared
first, so every full-suite run does this): `Expected: "1 result" Received: "2 results"`, the second
hit being the page "Cleared Search Quokka" (screenshot in the run's test-results). The branch's own
runs used only search-fallback + settings + views, which is why it passed there.

**Fixed 2026-09-13.** The test searches a word no other spec uses ("fallbacknotequokka"). The pair
`search-cleared.spec.ts` + `search-fallback.spec.ts` on Chromium: 1 failed before ("2 results"),
5 passed after.

---

### B-525 · "Try again" / "Check again" on the search fallback note drops keyboard focus to `<body>`
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, search-fallback verify (real-graph
copy on :6418, Chromium and WebKit) · **Test:** `e2e/tests/search-fallback.spec.ts` › "Try again
and Check again keep keyboard focus on the pressed button when the same reason comes back (B-525)";
`apps/web/src/views/SearchView.test.tsx` › "Check again keeps keyboard focus on the button when the
same reason comes back (B-525)" (the `<For>` half only)

Tab to "Try again" (embedding server unreachable) or "Check again" (index still building) and press
Enter: the search re-runs, the note comes back with the same reason, and `document.activeElement`
is `<body>`. Measured with Playwright against this branch's production build: after Enter on "Check
again" during a real backfill and on "Try again" with `embedding.host` pointed at a closed port,
activeElement was `<body>` in both Chromium and WebKit; the note's button before and after the
refetch were different DOM nodes (`isConnected` false for the old one).

Cause: `SearchFallbackNote` renders its actions with `<For each={explained().actions}>`, and
`explainFallback` builds fresh `{kind, label}` objects on every call. `<For>` is keyed by
reference, so every new result — even one with the identical reason — disposes the focused button
and mounts a new one.

That was only half of it. Switching to `<Index>` kept the same button node (unit test green), and
focus STILL fell to `<body>` in Chromium: a MutationObserver on the note showed the button removed
and re-added on every result. Each item was `<>{" "}<button/></>`; Solid's `normalizeIncomingArray`
(solid-js 1.9.15 `web.js`) recurses into a nested array with the single previous node as
`current`, so the `" "` string never matches a previous text node and becomes a new one each time,
and `reconcileArrays` then re-inserts the button next to it — a move, which a browser blurs and
jsdom does not.

**Fixed 2026-09-13.** `apps/web/src/views/SearchFallbackNote.tsx`: `<Index>` over the actions, and
each item one `<span>` holding its space and its button. The e2e test fails on the branch's code
(`<For>`) and on `<Index>` with the fragment, passes with both changes on Chromium and on WebKit (run
through a throwaway config — the committed WebKit project only matches `storage.spec.ts`).

---

### B-523 · After turning semantic search on from the Search view's note, closing Settings leaves the note saying it is not set up
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, search-fallback (walking the owner's
flow on a real-graph copy) · **Test:** `e2e/tests/search-fallback.spec.ts` › "closing Settings
re-runs a search that had fallen back, so its note is not left stale (B-523)";
`apps/web/src/views/SearchView.test.tsx` › "closing Settings re-runs a search that fell back, and
only one that did (B-523)"

Search → "Set up semantic search…" → Settings → "Test connection & enable" → close. The Search
view underneath still shows the result it had before, so the note keeps saying "semantic search is
not set up" until the query is edited — it reads as if enabling did nothing. The results resource
is keyed only on the query and filters; nothing re-runs it when Settings closes.

**Fixed 2026-09-13.** `SearchView.tsx` re-runs the search when `settingsOpen` goes from true to
false and the result on screen had a `fallback`; a result that did not fall back is left alone.
The e2e test failed before the fix (no `search` request within 5 s of closing Settings).

---

### B-522 · With an active model whose host accepts connections but never answers, every semantic/hybrid search hangs
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, search-fallback (checking that
B-520's `fallback` covers an unreachable host) · **Probe:** `tools/probes/search-embed-silent-host.ts`
· **Test:** `packages/server/src/embeddings/query-embed-timeout.test.ts` (4)

A refused port fails at once and now says "not reachable". A host that accepts the TCP connection
and then says nothing — Ollama wedged while loading a model, a forwarded port to a stopped
container, a VPN route that drops packets — is different: the query embed's `fetch` gets only the
request's own abort signal, so the search waits on it. The probe's hybrid `search` was still
pending after 30 s (undici's default header timeout is 300 s). In the Search view that is
"Searching…" with no end and no reason — B-520's note never gets a result to render.

**Fixed 2026-09-13.** `embedQueryForSearch` (`packages/server/src/embeddings/semantic-search.ts`)
bounds the query embed with `QUERY_EMBED_TIMEOUT_MS` combined with the request's signal; a timeout
is reported as "no answer within N s" — `provider_unreachable` when the host's model list also does
not answer, `query_embedding_failed` when it does. After the fix the probe's search answers in
17.5 s (15 s bound + the probe's 2.5 s) with `provider_unreachable`. The tests use a 300 ms bound
against a silent socket and a host that lists the model but never embeds; run against the old
code, those two hang past their 15 s test timeout and the constant's test fails (3 of 4 fail; the
cancelled-by-caller test passes on both). The 15 s bound is sized against measured cold loads of
bge-m3: whole semantic searches of 5.9 s, 4.2 s and 1.4 s at load average ~70 (0.08 s warm).

---

### B-521 · `search` with a `pages` filter naming no existing page answers `mode_used: "keyword"` for a hybrid request
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, search-fallback (adding B-520's
`fallback`) · **Test:** `packages/server/src/ops/search-fallback.http.test.ts` › "reports the
requested mode — nothing was searched, so nothing fell back"

`pages: ["No Such Page"]` short-circuits before anything runs and returned `mode_used: "keyword"`,
which the op's own description tells an agent to read as "embeddings are unavailable". Nothing was
searched in any mode. It now returns the requested mode, empty hits, and no `fallback`. The web
client never sends `pages`, so this was agent-visible only.

**Fixed 2026-09-13.** `packages/server/src/ops/search.ts` (the early return). The test fails on
the old code.

---

### B-520 · Search says "Fell back to keyword search" and never says why
**Status:** fixed · **Severity:** medium · **Reported:** 2026-09-13 (owner sees "Fell back to
keyword search. 4 results" and asks whether semantic search works at all) · **Test:**
`packages/server/src/ops/search-fallback.http.test.ts` (7 of its 8, one per reason),
`apps/web/src/views/SearchFallbackNote.test.tsx` (11), `apps/web/src/views/SearchView.test.tsx` ›
"SearchView fallback note (B-520)" (3), `e2e/tests/search-fallback.spec.ts` › "a hybrid search on a
graph with no embedding model says semantic search is not set up, and the button opens Settings at
Search & embeddings"

The Search view's summary line says the search fell back to keyword and stops there. On the
owner's graph the cause is that no embedding model was ever configured — `embedding_model`,
`embedding` and `embed_dirty` are empty and there is no `embedding.*` setting — while Ollama is
running locally with bge-m3 pulled. Nothing on screen says that, or where to turn it on, and the
same words cover every other reason the server degrades: sqlite-vec not loaded, the embedding
server not answering, a model registered but still backfilling, a backfill that stopped on errors.
The server already knows which one it is (`checkSemanticAvailability`, `embeddings.status`); the
`search` op only returns `mode_used`.

**Fixed 2026-09-13.** `search` gains `fallback` {reason, message, provider, model, host, indexed,
total, errors, error}, present exactly when `mode_used` differs from the requested mode (spec:
`docs/spec/mcp-tools.md` §4.3.5). Reasons, decided in `packages/server/src/embeddings/
semantic-search.ts`: `sqlite_vec_unavailable`, `not_configured`, `indexing` (N of M),
`index_incomplete` (queue drained with failures — the state the model never leaves on its own),
`provider_unreachable`, `model_missing`, `query_embedding_failed`; the last three are told apart by
probing the host only after a query embed failed. The Search view
(`apps/web/src/views/SearchFallbackNote.tsx`) says each in its own sentence with the action that
fits: "Set up semantic search…" opens Settings scrolled to Search & embeddings
(`SettingsPanel.tsx#openEmbeddingsSettings`); unreachable/failed get "Try again"; indexing gets
"Check again". Every http test fails on the old code.

Walked end to end on a copy of the owner's graph with Ollama/bge-m3: the note said "not set up",
the button led to Settings, enabling took 213 ms, the note then said "still being built (0 of
19,583 embedded)", and 453 s later (14,468 vectors, 0 errors) the same hybrid search ran as hybrid
with no note. Details in `docs/progress/search-fallback.md`.

---

### B-481 · `repair org-dates` left a blank last line where a re-import leaves none
**Status:** fixed · **Severity:** low (no block on the owner's graph has the shape) · **Found:**
2026-09-13, repair-agenda verification · **Test:** `packages/server/src/repair-org-dates.test.ts`
"leaves the text a re-import would: no blank last line where the date line was"

The repair took only the date line out: `Mirek⏎⏎SCHEDULED: <2023-2-17 Fri>` became `Mirek⏎`, an
empty last line in the editor. `parseOutline` drops a block's trailing blank lines, so a re-import
of the same block gives `Mirek` — the repair's stated contract. Found by running `findOrgDateLines`
plus the repair's line filter against `parseOutline` on nine shapes; the other eight agreed. Fixed by
dropping trailing blank lines from the repaired text, as the parser does. The owner's 20 blocks are
all `<title>⏎SCHEDULED: <…>`, so their dry run is unchanged (checked on a fresh copy after the fix).
The new test fails with the trim disabled (checked).

---

### B-464 · "Keep mine", then a write elsewhere that leaves that version's text alone, brings the notice back
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, m11/remote-rewrite verification pass
(scratch e2e) · **Test:** `e2e/tests/remote-rewrite-edges.spec.ts` "Keep mine, then a marker flip of
the dismissed version: the notice stays gone"; `apps/web/src/editor/remote-text.test.ts` "an offered
version's text again under a newer HLC is held, not offered again (B-464)"

Type into `TODO mine` without pausing; an agent writes `TODO theirs`; the notice comes; click **Keep
mine** and keep typing. The agent then flips the marker (`old_str: TODO → new_str: DONE`, a
`block.text` of the same content `theirs`): the notice is back, offering `theirs` again — the version
just dismissed (scratch run: notice count 1 after the flip). Only within one burst of typing: once the
typing is written, the database holds it and a later flip carries it (B-462's `untouched`).

Cause: `TextVersions` remembers a dismissed version by its `content_hlc` only (`offered`), and the
flip moved the HLC without changing the text.

Fixed 2026-09-13: `offered` keeps the offered version's editing text with its HLC, and `decide`
(given `text`) answers `hold` for that text under a newer HLC. The e2e test failed before the fix
(notice count 1).

---

### B-463 · A rewrite taken into the editor while the `[[` popup is open garbles the pick
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, m11/remote-rewrite verification pass
(scratch e2e) · **Test:** `e2e/tests/remote-rewrite-edges.spec.ts` "a rewrite while the [[ popup is
open does not garble the pick"

Type ` see [[Zz Tar` into `alpha` and pause past the write debounce, popup open. An agent's
`block.update {old_str: "alpha", new_str: "ALPHA BETA"}` lands; with nothing unsaved the editor takes
`ALPHA BETA see [[Zz Tar` (B-192) and the popup stays open. Enter picks `Zz Target Page`: the
editor and the server both get `ALPHA BETA sZz Target Page]]z Tar`.

Cause: the `[[`/`#`/`((`/`/` popups keep the trigger's `from` offset, and `CommandLayer` re-detects
triggers only on keyup and pointerup. The take (`BlockTree#takeRemoteText`) changes the document
with neither, so the pick replaces a range computed against the text before the rewrite. Undo with
a popup open does not hit this: Cmd/Ctrl+Z's own keyup re-detects.

Fixed 2026-09-13: an open editor-fed popup (`commands/popup-keys.ts#isEditorPopupOpen` — the
autocomplete and the slash menu, not the context menu, palette or pickers) counts as unsaved typing
in B-192's verdict, so the newer version is offered on the row instead of taken under the popup. The
pick lands in the buffer it measured (`alpha see [[…]]`, written), and **Use the other version**
still takes the other text whole. The test failed before the fix (no notice: the text was taken).

---

### B-462 · An agent flipping the task marker while you type offers your own untyped text as "the other version"
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, m11/remote-rewrite verification pass
(adversarial e2e) · **Test:** `e2e/tests/remote-rewrite-edges.spec.ts` "an agent marking the task
DONE while you type does not offer the old text back"; `apps/web/src/editor/remote-text.test.ts` "a
newer version that left the text the typing started from is not offered (B-462)", "a version that
puts back the text the typing started from clears a standing offer (B-462)"

Type into `TODO call the plumber`; meanwhile an agent runs `block.update {old_str: "TODO", new_str:
"DONE"}` — the flip `block_update`'s own description recommends. The pill turns DONE and the row
says "This block changed elsewhere." with **Use the other version**, whose text is `call the
plumber`: the text as it was before the typing. The text did not change elsewhere; taking "the
other version" only throws the typing away (screenshot in the verification run:
`e2e/test-results/6412/remote-rewrite-edges-an-ag-…/test-failed-1.png`).

Cause: `block.update` with `content` or `old_str`/`new_str` always writes a `block.text` (plus
`marker`/`priority` props), even when the content is unchanged, so `content_hlc` moves. B-192's
verdict (`editor/remote-text.ts#decide`) sees a newer `content_hlc` whose text differs from the
buffer (the buffer has the typing) and offers it — it never asks whether the other writer changed
the text the typing started from.

Fixed 2026-09-13: `decide` takes `sameAsBeforeTyping` — the fetched text says what the buffer said
when the unsaved typing began (`pendingEdit.treeBefore`) — and answers `untouched`: no notice, the
typing stays, a standing notice for the block goes (the version it offered is no longer what the
database holds). Like an offered version it is not recorded as known, so a typing write that still
lost to it is followed on the next refetch with nothing unsaved. Mutation-checked: with
`sameAsBeforeTyping: false` the e2e test fails (notice shown).

---

### B-461 · With this tab's clock behind, typing on a text written elsewhere is silently lost
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, m11/remote-rewrite verification
pass (adversarial e2e) · **Test:** `e2e/tests/remote-rewrite-edges.spec.ts` "with nothing typed and
this tab's clock behind, typing on the taken text is saved", "with this tab's clock behind, typing
into a block the row showed rewritten elsewhere is saved"; `remote-rewrite.spec.ts` "…the typing is
kept even when this tab's clock runs behind" still guards the offer path

Tab clock 20 s behind the server (`page.clock.setFixedTime(now − 20 s)`). Put the caret in
`original`; an agent's `block.update` makes it `rewritten`; the editor takes it (B-192). Type
` more`: the editor shows `rewritten more`, the server keeps `rewritten` (polled 15 s). The same
happens without B-192's take path — the row shows the agent's `rewritten`, click into it and type
` more`: stored stays `rewritten` (probe run 2026-09-13, same setup). In real use the window is the
skew (≤ 60 s, `HLC_MAX_DRIFT_MS`), and nothing on screen says the typing was dropped.

Cause: the editor's clock (`editor/clock.ts`) is a `new Hlc(deviceId)` that only follows wall time;
it never absorbs an HLC it has seen. Every keystroke's `block.text` is stamped below the other
writer's `content_hlc`, and `applyBlockText` drops it as stale. B-192's fix made it absorb the HLC
of an OFFERED version (`Clock.receive`, 99f54ff) but not of a taken one, nor of any text the tree
shows.

Fixed 2026-09-13: `BlockTree` absorbs the newest `content_hlc` of every page fetch into the editor
clock (`absorbFetchedHlcs`, and once more when the clock loads after a fetch), which replaces the
offer-only `receive`. Mutation-checked: with the absorb removed, both new tests and the existing
offer-path skew test fail (3/3). Not covered: HLCs of property, marker and date columns — the page
tree carries only `content_hlc` (the same gap as B-460), so a marker toggled right after a
clock-ahead writer's marker write can still lose last-writer-wins within the skew (by reading, not
probed).

---

### B-192 · A block's text rewritten elsewhere while you edit it stays stale, and your next keystroke reverts it
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, fixing B-88 (probe below) ·
**Test:** none for the editor itself (the probe was a throwaway spec; its steps are here)

Put the caret in a block. Something else rewrites that block's text — another device, an agent's
`block_update`, or this app's own "Turn into page" (server op `block.to_page`, which turns the
text into `[[First line]]`). The rows around it update after the pull; the block being edited
keeps showing its old text. Type one character: the old text plus the character is written back
over the rewrite, last-writer-wins. Probe (2026-09-13, "Turn into page" with its end-editing step
removed): the server had `[[Probe kickoff]]`; after typing ` typed` it had `Probe kickoff typed`.

Cause: `BlockTree`'s tree effect always prefers the live CM6 buffer for the block being edited,
because a refetch that read before one of this tab's own writes looks the same as an external
change (the B-66 note in that effect). `surface.replaceContent` exists for external changes but is
only called for this tab's own undo/redo/merge. "Turn into page" keeps ending editing before its
op (`commands/registrations/refactor.ts#leaveEditing`) for this reason; there is no guard for the
other writers. A fix needs a way to tell a stale read from a newer write — the block's
`content_hlc` against the HLC of the last text op this tab wrote, for one — and a decision on what
to do with unflushed keystrokes when a newer external text arrives (the owner's call: merge,
prefer local, or prefer remote).

**Fixed 2026-09-13.** Owner-approved behaviour: with no unsaved typing the editor takes the other
text, the caret mapped through the change; with unsaved typing the typing stays and the row says
"This block changed elsewhere." with **Use the other version** and **Keep mine**.

Stale read vs newer write is decided by HLC, not timing (`apps/web/src/editor/remote-text.ts`,
`TextVersions`). `BlockTree` records the HLC of every `block.text`/`block.create` op it writes
(`commit`, `flushPendingEdit`, undo/redo, `initialOps`) and of every fetched text it puts on screen
(not one an unanswered write stands in for). A fetched `contentHlc` newer than all of those is a
write the database kept over anything this tree wrote — last-writer-wins on `content_hlc` — so it is
from elsewhere; a refetch that read before this tree's own write carries an older one and the buffer
wins, as B-66 needs. "Unsaved typing" is a pending edit that `flushPendingEdit` would still write. An
offered version is not recorded as known (if the typing's write still loses to it, the next refetch
takes it — the editor never shows text the database does not hold), and the editor clock absorbs its
HLC (`Clock.receive`, `editor/clock.ts`) so the typing's write is newer even when the other writer's
clock runs ahead — without that, a tab 20 s behind lost the kept typing to "theirs" (e2e below); a
dismissed version is not offered again. "Use the other
version" writes the other text as one undo step (Cmd/Ctrl+Z puts the typing back) and drops the
unwritten keystrokes rather than writing them first. Caret: `mapThroughRewrite` — before the changed
span it stays, after it keeps its distance from the end, at the very end it stays at the end.

"Turn into page" no longer ends editing first (`commands/registrations/refactor.ts#leaveEditing`
removed): the editor shows `[[First line]]` and typing continues after it. Removing it exposed what
the workaround also did — flush the keystrokes still inside the 500 ms debounce before the server op
(the context menu keeps focus in the editor, so nothing else flushed them). `refactor-host.tsx`'s
`write` now calls `editor/outline-registry.ts#flushTyping` before its push.

Tests: `e2e/tests/remote-rewrite.spec.ts` (10): an agent's `block.update` with nothing typed; with an
edit before the caret; with unsaved typing then "Use the other version" (Cmd/Ctrl+Z brings the typing
back, redo takes it again); with unsaved typing then leaving the block; with unsaved typing then
"Keep mine" while typing continues through another refetch; "…the typing is kept even when this
tab's clock runs behind" (`page.clock.setFixedTime(now − 20 s)`; failed before `Clock.receive` with
the stored text `"theirs"`); a second browser context (its own
replica and device) with nothing typed and with unsaved typing; "Turn into page" on the edited row
with typing inside the debounce; and "typing straight on after Tab is never offered back as a change
from elsewhere". Run against the old code, the first seven written all failed (the clean cases showed
`"original text"` / `"shared start"` where the rewrite was, the unsaved cases never showed a notice,
"Turn into page" ended editing); "leaving the block" was added later and waits for a notice the old
code never shows (not run against it). Two guard the new comparison itself, mutation-checked
2026-09-13 (2/2 failing each): "Keep mine…" with the verdict's `hold` removed, and "…after Tab…" (which
passes on the old code) with this tree's own writes left unrecorded.
`apps/web/src/editor/remote-text.test.ts` (17) › "a refetch that read before this tab's own write is
not a remote change" and the rest of the verdict table, plus `mapThroughRewrite`;
`apps/web/src/editor/outline-registry.test.ts` › "typing flush (B-192)";
`apps/web/src/commands/registrations/refactor.test.ts` › "neither block command ends edit mode".

---

### B-552 · A breadcrumb step whose parent is a heading (`## Articles`) renders empty — the breadcrumb vanishes or starts with a stray "›"
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, adversarial verification of B-550 on a
copy of the owner's graph · **Test:** `apps/web/src/views/ReferenceItem.test.tsx` › "a heading, a fence
or an empty parent still reads as a step with text (B-552)"; `apps/web/src/views/referenceNesting.test.ts`
› "drops a heading's #s and skips lines that render as nothing inline (B-552)"

`views/ReferenceItem.tsx#ReferenceBreadcrumb` renders each step as
`<InlineContent content={breadcrumbLabel(parent.content)}>`, and `breadcrumbLabel` is the parent's
first non-blank line as written. `tokenizeContent` returns NO tokens for a heading line
(`## 🔖 Articles`, `### Content`, `# [[@Alex]]`), a fence's opening line (```` ```js ````, `~~~`) or a
thematic break (`---`) — they are block-level — so the step is an empty, zero-width, focusable
`<span>` with only its `title` saying what it was. On the real graph that is 94 steps on 62 target
pages: every OmnivoreSync article referenced from a journal day sits under `## 🔖 Articles` and shows
no breadcrumb at all (`/page/2024-10-23`), and `/page/arguments` shows `› Poznámky k rekonstrukci a … › Rozpočet a materiál`, the first step (`## Plánování zahradních úprav`) missing.
An empty parent block (2 on the real graph) gives the same stray separator.

**Fixed 2026-09-13.** `views/referenceNesting.ts#breadcrumbLabel` drops a heading's `#`s, skips fence
delimiter lines and thematic breaks, and says `(empty)` (as the zoom trail does) when nothing is
left. Both tests failed before the change (the component rendered `["", "", "", ""]`). Checked on the
graph copy: `/page/2024-10-23` shows `🔖 Articles` over its OmnivoreSync article, `/page/arguments`
shows `Plánování zahradních úprav › Poznámky k rekonstrukci a … › Rozpočet a materiál`.

---

### B-551 · Numbered blocks (`list:: number`) show plain bullets, no ordinals, in embeds and the references panel
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, references-render (B-550) · **Test:** `e2e/tests/references-render.spec.ts` \"a numbered list item keeps its number in the references panel, and so do its children (B-551)\"

`editor/render/ReadOnlyOutline.tsx` (the read-only outline `{{embed}}` and the references panel
share) renders a bullet for every row; `BlockRowView` numbers `list:: number` siblings through
`editor/numbering.ts#deriveNumbering`, and the read-only rows never do. The owner's graph has 705
`list:: number` blocks, so a referenced or embedded numbered list reads as an unordered one (`list`
is also a hidden property key, so nothing else says it is numbered).

Children are easy — their siblings are all in the tree. The root is not: its ordinal depends on
siblings on its page that the view does not have (a reference to item 3 of a list would read "1."),
which is why this was logged rather than folded into B-550.

**Fixed 2026-09-13 (coordinator, at the owner's request).** `ReadOnlyOutline` numbers every group of
children with `editor/numbering.ts#deriveNumbering`, and takes the roots' ordinals from its caller:
`data/reference-trees.ts` reads the numbered outermost references' siblings on their page in one
query (`rootOrdinals`), and `data/embeds.ts` counts them from the page tree it already has. Rows use
the outline's own `.vr-list-number` markup. `isNumbered` now tolerates a node with no `properties`.
Tests: the e2e test above (a reference to item three reads "3.", its children "1." "2."),
`data/reference-trees.test.ts` "gives a numbered reference its ordinal among its siblings on the page
(B-551)", `editor/render/embed.test.tsx` "numbers list:: number blocks as the page does, each group of
children on its own (B-551)".

---

### B-550 · Linked references show a block as one line of plain inline text, not the block with its children
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, owner report ("linked references are not
formatted as markdown — instead of it being nested as displayed when clicked, it's displayed as just
free text") · **Test:** none yet

`views/ReferencesPanel.tsx#ReferenceGroups` renders each reference as
`<InlineContent content={ref.text}>` inside a button: inline tokens only, no block-level rendering
(multi-line text, fences, properties) and none of the block's children, so a referencing block with a
nested outline under it reads as a flat sentence. Logseq shows the referencing block rendered as in
the outline, with its children nested (collapsible) and a breadcrumb of its parents. The read-only
subtree renderer built for embeds (`editor/render/EmbedView.tsx`, `embedRows.ts`) already does most of this.

**Fixed 2026-09-13.** Each linked reference and unlinked mention now renders as the block looks
in its page, read-only: the full content through the outline's renderer (marker, priority,
multi-line text, fences, math, property chips, date chips), its children nested under a bullet
that folds in the panel only (stored `collapsed` honoured, root included; the toggle writes
nothing), and a breadcrumb of its parent blocks when it is not top-level. A row opens its block,
a link inside opens its target, a breadcrumb step opens that parent.

- The renderer is the embed's: `editor/render/ReadOnlyOutline.tsx`, moved out of `EmbedView.tsx`
  and shared by both (rows gained property and date chips, so embeds show them too; a date chip in
  a read-only row opens the block instead of the picker).
- Children and parents come from the replica, one read per list (`data/reference-trees.ts`: ancestor
  chains, subtrees of the outermost references, properties, ancestor text). `page.backlinks` still
  says which blocks reference the page.
- A reference inside another listed reference is not a row of its own (`views/referenceNesting.ts`):
  every descendant of a linking block is a `path_ref` reference, so without folding each child
  appeared twice. On the owner's graph `@alex`'s 756 references are 91 rows. Folding is against the
  filtered list — a child whose parent the filter hides becomes a row, with that parent in its
  breadcrumb. The heading still counts blocks (what `page.backlinks` reports); Logseq counts
  top-level references instead — left as an open question. **Resolved 2026-10-03 by B-596** (Logseq's direct count).
- A breadcrumb identical to the row above's is left out (`task`: 169 breadcrumbs → 66).
- Rows are keyed by page name and block id, so a backlinks refetch (one per typing pause) keeps
  them and their folds; before, every row was rebuilt on each refetch.

Measured on a copy of the owner's graph (`tools/probes/references-render-real-graph.mjs`, shape in
`tools/probes/references-shape-real-graph.sql`): first reference row 87–99 ms → 120–202 ms after
navigation on `@alex`/`task`/`camp`/`weekly review`/`@robin`; no main-thread stall over
50 ms while loading or on a refetch; 34–200 references, 179–456 outline rows rendered (row cap 50
per reference, 200 references per window, `content-visibility: auto` on rows).

Tests: `e2e/tests/references-render.spec.ts` › "a referencing block renders nested and formatted
under a breadcrumb; a child row opens that child" and › "with nested references, the filter, the
sort and Link all still work" (both fail on the old panel: 6 flat rows instead of 1; 4 instead of
3); `apps/web/src/views/ReferenceItem.test.tsx` (8, incl. the breadcrumb: order, one line each,
step → block, page link → page, none at top level, left out under an identical one);
`apps/web/src/views/referenceNesting.test.ts` (8); `apps/web/src/data/reference-trees.test.ts` (4).
`e2e/tests/views.spec.ts` › "a reference's page name opens that page, and the item opens the block
zoomed" now clicks the rendered row.

Not done: a ```` ```query ```` fence inside a reference renders as code, not live results (the
renderer's depth rule, as in embeds); references are not editable (by request).

---

### B-446 · The ADR 024 migration puts 259 empty pages at the top of "Recently edited" and of `graph_overview`'s recent pages
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, ref-pages adversarial verification
· **Test:** `packages/server/src/ref-pages-migration.test.ts` "dates each page by its earliest
reference, so they do not top 'Recently edited' (B-446)" (fails against `3496234`'s sweep)

`page.updated_at` is only ever the `createdAt` of the page's `page.create` (core never bumps it), and
All pages sorts by it by default ("Recently edited"), as do `graph_overview`'s `recent_pages` (the
tool an agent orients itself with) and the plugin page source. `mintDanglingReferencedPages` stamps
every page it creates with `Date.now()`, so on the owner's graph copy the first 259 non-journal rows
of All pages after the upgrade — before any of the 127 pages the owner wrote — are `Task`,
`quick capture`, `AcmeCorp`, `call`, … all empty, and `recent_pages` lists 20 of them. The same
applies to `nooklet import`, which runs the same sweep after the files. Measured with SQL on the
migrated copy (`ORDER BY updated_at DESC` over live non-journal pages): the first page not made by
the sweep was row 260.

**Fixed 2026-09-13:** the sweep dates each page it creates by its earliest reference —
`WantedPages.want(name, at)`, the referencing block's `created_at` (a page's `created_at` for
`tags::` and namespace ancestors), the minimum when several reference it. The per-write planner
still uses "now": a link typed today does make a page today. Fresh copy of the owner's graph
(`tools/probes/ref-pages-migration-real-graph.ts`): 259 created in 74 ms, 17 journal keys left,
verify OK over 20,736 ops; `Task`, `quick capture` and `@Eva Svobodová` dated 2023-02-27,
`Sprouts` 2024-10-20, `Sprouts/Growing/Sixth Try` 2026-09-06; 14 of the top 20 "Recently edited"
are pages the sweep made, each because a block written recently links it.

---

### B-445 · A block written offline onto a linked page disappears when another device removes the link meanwhile — not even in the trash
**Status:** fixed · **Severity:** high (content invisible) · **Found:** 2026-09-13, ref-pages
adversarial verification · **Tests:** `packages/server/src/ref-pages.test.ts` "writing that reaches a
page after the junk rule deleted it (B-445)" (4), `apps/web/src/sync/e2e.test.ts` "writing that
reaches a linked page after its link was removed keeps the page, on every replica" — all five fail
against `3fbd9de`'s `ref-pages.ts` (checked by swapping the file back); and in Chromium,
`e2e/tests/ref-pages.spec.ts` "what an offline device typed into a linked page survives another
device removing the link (B-445)" (two contexts; fails on `3fbd9de`, passes on the fix)

Device B has the empty page `[[Offline Notes]]` made (ADR 024) and, offline, types into it. Device
A edits the only link away; the server deletes the page as unclaimed junk. B comes back online: its
`block.create` is accepted onto the tombstoned page (core accepts a block on a deleted page), B
pulls the delete, and the page with B's text vanishes. `trash.list` hides it too —
`HIDDEN_FROM_TRASH_SQL`'s first branch hides every page `refpages` deleted, whatever it holds now.
Reproduced in `serverApplyOps` with B's op clocked before A's edit and applied after: page
`deleted_at` set, hidden from trash, live pages `["Home"]`. The brief's rule was "a page someone
typed into survives"; with sync the typing can arrive after the deletion.

**Fixed 2026-09-13:** `ref-pages.ts#pagesToRevive`. After a batch, a page the junk rule deleted
(its `deleted_hlc` is a `refpages` delete) that the batch wrote into — a live block on it, a
property, a rename — and that is therefore no longer unclaimed is brought back in the same call
(`page.delete` with `deletedAt: null`, device `refpages`, after the batch's other page ops). If a
newer unclaimed page took the name meanwhile (the link came back), that one is deleted first; if a
page someone claimed holds the name, the written page stays deleted but `HIDDEN_FROM_TRASH_SQL` now
only hides a page that holds nothing *now* (no block rows, no properties), so the trash lists it
and `trash.restore` with `new_name` can bring it back. Its namespace ancestors and its blocks'
links count again, like a page restored from the trash.

Exposure this adds to B-443: the un-delete is a revival of a tombstone, which a replica lacking that
row would miss. That replica needs its own page of the name created, accepted and deleted again
between the junk deletion and the late write — and it would miss the late write itself anyway.

---

### B-440 · Every page write scanned `path_ref`: ~50 ms per page op on the owner's graph
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, ref-pages (the ADR 024 migration
took 13.9 s for 259 page creates) · **Test:** `packages/server/src/db.test.ts` (schema version and
migration order cover v7); measured with the scratch timing script described below

`page-aliases.ts#reindexPageIdentity` runs on every page op and asks `ref`, `path_ref` and `page_tag`
which keys currently point at the page (`WHERE dst_page_id = ?` / `page_id = ?` / `tag_page_id = ?`).
Only the `*_key` columns were indexed, so each call scanned `path_ref` (32,674 rows on the copy):
`--cpu-prof` of 80 `page.create`s put 4.1 s of 4.45 s in that one `driver.all`. Measured 50–67 ms
per `page.create` through `serverApplyOps` before, 0.2–1.7 ms after. Every rename, property toggle
and page create on a real graph paid it — and ADR 024 adds page writes to link edits.

**Fixed 2026-09-13:** schema v7 adds partial indexes `ref_dst_page_id`, `path_ref_page_id`,
`page_tag_page`. The migration of B-441 went from 13,946 ms to 464 ms on the same copy. No test
asserts the plan; the `EXPLAIN QUERY PLAN` after the change reads `SEARCH … USING [COVERING] INDEX`
for all three.

---

### B-442 · A page created on one device under a name the server already has never syncs, and nothing written on it reaches the server
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, ref-pages (designing ADR 024's
two-device case) · **Test:** `apps/web/src/sync/e2e.test.ts` "a page created offline under a name
the server already made from a reference converges, push first" and "…, pull first" (both fail
without the fix: checked by running them against the previous `sync-client.ts`)

Device A, offline, creates "X" and types blocks into it; meanwhile the server gets a page "X" from
another device (before ADR 024 only by an explicit create on both sides; with it, by any `[[X]]`).
On sync the server rejects A's `page.create` (`page-key-collision`) and every block on it
(`no-such-page`); the client dropped the rejected ops from its outbox and kept its own page, and
when the server's "X" arrived by pull it was rejected locally for the same collision. A kept a page
nobody else had, its text existed on A only, and the replicas never converged. (B-410 was the
journal-day face of this, fixed then by not offering a draft before the first sync.)

**Fixed 2026-09-13:** `POST /sync/push` names the live page for each refused `page.create`
(`refused_pages`, a snapshot row); a pull that brings a `page.create`/`page.rename` for a name a
local page holds is detected too (`apps/web/src/sync/refused-page.ts#pagesDisplacedByPull`). Either
way the client removes its refused page and what was on it, takes the server's page, and re-sends
the blocks' current state onto it as fresh ops. The server does not rewrite the late ops itself:
their HLCs are older than the page's `page.create`, and `verify`'s HLC-ordered replay would reject
them (the test asserts `verifyRebuildParity` stays empty). Not covered: a block the server already
had, moved onto the refused page and deleted there, keeps its old place.

The pull-time detection first fired too eagerly: a device whose page the server had ACCEPTED, pulling
an older page of the same name that the server created and deleted meanwhile (a link's short-lived
page), moved its own content onto that tombstone. It now fires only for a local page whose
`page.create` is still in `pending_op`, and only when the pulled page still holds the name at the end
of the batch. Tests: `apps/web/src/sync/e2e.test.ts` "a page of a name whose earlier page the server
deleted stays this device's page, push first" and "…, pull first" (both fail without that
condition). The push response now names the live page for any rejected `page.create`, so a retried
push (`already-recorded`) gets the same answer.

---

### B-441 · A page that is only referenced does not exist: `/page/Sprouts/Growing/Sixth Try` says "doesn't exist yet", and the graph, All pages, search and `page_list` do not show it
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, owner ("…does not exist, even though
I did reference it already. We need to create pages on references, otherwise it's also not showing
in graph and stuff, right? This is how Logseq works.") · **Tests:**
`packages/server/src/ref-pages.test.ts` (17), `packages/server/src/ops/ref-pages.http.test.ts` (6,
incl. "an agent's block.update adding [[Agent Made Page]] makes page.list, page.read and search see
it"), `packages/server/src/ref-pages-migration.test.ts` (3)

A reference to a page nobody created stayed a dangling key in `ref` (`dst_page_id` NULL). A copy of
the owner's graph (taken 2026-09-13 17:34) had 265 such keys and 1,355 such rows — `task` (the
derived Task tag, 686), `quick capture` 89, `@eva svobodová` 17, `home automation`, `idea`… Of the
265, 17 are journal days.

Also tested: `e2e/tests/ref-pages.spec.ts` (5, Chromium), `packages/server/src/mcp/server.test.ts`
"a page an agent's block_update links is in page_list and readable with page_read",
`packages/server/src/mirror/live.test.ts` "writes no file for a page only a reference made…".

**Fixed 2026-09-13** by ADR 024 (`docs/adr/024-pages-exist-once-referenced.md`): the server mints
`page.create` for every newly dangling reference key and its namespace ancestors inside
`serverApplyOps` (`packages/server/src/ref-pages.ts`), removes the ones it made when their last
reference goes and nobody claimed them, and a gated startup migration
(`packages/server/src/ref-pages-migration.ts`) creates the missing pages of an existing graph. On the
graph copy (`tools/probes/ref-pages-migration-real-graph.ts`): 259 pages created (248 keys + 11
ancestors) in 464 ms, 17 keys left dangling — all journal days, by design — second run a no-op,
`pnpm nooklet verify` OK over 20,705 ops.

`nooklet serve` on a fresh copy (port 6410): startup logged "created 259 pages the graph references
(ADR 024) in 312 ms", dev verify OK; `page.read Sprouts/Growing/Sixth Try` → 0 blocks, 1 linked
backlink; five `block.update`s walking a link through `[[ZZ probe A]]`→`Ab`→`Abc`→`#zzprobetag`→
plain took 8–12 ms each and left no page and no trash entry; `verify` after stopping: OK, 20,730 ops.
The first mirror sweep also dropped 37 `mirror_file` rows: pages that already existed with no blocks
and no properties (`Alex`, `Someday`, `2022-12-28`, … — imported empty) lose their mirror files under
the new mirror rule. Their pages stay.

---

### B-511 · Every refresh rebuilds a query fence's result rows, the references panel's rows, and each row's date chips and property rows
**Status:** fixed · **Severity:** low (identical content; cost grows with the page) · **Found:**
2026-09-13, ref-label-flash · **Test:** `e2e/tests/ref-label-flash.spec.ts` › "a refresh changes
nothing on screen but the block that changed, and rebuilds nothing else (B-500, B-511)"

Nothing visible changes, but the DOM is thrown away and recreated on every refresh (a pull, or a
local write anywhere on the page). Counted with a MutationObserver over 5 pulls of an unrelated
edit on one page: all `.vr-query-hit` elements (10 = 2 hits × 5), every `.reference-item` (5), the
outliner's `.vr-date` chip (5) and `.vr-prop` row (5) were new elements each time. Each list is a
keyed `<For>` over objects rebuilt by the re-read, so equal content still counts as a new item.
Anything stateful inside them (an image, a hover, a text selection in a result) is reset on every
sync. On the owner's `OmnivoreSync` page (556 block properties) a single refresh created 856
elements.

**Fixed 2026-09-13.** The four memos feeding those lists compare by value
(`data/same-json.ts#sameJson`, JSON-shaped data only): `DateChips`' chips, `BlockProperties`'
entries (was a plain function), `QueryFenceView`'s `latest`, `ReferencesPanel`'s `data`. Equal data
passes the previous array on, so `<For>` has nothing to diff. The e2e test's mount count failed on
the B-500 commit (`queryHits` 10, `referenceItems` 5, `dateChips` 5, `propRows` 5, `blockRefs` 10)
and is `{}` after, Chromium and WebKit. Not changed: when a query result or a reference really does
change, its lists are still rebuilt whole (they are keyed by object, not by block id).

The per-row half, no DOM involved: every refresh also re-ran each outliner row's marker, priority,
date-chip and property derivations, because `BlockTree`'s per-row `row`/`block` memos handed every
`BlockRowView` a new object. Those memos now compare field by field (`editor/same-fields.ts`, one
level into `properties`; anything uncomparable counts as a change). Measured on the real-graph copy
(`tools/probes/refresh-render-count.mjs`): per-row re-derivations per refresh 252 → 1 on a 252-row
page, and the synchronous tree update 3.3 → 2.2 ms (201 rows 2.9 → 1.5, 150 rows 2.1 → 1.1). Test:
`apps/web/src/editor/same-fields.test.ts` (the comparator); the saving itself is measured, not
asserted by a test. e2e editing/parity/selection/tasks/dates/block-properties/merge/redo/focus/
journal-stream/embeds/page-find/read-only/context-menu + this spec: 156/156.

---

### B-510 · The references panel shows `((id))` for every block reference, never the block's text
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, ref-label-flash (recording what a
refresh does to the references panel) · **Test:** `e2e/tests/ref-label-flash.spec.ts` › "the
references panel shows a block reference's text, not its id (B-510)"

A linked reference whose text contains `((some-block))` shows the raw `((1m2d…))` placeholder in
the references panel, where the outliner row itself shows the referenced block's text. The panel
renders through `InlineContent`, which passes no block-reference resolver.

**Fixed 2026-09-13.** `InlineContent` takes an optional `resolveBlockRef` (a prop, so the
component still imports no replica client); `ReferencesPanel` passes
`block-ref-cache.ts#resolveBlockRef`. The e2e test failed on the B-500 commit (`((1m2d…))`
received) and passes in Chromium and WebKit. Other `InlineContent` callers (search snippets, the
tasks view, the agenda, property values) still show the placeholder — not changed here.

---

### B-500 · Every sync refresh briefly turns block references into `((id))` placeholders
**Status:** fixed · **Severity:** medium (seen constantly in daily use) · **Found:** 2026-09-13, owner
report · **Test:** none yet

"The syncs/refreshes are very annoying because all references briefly become ((id)) until they are
relabeled by their true name." A refresh (pull after a push, or a poke) re-renders the page's rows and
their block-reference labels go back to the unresolved placeholder until the lookup answers again —
resolved labels are not kept across a refresh.


**Owner, later the same day:** "that refresh with id might have been just one isolated case, don't over do it." Scope: fix the cause if it is the obvious one (the whole block-ref cache emptied on every block write), with one test; no broader re-rendering work under this entry.


**Owner, 2026-09-13:** can no longer reproduce it. Unless the running branch found a concrete cause with a test, close as not reproducible.

**Fixed 2026-09-13.** Reproduced first with a MutationObserver recorder, identical in Chromium and
WebKit: 5 pulls of an unrelated edit on a page with four `((refs))` put every label back to
`((id))` in 25 of 30 DOM snapshots; typing six characters into another block, 4 of 13. The rows and
ref spans were not remounted — `data/store.ts` emptied the whole label cache
(`block-ref-cache.ts#invalidateBlockRefs`) on every change event naming the `block` table, so every
lookup missed until its re-read answered.

`data/block-ref-cache.ts` is now stale-while-revalidate: a change bumps a generation and re-reads
the ids some live label is showing, in one `IN (…)` query per tick, keeping the old text on screen
until the answer lands; a text that did not change notifies nothing (one signal per id, compared
with `===`), an older answer never overwrites a newer one, a failed re-read keeps the text, and an
id nobody shows is re-read on its next lookup. Tests, all failing on the old cache and passing in
Chromium and WebKit: `e2e/tests/ref-label-flash.spec.ts` › "block reference labels stay resolved
across refreshes from pulls (B-500)", "… while typing in another block (B-500)", "a refresh
changes nothing on screen but the block that changed, and rebuilds nothing else (B-500, B-511)",
"a label changes when its target's text does, and never passes through ((id)) (B-500)" — each
records every DOM state with a MutationObserver and fails on any snapshot holding an unresolved
`((id))`; `apps/web/src/data/block-ref-cache.test.ts` (8). The webkit project now runs this spec.
Real-graph numbers (per refresh, 150-row page with 50 refs): 2,550 resolver calls → 0, 50 queries
→ 1, 3,206 DOM mutation records → 4 — `docs/progress/ref-label-flash.md` › Measurements.

**Verified independently 2026-09-13** (adversarial pass, same branch). Cause re-proved without the
author's trace: the `52e5d20` client with only the `invalidateBlockRefs()` call removed from
`data/store.ts` shows no placeholder in any snapshot (pulls 0 of 10, typing 0 of 9) but never
updates a label whose target changed — so emptying the cache was the flash. The four failing tests
above fail on `52e5d20` in Chromium and WebKit (25 of 30 and 4 of 13 snapshots, both engines) and
pass at HEAD. Real-graph copy, `tools/probes/refresh-render-count.mjs` without counter patches: `Ref
Heavy` 53 flashed snapshots / 3,237 records / 1,915 elements per refresh before, 0 / 4 / 3 after
(2022-12-16: 5 / 16 / 29.6 → 0 / 4 / 8.6), after identical in WebKit. The other side of
stale-while-revalidate — a kept label must still move when its target really changes — now has
tests in `e2e/tests/ref-label-flash.spec.ts`: "typing fast into a referenced block on the same
page: the label follows forward only" and "a second device typing into a referenced block: the
first device's label converges, never ((id))" (both fail on `52e5d20`), "a deleted target shows
((id)) again, and restoring it resolves the label" and "navigating away and back after the target
changed shows the new text" (guards; the latter fails against a cache that skips re-reading ids
nobody was watching).

---

### B-542 · Under `vite dev` (and vitest), opening the consent badge's popover throws
**Status:** fixed · **Severity:** low (production builds unaffected) · **Found:** 2026-09-13,
quiet-topbar (writing the badge's first component test) · **Test:**
`apps/web/src/live/ConsentBadge.test.tsx` › "opens the agent-access toggles on click, as the pill did"

`ConsentBadge.tsx` defined its own `function Switch(...)` for the two toggles. In development mode
vite-plugin-solid wraps components in the HMR registry (`var Switch = _$$component(_REGISTRY, …)`),
and babel-preset-solid's built-ins handling then compiled `<Switch>` to an import of solid-js's
own `Switch` — `TypeError: Cannot read properties of undefined (reading 'when')` the moment the
popover rendered. Evidence: `vite`'s `transformRequest` for the file in development mode imports
`Switch as _$Switch` from `solid-js/web` and calls it; in production mode it calls the local
`Switch`. So the dev server and every component test were broken; the served production build
(and so e2e) was not. Fixed by renaming the local component to `ToggleSwitch`.

---

### B-540 · Syncing is visible: every ordinary push and pull shows on screen
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, owner report · **Test:** none yet

"The syncing being so visible is a bug on its own, it should be very silent, one shouldn't basically
even know unless it's necessary." Seen: references flashing to `((id))` (B-500), focus lost in the
desktop app (B-42), rows re-rendering, the sync indicator changing on every routine cycle. A refresh
that changes nothing on screen must change nothing visible; the indicator should appear only when
something needs attention (offline, pending for seconds, an error). Being handled with B-500 on
`m11/ref-label-flash`.


**Owner:** keep this proportionate — see B-500's note. The follow-up is limited to making the sync indicator quiet during routine push/pull (shown only when offline, on error, or pending for several seconds); no rendering overhaul.

**Fixed 2026-09-13.** Scoped as the owner asked: the indicator, nothing broader. The owner, on the
top bar: "'Agent access to this window' could be probably hidden under some icon? Same with sync —
I want it to be very silent. Logseq has an icon of a cloud with a yellow small dot … that goes
green when synced again … Also in muted colours."

- **Sync indicator** (`apps/web/src/shell/SyncIndicator.tsx`, rule in `sync-indicator-state.ts`,
  styles in `sync-indicator.css`): a muted cloud `.app-icon-button` with a 7px dot in its
  bottom-right corner — green synced, yellow pending, red-grey offline, red error, a hollow ring
  for "not saved locally" (B-43, amber) and "synced via another tab" (B-81, green), no dot before
  the worker answers. The words moved to `title` and `aria-label` ("Synced", "3 changes waiting to
  sync", "Offline — changes are kept and sent when back online", …). The dot (`data-state`) only
  moves to pending/offline/error once that state has lasted 2 s (`ATTENTION_DELAY_MS`); recovering
  shows at once. The label is the true state at every moment, so e2e tests that waited for
  `toHaveText("synced")` as "nothing left to push" now wait for `aria-label="Synced"`. It also now
  shows the sync client's `error` state, which the text version silently rendered as "synced" or
  "syncing". Click still opens Diagnostics; the button never changes size.
- **Consent badge** (`apps/web/src/live/ConsentBadge.tsx`, `live.css`): the pill became a muted
  robot icon button with the same corner dot — none when off, a muted green dot when observed; when
  agents can *control* the window the icon, dot and a tinted ground are drawn in the agent accent
  so that state stays noticeable. The sentence is the tooltip and accessible name; click still opens
  the toggles and activity log. ADR 015 §6 records the change.
- One new token, `--dot-pending` in `styles/shell.css`: `--warn` is a text colour and read brown at
  dot size in the light theme.

Measured in Chromium against the production build (port 6422), in the e2e test below run with the
delay temporarily set to 0: counting from when recording started (just before typing), the label
went to "1 change waiting to sync" at 401 ms and back to "Synced" at 711 ms. A routine push is
pending about 300 ms, well under the 2 s delay. With the delay at 0 that test fails, recording
`data-state="pending"` for that window; with 2 s it passes.

Tests: `apps/web/src/shell/sync-indicator-state.test.ts` (10: derive, labels, and the delay state
machine with fake timers — "a push that lands inside the delay shows nothing at all" and 6 more);
`apps/web/src/live/ConsentBadge.test.tsx` (2: accessible name/tooltip per state with no visible
text; click opens the toggles); `e2e/tests/sync-indicator.spec.ts` › "a routine edit's push and
pull never change what the sync indicator shows" (records every `data-state`/`aria-label` value
with a MutationObserver; asserts the edit was pending, and the dot never left "synced") and ›
"offline shows the offline state, and reconnecting clears it" (`context.setOffline`). Updated to
the new attributes: `storage.spec.ts`, `views.spec.ts` (follower), `read-only.spec.ts`,
`palette-text-keys.spec.ts`, `connectivity.spec.ts` ("sync reaches a connected state" read the
page's text for "offline", which an icon no longer has). Screenshots (light, dark, 390 px, a state
gallery, real offline) were checked by eye and are not in the repo.

`storage.spec.ts` also passes in the `webkit` project (2/2), which covers the `memory` state.
Not verified: the desktop app (WKWebView), and how the bar looks next to `m11/desktop-shell`'s
top-bar inset.

---

### B-243 · On a fresh client, text typed into today's journal draft vanishes when sync says today exists
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, exploratory QA (Q4) · **Tests:**
`e2e/tests/journal-draft-sync.spec.ts` "text typed into today's draft survives the first sync
saying today already exists (B-243)"; `apps/web/src/views/VirtualJournalDay.test.tsx` "torn down
with text nobody committed (B-243)" (4 tests)

The server already has today's journal with blocks. A fresh browser (empty OPFS) opens
`/journals`, the local replica does not have today yet, so the virtual draft shows; click it and
type. When the initial pull lands, the draft is replaced by the real outliner and what was typed is
in neither the UI nor the server. Focus falls to `<body>`; the sync indicator says "synced".

**Fixed 2026-09-13.** The stream picks draft or outliner from the local replica, and the draft
committed only on blur or Enter. When the snapshot flipped today to "exists", `<Show>` disposed
the draft with its text uncommitted, and nothing else looked at it. `VirtualJournalDay`'s cleanup
now keeps a non-empty uncommitted draft: it appends it as the last top-level block of the day's
page the replica now has (`data/journal-day.ts#appendToJournalDay`, an ordinary `block.create`
through `applyOps`) and, if the draft held the caret, requests focus there so typing continues at
its end. With no page for the day (unmounted for another reason) it commits the normal way. The
blur that removing a focused textarea can fire is ignored after disposal, so there is one writer.
The e2e test holds `/sync/snapshot` with `page.route` (the route reaches the sync worker's fetch)
to open the same window the 952-page graph opens by being big; it failed before (text not stored)
and passes after, 3/3 with `--repeat-each=3`.

Not covered, and not verified either way: (a) the draft committed (blur/Enter) *before* the
snapshot lands, which creates a second page for a day the server already has; core rejects a
`page.create` whose key is taken, so the typed blocks likely fail on push. (b) QA's `t7.mjs` saw
text typed immediately after Enter on a just-materialised day lost (second block stayed empty);
`a-fresh-journal.spec.ts` covers Enter-then-type but waits for focus first.

**Fixed 2026-09-13** (superseded): the window B-243 patched no longer opens. Since B-410, today
shows a non-interactive loading row until the stream has answered, so a fresh client has no draft to
type into during its first sync. Its e2e test is rewritten to that contract:
`e2e/tests/journal-draft-sync.spec.ts` "today offers no draft until the first sync says whether
today exists, and nothing typed after it is lost (B-243, B-410)". It fails on `70c9bb9`, where the
draft is visible while the snapshot is held. The append-on-teardown path stays for a draft swapped
out because another device wrote the day, and its unit tests still pass.

---

### B-107 · Enter on a calendar-opened journal day drops the caret
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, `e2e/tests/templates.spec.ts`
"a day started in the app begins with the journal template, the typed text after it" (the first
test to type into a pinned day) · **Tests:** that e2e case, and
`apps/web/src/views/VirtualJournalDay.test.tsx` "hands its focus request back if it is torn down
while the caret is inside it"

Open a day from the calendar (a virtual, not-yet-existing day), type into its placeholder, press
Enter: the blocks are created but there is no editor anywhere — the same failure B-06/B-16's
era had for today, on a different path. `VirtualJournalDay` asks for the caret in the new
sibling and optimistically mounts its own `BlockTree`; that tree's single `getPageTree` resolves
before `usePinnedJournalDay`'s two-step fetch, claims the request and attaches the editor — then
the pinned resource resolves, `JournalStreamView` swaps in its own `BlockTree` for the now-real
page, and the component holding the editor is unmounted. Today's day never showed it because
`useJournalStream` resolves first, so the stream's tree is the one that claims the request.

Measured with a MutationObserver/focus probe on the pinned flow: the optimistic tree's editor
appears and takes focus at 43 ms, the teardown's `surface.detach()` blurs it at 43.9 ms, the
successor outliner appears at 44.6 ms, and no editor exists afterwards. On today the successor
appears at 132 ms and attaches its editor at 136 ms.

**Fixed 2026-09-12** (templates agent, in `VirtualJournalDay.tsx`): when the component is torn
down after its focus request was consumed, it re-issues the request for the block it had asked
for, and the successor tree for the same page claims it. No heuristic about where the caret was:
the teardown's blur is indistinguishable from a click on the page background, and nobody clicks
away inside the swap's window. The race itself (two trees for one page during the swap) is the
stream's to remove; the hand-back makes it harmless.

**Fixed 2026-09-13** (again, by removal): the race it patched, two trees for one journal page
during the draft-to-outline swap, no longer exists. Since B-411 the day's section keeps the draft
and its single tree (`views/JournalDayOutline.tsx`), so the hand-back in `VirtualJournalDay`'s
cleanup is gone along with its two unit tests. They are replaced by
`apps/web/src/views/VirtualJournalDay.test.tsx` "leaves the caret request alone when torn down
after starting the day" and `JournalDayOutline.test.tsx` "keeps the draft, and the tree it
started, when the stream then reports the day's page (B-411)". The e2e case B-107 names,
`templates.spec.ts` "a day started in the app begins with the journal template, the typed text
after it", passes.

---

### B-411 · On a day started from its draft, text typed in the moments after Enter comes out garbled ("second line" stored as "ecoe")
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, M10 regression pass (Q2) on a copy
of the real graph · **Tests:** `e2e/tests/journal-day-start.spec.ts` "text typed 0 ms after Enter
on a calendar-opened day's draft lands intact (B-411)", "typing straight on after Enter while the
replica is busy keeps every key (B-411)", "a day started while the replica is busy from the first
key keeps every line (B-411)" (and the 300 ms variant, which passes on the base too — the small e2e
graph closes that window in time); `apps/web/src/views/VirtualJournalDay.test.tsx` "once focus has
prepared it, Enter writes the day and shows its tree in the same task (B-411)" and "keeps taking
lines while the replica has not answered, and writes them all at once (B-411)";
`apps/web/src/views/JournalDayOutline.test.tsx` "keeps the draft, and the tree it started, when the
stream then reports the day's page (B-411)"

Open a day from the calendar that has no page, type `first line` in its draft, Enter, wait 300 ms,
type `second line`, Enter, `third line` (30 ms per key). QA stored `['first line','ecoe','third
line']` three times out of three; other days and pauses gave `ecne`, `nd hird line` (an Enter lost
as well), or `e`. On today's draft, `TODO call back [[QA10 Al` typed right after Enter was lost.

Measured on the base with a timeline probe (scratch `q2-probe.mjs 25 300 30`, real-graph copy): Enter
at 346 ms removed the draft and mounted the draft's own `BlockTree`, whose editor attached only when
its fetch answered, at 646 ms. Keys in those 300 ms went to `<body>`. At 734 ms the pinned section's
resource saw the page and swapped in a second tree for it (B-107's race), and keys went nowhere again
until B-107's hand-back re-attached an editor at 902 ms: `secine`. Two gaps, then:

1. **Enter to the first editor.** The draft awaited the journal template and an HLC pool (two worker
   round trips), then the write, then the new tree's fetch, before any editor existed.
2. **The swap.** The section rendered the draft only while its entry had no page, so the draft's
   own tree was replaced as soon as the write showed up in the stream.

**Fixed 2026-09-13.**
- `views/JournalDayOutline.tsx` (new) holds a day's slot in the Today and jumped-to sections, keyed
  by day. Once the draft has started the day (`onStarted`), it stays and renders the day's only tree.
- `VirtualJournalDay` fetches the template and HLC pool when the draft gains focus (`prepare`). Enter
  then writes the page, the template and the typed rows, and shows the tree, in one synchronous step.
- The tree is drawn from that batch before its fetch answers (`BlockTree`'s new `initialOps`), so
  the focus request is claimed on mount and the next key already has an editor. Measured after the
  fix, same probe on day 27: Enter at 357 ms, editor focused at 361 ms, stored `first line`,
  `second line`, `third line`.
- If the pool is not ready at Enter (the replica is busy), the textarea stays and keeps the keys:
  Enter closes a line, shown above it. When the worker answers, every line is written and the caret
  goes to the end of the last one.
- The pool is minted before anything the tree writes, so the day's `block.create`s carry the older
  HLCs. A `block.text` older than its `block.create` would lose last-writer-wins.
- B-107's focus hand-back is gone: there is no second tree to hand the caret to.

Re-run on the real-graph copy with this branch's build: QA's `s5.mjs` on days 22 (300 ms), 26
(200 ms), 21 (0 ms), 24 (400 ms) and 20 (250 ms, no key delay) all stored the three lines. QA's `s6.mjs
400 40` on a fresh copy stored both lines, and they were still there after a reload.
QA's `s2-journal.mjs` on a fresh copy stored every line too, but only 2-3 s later. See B-416.

Not covered: a draft committed for a day the replica does not yet know exists (another device wrote
it first) still makes a colliding `page.create` (B-415). The pool's HLCs are minted at focus. A
draft left focused for a long time writes the day with HLCs from then, which is harmless for new
entities but untested.

---

### B-410 · Typing into a journal day that exists but has no blocks loses the text (the draft's `page.create` is rejected), and an empty page has nowhere to type
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, M10 regression pass (Q1) on a copy
of the real graph · **Tests:** `e2e/tests/journal-draft-sync.spec.ts` "today offers no draft until
the first sync says whether today exists, and nothing typed after it is lost (B-243, B-410)";
`e2e/tests/journal-day-start.spec.ts` "a journal day whose blocks were all deleted still has
somewhere to type (B-410)" and "a page an agent created empty has somewhere to type (B-410)";
`apps/web/src/views/JournalStreamView.test.tsx` "offers no draft for today while the stream has not
answered, then the day it answers with (B-410)"

QA gave today's journal blocks, deleted all of them through the API (the page stays, block_count
0), opened `/journals` in a fresh browser, clicked today's draft and typed `first line`, Enter,
`second line`. Nothing was stored: the op log had `page.create 2026-09-13` plus the two
`block.create`s, twice, all `rejected`, and no error anywhere. A variant typing slower stored one
block, `first today lisecond today line`.

Reproduced on this branch's base with a probe (scratch `q1-probe.mjs`, real-graph copy on port 6481)
that logs the sync requests: the draft rendered at 56 ms, the keys went in at 120 ms, the snapshot
request only started at 146 ms, and the push answered `page-key-collision` for the `page.create` and
`no-such-page` for both blocks. Two different defects were behind the report:

1. **Not the zero blocks — the fresh client.** Every call into the replica worker waits for the
   first sync (by reading: `db.worker.ts#requireDb` resolves only after `WorkerDb.start()`, which
   awaits the snapshot), so on a fresh client the journal stream's resource stays unresolved for
   the whole first sync, ~2 s on the real graph. `JournalStreamView` rendered the draft whenever
   `todayEntry()?.page` was falsy, and an unresolved stream is falsy too. A draft committed then
   (Enter or blur) created a page for a day the server already had, and nothing said so when the
   server refused it. The same draft with no commit was B-243's report. Any existing day did this,
   with or without blocks. QA saw it on an emptied day because that is the day they had just made.
   When the probe gave the client 8 s to sync first, the same day rendered an outline, not the
   draft.
2. **The zero blocks.** Once the replica had the emptied page, the stream rendered its `BlockTree`,
   which has no rows and nothing to click, so there was nowhere to type at all (`rows: []` in the
   probe). The same applies to any page with no blocks: an agent's `page.create` without markdown,
   or a page whose blocks were all deleted in the UI. B-75 fixed only pages created from the UI, by
   creating a first block along with the page.

**Fixed 2026-09-13.** (1) The today section renders a non-interactive `JournalDayLoading` row
(`.vr-draft-loading`) until the stream has answered; the draft appears only for a day the stream
says has no page. A calendar-pinned day already waited, since its section is not rendered until its
resource answers. (2) `BlockTree` renders a "Start typing…" row (`.vr-empty-start`) for an editable
page whose fetch answered with no blocks, when not zoomed or filtered. Clicking it creates an empty
first block through the tree's own commit path (optimistic and undoable) and puts the caret in it.
The e2e tests: the fresh-client one holds `/sync/snapshot` with `page.route` and fails on the base
(the draft is visible); the two empty-page tests fail on the base (no `.vr-empty-start`).

Not covered: a draft committed for a day that another device creates at the same moment, before
this replica has pulled it. Core rejects the second `page.create` by design (sql-schema rule 24,
"two devices created the same page name offline"), and the blocks typed under it go with it. For
journal days that is a sync-design question (e.g. deterministic journal page ids), not a UI fix.
See B-415.

---

### B-474 · One keystroke in a block whose text has a `foo:: bar` line deletes that line (or duplicates it as a property)
**Status:** fixed · **Severity:** high (silent data loss) · **Found:** 2026-09-13,
mirror-escape-verify (adversarial check of B-342's fix, in Chromium) · **Test:**
`e2e/tests/text-property-line-keystroke.spec.ts` (4), `apps/web/src/editor/editText.test.ts` ›
"returns the same block for its own editing text, even with a key:: value line in its TEXT (B-474)"

Seed `- notes` / `  foo\:: bar` / `  more` through `page.create` (OUT-23a: the text `foo:: bar`),
open the page, click into the block and type one character:
- at the end of `notes` or of `more`: the block is saved as `notes!` / `more` — the `foo:: bar` line
  is gone, and no `foo` property was written either;
- at the end of the `foo:: bar` line: a property `foo = bar!` is written and the text line
  `foo:: bar` stays, so page_read shows both.

6 of 6 runs, with and without another write refetching the page first. B-472 predicted a clean
promotion to a property; in the app it is not even that. Reachable because of B-342's fix: an agent
is now told to write such text as `foo\:: bar`, and copy then paste keeps it text. The owner's graph
has 0 blocks with such a line today (`splitBlockText` over all 18,633 blocks of the copy).

What happens: attaching the editor re-runs the page-tree effect in `BlockTree.tsx`, which lays the
live buffer over the block with `withEditText(block, buffer)` so a refetch cannot clobber typing.
The buffer is still exactly the block's editing text, but `withEditText` splits it anyway, so the
editor's tree holds content `notes\nmore` and a property `foo = bar` the database does not have.
The first keystroke snapshots that tree as `before`, and the diff at flush then sees the line as an
unchanged property: it writes only the content without it (or only the property).

A second face, found testing the fix: Cmd/Ctrl+Z of such an edit restored the text line, then
rewrote the buffer to it; that rewrite reaches `onTextChange` like typing, and diffing the unchanged
buffer against the restored block wrote the line as a property again half a second later — and that
new step emptied the redo stack.

**Fixed 2026-09-13** (mirror-escape-verify), in the web editor, not the grammar: `withEditText`
(`apps/web/src/editor/editText.ts`) returns the block itself when the text is exactly the block's
editing text (`editTextOf`), and `flushPendingEdit` (`BlockTree.tsx`) writes nothing for a buffer
that is exactly `before`'s editing text. What such a line becomes on a real edit is unchanged — a
property, B-472's open question — but it is no longer lost or doubled, and undo holds. Tests: the
e2e spec's three keystroke cases (line 1, last line, the `foo::` line itself: the key survives
exactly once, with the typed value) were red before (lost, lost, `["bar","bar!"]`); its undo/redo
case was red with only the `withEditText` half in place (the line came back as a property); all 4
green. The unit test is red without the `withEditText` change.

---

### B-342 · A typed `scheduled::` line is stored as text, but the markdown mirror presents it as a real date
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, exploratory
QA of M8 editor features (Q3, `scratchpad/m9/qa-m8-editor/typedkey.mjs`, `dates2.mjs`) · **Test:**
none yet; probe `tools/probes/serialize-property-shaped-content.ts`

`- TODO call mom`: Mod+End, Shift+Enter, type `scheduled:: 2026-09-20`, click another row. The block
is stored with content `call mom\nscheduled:: 2026-09-20` and no scheduled date: no chip, not on the
agenda. But `page.read` text and `graph/pages/<name>.md` show `- TODO call mom` / `  scheduled::
2026-09-20`, which is exactly how a real date is written — and re-importing that text produces a real
`scheduled` date. The database, the row and the mirror disagree, and the "lossless" mirror is not.
A block that also has a real date gets both lines.

What the probe shows (2026-09-13, `pnpm exec tsx tools/probes/serialize-property-shaped-content.ts`):
this is not specific to dates. Every content line shaped like a property or a Logseq timestamp is
written verbatim and read back by shape — `scheduled:: …`, `deadline:: …`, `SCHEDULED: <…>`,
`foo:: bar`, `marker:: DONE` all came back as properties, content `call mom`, `lossless=false`.
Since B-101 a typed generic `foo:: bar` line becomes a real property, so the editor no longer
produces that one; the reserved keys (`scheduled deadline repeat done marker priority collapsed id`),
`heading::` and `SCHEDULED:`/`DEADLINE:` lines still stay text by design (OUT-22a, B-101), and older
content or an API write can hold any of them.

Why not fixed here: both ways out change a documented contract, and they are the owner's call.
1. The editor makes a typed reserved line real when the edit ends and its value is valid (ADR 011
   form): the row, agenda and mirror then agree with what the text says. Costs: OUT-22a's reason for
   keeping them text (half-typed dates) moves to "only on blur / only when valid"; a typed date line
   vanishes from the buffer into a chip; deleting that line afterwards must not be read as "remove
   the date" (the buffer never shows reserved keys). Does nothing for older content or
   `SCHEDULED:` lines.
2. The serializer escapes a content line that would re-read as a property or timestamp (an OUT-13
   style `\` rule, e.g. `scheduled\:: 2026-09-20`) and the parser un-escapes it. Makes the mirror
   lossless for every shape at once; the typed line stays plain text everywhere. Costs: a grammar
   addition in `core/outline.ts` (parse and serialize) that every reader of the mirror, `block.update`
   `old_str` matching, and a Logseq round trip would see.

**Fixed 2026-09-13** (owner chose option 2, the serializer escape; branch `m11/mirror-escape`).
`packages/core/src/outline.ts`: a content line outside a fence that the parser would take out of
the text by its shape — a property line, a `SCHEDULED:`/`DEADLINE: <…>` line, a `:LOGBOOK:`
opener — is written with a backslash before the colon that makes the shape
(`scheduled\:: 2026-09-20`, `SCHEDULED\: <…>`, `\:LOGBOOK:`), and read back with one backslash
fewer. The shapes are matched with any run of backslashes at that point, so the escape escapes
itself and every string round-trips; a line with no backslash there reads exactly as before, so
Logseq files keep their meaning. Line 1 is escaped whatever the block's head or id, so `page_read`
(ids) and `block.update`'s `before` (no ids) spell a line the same way. Spec: new
`docs/spec/markdown-grammar.md` OUT-23a (+ OUT-23 rule 6), corpus case 49; `docs/spec/mcp-tools.md`
§3.2 rule 5 and `block_update`'s description (code and spec) name the escape.

`:LOGBOOK:` is included although B-342 did not name it: found while measuring, same class and
worse — a content line `:LOGBOOK:` took every line after it up to `:END:` out of the text.

Tests (each run against the base `outline.ts` swapped back in, red there, green after):
- `packages/core/src/outline.test.ts` › "content lines shaped like a property, a timestamp or a
  drawer (B-342, OUT-23a)" (6: 5 red on base; "still reads an unescaped line as a property, a date
  or a drawer (Logseq files)" is a guard, green on both), and 4 new contents in "serialize -> parse
  is lossless across heads, ids, properties and content shapes" (both matrix tests red on base).
- `packages/core/src/corpus.test.ts` › corpus case `49-escaped-shaped-content` (2).
- `packages/server/src/ops/shaped-content-lines.http.test.ts` (4): `page_read` shows the typed line
  escaped, and an old_str edit of ANOTHER word keeps it text — on base that edit silently gave the
  task a real scheduled date; old_str copied from `page_read` edits the line, and dropping the
  backslash makes it a real property; escaped markdown writes text next to a real property;
  content copied from `page_read` round-trips. `verifyRebuildParity` clean in each.
- `packages/server/src/importer/logseq.test.ts` › "still imports Logseq's property, SCHEDULED and
  LOGBOOK lines as such (OUT-23a)" (red on base only for its escaped-line half).
- `e2e/tests/shaped-line-clipboard.spec.ts` — the entry's own steps (Shift+Enter, type
  `scheduled:: 2026-09-20`, click away), then copy the row and paste it. Base: the clipboard held
  `scheduled:: 2026-09-20` and the pasted block came back as content `call mom` with a real
  `scheduled` date. Fixed: copies as `scheduled\:: 2026-09-20`, pastes as text.
- Probe `tools/probes/serialize-property-shaped-content.ts`, extended to 36 cases (the 5 original
  shapes plus `DEADLINE:` with time and repeater, `collapsed::`, `id::`, `heading::`, `:LOGBOOK:`,
  already-escaped lines; after line 1 of a task, and as line 1 with and without an id): 27
  lossless=false on base, 0 after.

Real data (a `.backup` copy of the owner's graph, 953 pages, 18,630 blocks):
`tools/probes/mirror-roundtrip-graph.ts` read 2 pages / 20 blocks back differently before (the
literal `SCHEDULED: <…>` lines the pre-B-266 import left as text, each read back as a real date)
and 0 after. `nooklet export` with the fix vs the base code: 2 of 953 files change
(`journals/2022_12_16.md`, `journals/2023_02_17.md`), 20 lines, each `SCHEDULED: <…>` →
`SCHEDULED\: <…>`. `pnpm nooklet verify`: OK, 20,446 ops. The owner's Logseq file graph and DB
mirror contain 0 lines with a backslash at an escape point (grep), so importing them is unchanged.

Costs, as the entry predicted: agents see `scheduled\:: …` in `page_read` and must keep the
backslash to keep a line text; a copied block pasted into another app shows the backslash (a
CommonMark viewer renders `\:` as `:`). Not verified: how Logseq itself reads `key\:: value` (no
Logseq here). Found while fixing: B-470, B-471, B-472 below.

---

### B-452 · Cmd/Ctrl+Z on a focused `<select>` outside the outliner takes back the outliner's last step

**Status:** fixed 2026-09-13 (verifier of m11/keys-in-fields) · **Severity:** medium (a block
deletion is silently undone on the server behind a modal) · **Found:** 2026-09-13, adversarial
verification of B-300's fix (`tools/probes/keys-in-fields-verify.spec.ts`, case C) · **Test:**
`e2e/tests/keys-in-fields.spec.ts` › "Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z on a focused select do not
take back a block deletion behind Settings (B-452)"; `apps/web/src/app/text-field-keys.test.ts` ›
"the default keymap, typed into a field outside the outliner (B-300)" › "…from a select or a
checkbox too (B-452)"

Select a block, Backspace (deleted on the server), open Settings (Cmd/Ctrl+,), focus the "Journal
template" `<select>`, press Cmd+Z: the deleted block came back — stored `["kv one","kv two","kv
three"]` again, focus still on the select. Pre-existing (the same at `52e5d20`), and exactly the
class B-300 closes: "a key typed into a field outside the outliner never acts on its blocks" held
for every key but these two. Cause: `edit.undo`/`edit.redo` are `when: true`, so R12b's hidden
outliner does not stop them; R12a (`textFieldOwnsKey`) leaves Mod+Z to the field only for TEXT
fields (`isOtherTextField`: text-type inputs, textarea, contenteditable); and
`editor-host.ts#historyEditorHost` declines only for an `<input>`/`<textarea>` and only when no tree
is active — a `<select>` is neither, and a standing selection makes a tree active anyway (so a
focused checkbox or date input outside the outliner should do it too while a block is selected — by
reading the code, not run: no such control sits beside a page's outliner to try it with).

Fix: R12a's target test is `isOtherTextField || isFieldOutsideOutliner` — a text-editing key from
any field outside the outliner is left to that field. For every key but Mod+Z / Mod+Shift+Z this
changes nothing (R12b already resolved them against a context no binding of those keys matches;
the unit test enumerates it). Not done in `historyEditorHost` instead: the palette runs its "Undo"
row while its own input still has focus, so a focus test there would break that row whenever a
tree is active.

---

### B-300 · With a block selection standing, Backspace in the page title deletes the selected block

**Status:** fixed · **Severity:** medium (a destructive key goes to blocks the user is not looking
at; undo restores them) · **Found:** 2026-09-13, clipboard-sync, while checking where the new
Cmd+X can fire · **Test:** — (probe: see below)

Select a block (Escape), click into the page title, press End, Shift+Home, Backspace. Expected: the
title's text is selected and deleted. Seen: the title is unchanged and the selected BLOCK is
deleted — on the server too. The same with Cmd+X since B-245 (the block is cut). The selection
survives the click (still 1 `.vr-row-selected`, `document.activeElement` is the title input), and
the global keydown dispatcher (`app/CommandLayer.tsx#KeyboardDispatch`, capture phase, no check of
the event target) matches `block.deleteSelected` on `blockSelected` before the input sees the key.
Measured with a throwaway Playwright spec on `m9/clipboard-sync` (Backspace: stored `["two"]`,
title unchanged; Meta+x: the same). Only a pointerdown while EDITING ends the session
(`BlockTree.tsx`'s capture-phase listener); a standing selection has no equivalent.

Not fixed on this branch — every candidate touches how the whole command system decides what a
key means, and each has a cost that needs a decision:

- End a standing selection on a pointerdown outside the outliner (as editing already ends): covers
  the click into the title, not keyboard focus moving there (Tab), and a dialog opened FROM the
  selection (Move to page…) must keep it.
- Report `blockSelected: false` while a text input outside the outliner has focus: also hides the
  selection commands from the palette, whose own input has focus when it asks.
- Have `KeyboardDispatch` leave keys alone whose target is an `input`/`textarea`/contenteditable
  outside the outliner: the most general, in `app/CommandLayer.tsx`, and needs checking against
  every command that is meant to work from such a field.

**Also the command palette, measured 2026-09-13 (verify pass).** The same dispatch reaches the
palette's own input, which is where this bites hardest: Escape out of an edit (a selection now
stands), Cmd+K, type `abc`, Backspace — the palette still reads `abc` and the selected block is
DELETED on the server (throwaway spec, stored `["two","three"]` from `one/two/three`). Cmd+A there
runs `block.selectAll` on the page behind the palette, and Cmd+X then cuts every block of the page
(stored `[]`, clipboard `- one\n- two\n`). Backspace predates this branch; Cmd+X's part is new with
B-245. Suggest raising B-300 to high: the palette is opened from a selection all the time. Not
seen: a selection standing in one journal day does not capture Cmd+X in a block being edited in
another day — the editing tree's context wins and the text is cut natively (checked the same way).

**Severity: raise to high** (the entry's own suggestion): the palette is opened from a selection
all the time, and keys typed there wrote to blocks on the server.

**Measured again at `52e5d20` before changing anything** (`tools/probes/keys-in-fields-selection.spec.ts`,
header has every line). B-347's key list (`app/text-field-keys.ts#textFieldOwnsKey`, spec R12a),
merged after B-300 was measured on `m9/clipboard-sync`, had already fixed the reported half:
Backspace and Cmd+X in the title, and Backspace/Cmd+A/Cmd+X in the palette, edited the field and
left the blocks alone. Every key NOT on that list still ran against the outliner's context:

- title Enter with a block selected: `block.editSelected` — the block opened for editing (the
  rename still landed only because the title lost focus to the editor);
- title or palette Cmd+Shift+D: `block.duplicate` — stored `["pk one","pk one","pk two","pk three"]`;
- title or palette Cmd+.: `block.zoomIn` into the selected block;
- title Escape: `block.clearSelection`;
- palette over an open edit, Cmd+Shift+K: `format.insertLink` — stored `"pk one[]()"` in the block
  behind the palette.

**Fixed 2026-09-13**, owner-approved option (c), as: a keydown whose target is an `<input>` (any
type), `<textarea>`, `<select>` or contenteditable outside `.vr-outliner`/`.cm-editor` is dispatched
with the outliner hidden — `text-field-keys.ts#isFieldOutsideOutliner` picks the target,
`editor-host.ts#withoutOutliner` gives the dispatcher a context with nothing edited and nothing
selected (the editor snapshot's `NOTHING_FOCUSED`, `popupOpen` kept), `CommandLayer#KeyboardDispatch`
uses it. So no `editorFocused`/`blockSelected` binding can fire from such a field, and the global
`when: true` shortcuts and `pageView`'s Cmd+F still do. Not "report `blockSelected: false` while a
field has focus" in general: the palette evaluates its rows against the full context, so it still
lists and runs "Delete selected blocks", "Duplicate block" etc. Spec: new R12b in
`docs/spec/commands-and-keymap.md` (R12a unchanged, now points to it).

Tests:
- `e2e/tests/keys-in-fields.spec.ts` (7, plus B-452's 8th). Five fail with the one dispatch line disabled (checked
  by editing it to `false &&`, rebuilding, running, restoring): "Backspace and Cmd/Ctrl+X in the
  page title edit the title, and Enter renames the page, with a block selected" (the editor opens),
  "Cmd/Ctrl+Shift+D and Cmd/Ctrl+. in the page title leave the selected block alone" (block
  duplicated), "Backspace, Cmd/Ctrl+A then Cmd/Ctrl+X in the palette edit the query, not the selected
  block" (fails at its Cmd+Shift+D part; its Backspace/Cmd+A/Cmd+X part passed on the old code —
  B-347), "a shortcut typed into the palette over an open edit does not write into the block behind
  it" (the stored first block is not `kf one!`), "with no field focused, a standing selection still answers
  Backspace and Cmd/Ctrl+X, also after the palette or the page title had focus" (fails at the title
  part; its no-field Backspace and after-palette Cmd+X parts are guards). Guards that pass either
  way: "over a block selection, the keys meant for a field still work there", "the global shortcuts
  still fire from the search box and from a settings field".
- `apps/web/src/app/text-field-keys.test.ts` › "isFieldOutsideOutliner (B-300)" and "the default
  keymap, typed into a field outside the outliner (B-300)": every single-key binding of the real mac
  keymap, dispatched from a field over a context where an edit AND a selection stand, reaches
  exactly `app.openSettings, app.toggleSidebar, nav.back, nav.forward, nav.journals, nav.switchPage,
  nav.todayJournal, palette.open, search.findInPage, search.open` — a new binding that can act on a
  block from a field shows up here.

Commands meant to fire from a field, each checked (e2e runs on port 6411, Chromium, macOS):

| From | Keys | Owner of the key | How checked |
|---|---|---|---|
| Palette query | ArrowUp/ArrowDown/Enter/Shift+Enter | the input's own `onKeyDown` (plus the popup claim) | keys-in-fields › "keys meant for a field" (arrows + Enter run "Duplicate block" over a selection); `views.spec` "the palette runs a command from the keyboard…", "Enter on a highlighted page in the palette opens it"; `commands.spec` "Shift+Enter on a page in the palette shelves it…" — green |
| Palette query | Escape | input + popup claim | `views.spec` "Escape and a backdrop click both close the palette"; `focus-return.spec` (all 8); keys-in-fields › tests 3, 4, 5 — green |
| Palette query | Cmd+K (closes) | `palette.open`, `when: true` — still dispatched | keys-in-fields › "keys meant for a field"; `views.spec` "…Cmd/Ctrl+K toggles"; `focus-return.spec` "Cmd/Ctrl+K pressed again to close the palette…" — green |
| Page title | Cmd+K (opens) | `palette.open` | keys-in-fields › "keys meant for a field" — green |
| Page title | Enter (commit), Backspace, Cmd+A/X | the textarea | keys-in-fields › test 1 (over a selection); `page-rename.spec`, `page-title-draft.spec` — green |
| Find bar | Cmd+F inside it, Enter/Shift+Enter, Escape | Cmd+F: `search.findInPage` (`pageView`, still dispatched); the rest: the input's `onKeyDown` | keys-in-fields › "keys meant for a field" (over a selection); `page-find.spec` (all) — green |
| Date picker | typed line, arrows, Enter, Escape | its own WINDOW-capture listener (nothing focusable; the editor keeps focus, so not a field) | unchanged by construction; `dates.spec`, `date-picker-type-ahead.spec` — green |
| Template picker | filter letters, arrows, Enter, Escape | its own document-capture listener (nothing focusable) | unchanged by construction; `templates.spec`, `template-undo.spec` — green |
| Move to page… / Merge into… picker | typing, arrows, Enter, Escape | the input's `onKeyDown` + popup claim | `refactor.spec` (incl. "Escape moves nothing"), `focus-return.spec` "Move to page…" tests — green |
| Settings | Cmd+K from a focused setting; Cmd+, | `when: true` | keys-in-fields › "global shortcuts … from a settings field"; `settings.spec` — green (2 tests skip themselves: "sqlite-vec did not load on this server", as before) |
| Search box | Cmd+J (and every `when: true` shortcut) | `when: true` | keys-in-fields › "global shortcuts … from the search box"; `views.spec` "Cmd/Ctrl+J, Cmd/Ctrl+Shift+F and Cmd/Ctrl+Shift+J go where they say"; `search-cleared.spec`, `search-filters.spec` — green |
| Journal draft (`.vr-draft-input`) | Enter starts the day | the textarea's `onKeyDown` | `journal-day-start.spec` — green (without a selection standing elsewhere; with one, Enter used to be `block.editSelected` — not e2e-checked) |
| Page properties, page icon, trash rename, capture, page finder | Enter/Escape | each input's own `onKeyDown`; none uses the keymap | read, not run with a selection standing |

Related set run together after the fix (before the 7th keys-in-fields test was added): the specs in
the table plus `selection`, `popups`, `help`, `navigation`, `phone-palette`, `undo-redo`, `redo`,
`context-menu`, `page-icons` — 216 passed, 1 skipped, 0 failed.

Full e2e suite after the fix, in three runs of the 98 spec files (one server each, load average
65–106): 175 passed + 1 skipped (`context-menu` fixme); 197 passed + 1 failed (`parity` "the palette
offers to create a page…", then on a same-order rerun `parity` "right-clicking a bullet opens an app
context menu" instead — `parity.spec.ts` alone: 14/14, twice); 167 passed + 1 skipped (`storage`'s
in-memory test, WebKit-only) + 1 failed (`review-reactivity` trash Retry — B-451, fails identically with
the fix disabled). 543 tests in all.

Behaviour changes to know about:
- Escape typed in a field outside the outliner no longer clears a standing block selection (it did
  from the title; the palette, find bar and pickers already took Escape themselves).
- Cmd+Shift+. (`block.zoomOut`, `when: zoomed`) no longer fires from a field: `zoomed` is part of
  the outliner's snapshot, hidden with the rest.
- A `<select>` and non-text inputs (date, checkbox) outside the outliner count as fields for R12b,
  so arrows on a focused `<select>` no longer extend a block selection. (As first written they did
  not count for R12a, and Mod+Z on a focused `<select>` did undo the outliner's last step — checked
  in a browser by the verifier, B-452, and fixed by counting them for R12a too.)

Still unverified: Windows/Linux bindings (all runs were on macOS with Meta); WebKit (the Mac app) —
the rule is DOM-only (`closest`, `instanceof`, `isContentEditable`) with nothing engine-specific, but
not run there; a plugin command bound to a key with a block-scoped `when` is hidden from fields by
the same rule (by design) — no plugin with a keybinding exists to try it with.

---

### B-384 · Enter on the autocomplete a walk into a complete link opened silently re-points the link
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, adversarial verification of
m10/editor-keys (made silent by the B-294 fix, `86897db`; the wrong pick itself is older) ·
**Test:** `e2e/tests/autocomplete-inside-link.spec.ts` "…keeps the link's page, not a shorter name
(B-384)", "Enter with the caret walked to just after [[ keeps the link, not today's date (B-384)",
"walking into a ((ref)) offers nothing to pick, so Enter leaves the ref alone (B-384)"

B-294 made a pick inside a complete link replace the whole link, but the row Enter takes is still
ranked by the fragment before the caret, so on a walk-in it is often not the link's own page. Seeded
pages `Ekvthree Jan`, `Ekvthree Jan Novak`, `Ekvthree Janitor`; block `- met [[Ekvthree Jan Novak]]
today`; Home, ArrowRight to after `[[Ekvthree Jan` (also after `[[E`, after `[[Ekvthree`), Enter:
stored `met [[Ekvthree Jan]] today` — the link now names another page, and nothing on screen looks
broken. With the caret right after `[[` the query is empty, the date shortcuts come first, and Enter
stores `met [[Sep 13th, 2026]] today`: the page name is gone. Walking into a `((ref))` queries a
fragment of the id, which matches blocks whose TEXT contains the id — the block being edited first —
and Enter stored `see ((<the edited block's own id>))! end`. Before `86897db` each of these left the
old tail behind (`[[Ekvthree Jan]] Novak]]`), visibly wrong and one undo away; now the result looks
like a valid link. Enter with the caret inside a link is a realistic slip (arrowing to split a block
a couple of characters early). Probe: `e2e/tests/zz-ekv2-probe.spec.ts` P2, `zz-ekv3-probe.spec.ts`
P5 (throwaway, not committed).

**Fix:** `AutocompletePopup.tsx#rowKeepingClosedLink` puts first, inside a complete `[[link]]`, the
row that re-links what the link already names: the page with that whole name, ahead of shorter names
and the date shortcuts; with nothing before the caret and no such page, B-382's "New page" row for
the whole name. The block variant lists nothing inside a complete `((ref))`, so Enter does nothing
there (Escape closes it). Not covered: with text before the caret, a link to a page that does not
exist, and another page fuzzy-matching that text (`[[Jan| Novak]]` with only "Janitor"), ranking
still decides — that text may be a search typed to retarget the link (`[[Walkin Oth|Goal Page]]`)
and nothing tells the two apart. All three e2e tests red before (`met [[Walkin Pat]]! today`,
`met [[Sep 13th, 2026]]! today`, `see ((<own id>)) end`), green after. Unit:
`AutocompletePopup.test.tsx` four "(B-384)" tests red before, plus the guard "with a query typed
inside a link to no page, ranking still decides the active row (B-384)" (green before and after).

---

### B-382 · Enter on "New page" inside an existing `[[link]]` deletes the rest of the link's name
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, adversarial verification of
m10/editor-keys (introduced by the B-294 fix, `86897db`) · **Test:**
`e2e/tests/autocomplete-inside-link.spec.ts` "Enter on New page inside a link to a page that does not
exist keeps the whole link (B-382)"

`- alpha [[Walkin Unmade Page]] omega` (no such page — an ordinary state, references are keyed by
name), Home, ArrowRight to after `[[Walkin Unm`: the popup's rows are `New page "Walkin Unm"` and a
block match. Enter stores `alpha [[Walkin Unm]] omega` and creates a page "Walkin Unm". B-294's fix
replaces through the link's `]]`, but the "New page" row still names the page after the text BEFORE
the caret, so "ade Page" is silently gone. Before `86897db` the same Enter gave the visible garble
`[[Walkin Unm]]ade Page]]`. The same path is reached for a link to a page that DOES exist whenever
the "New page" row is active — B-294's own repro saw it once, and it is the only row until the pages
list has loaded (B-244's busy worker). Probe: `e2e/tests/zz-ekv-probe.spec.ts` P1 (throwaway).

**Fixed 2026-09-13.** `AutocompletePopup.tsx#createName`: inside a closed link the "New page" row
names the whole link — the query plus the text from the caret to the `]]` — in its label, in the
`hasExact` check and in what it links and creates. So Enter there leaves `[[Walkin Unmade Page]]` as
it was and creates that page; for a link whose whole name is a loaded page no "New page" row is
offered at all; and in the not-yet-loaded race the create of an existing name is rejected by
`apply-ops.ts#applyPageCreate` (`page-key-collision`), leaving the link untouched. Chosen over
"do not replace through `]]` for this row", which would have brought B-294's garble back for it.
Cost: retyping a link's name from the middle and picking "New page" names the page after everything
the link now says (`[[Walkin OthGoal Page]]`), not after the typed part — what the buffer shows. The
e2e test was red on `67ae509` (`alpha [[Walkin Unm]]! omega`), green after. Unit:
`AutocompletePopup.test.tsx` "New page with the caret inside a complete link names the whole link…"
and "offers no New page inside a complete link whose whole name is an existing page" (both red with
the fix reverted).

---

### B-344 · `/mermaid` at the end of existing text puts the fence inline, and the diagram never renders
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, exploratory QA of M8
editor features (Q5, `scratchpad/m9/qa-m8-editor/misc2.mjs`) · **Test:** none yet

`- after text`, End, ` /mermaid`, Enter, leave the block: the stored content is `after text` followed
on the same line by the starter fence (```` ```mermaid ````, `graph TD`, `A --> B`, closing fence), the
row shows the raw text, and there is no `svg`. The same command on an empty block renders one
diagram.

Why this is not fixed by the obvious one-liner: `plugins/mermaid/src/client.ts` could put the starter
on its own line, but a fence only renders when it is line 1 of a block's content —
`core/tokens.ts#classifyFence` looks at the first line only. Checked with `classifyBlockContent`
(2026-09-13, `tsx -e`): `"after text ```mermaid…"` → `paragraph`, `"after text\n```mermaid…"` →
`paragraph`, `"```mermaid…"` → `fence`. So the diagram can only render if `/mermaid` on a non-empty
block puts the starter into a NEW block after it (or the renderer learns to draw a fence below a
paragraph, which is a grammar change, spec §2.7). The plugin cannot do the first today: it only sees
`editor.insertText`, and the client plugin host throws "not supported" for `editor.currentBlock`,
`editor.insertBlockAfter` and `editor.focusBlock` (ADR 023 list in `api-and-plugin-types.md` §5);
`EditorHost` has no "new block after the current one" operation a host implementation could call.
Needs one of: those three plugin-host methods, a block-level option on `insertText`, or mixed
paragraph+fence rendering. Skipped here as a feature gap.

**Fixed 2026-09-13.** Of the entry's three ways out, the one that needed no new decision: the client
plugin host now implements three `EditorApi` methods the plugin API already specifies (§5) —
`editor.currentBlock()`, `editor.insertBlockAfter()` and `editor.focusBlock()` — and `/mermaid` uses
them: on a block whose content is not blank it inserts the starter as a new next sibling and puts the
caret inside the fence (where B-185 wants it); on an empty block it inserts at the caret as before.
No grammar change (a fence still renders only as a block's first line) and no plugin-API change.
Pieces: `EditorHost.currentBlock()` (new seam method; `BlockTree` builds the core `Block` through
`editor/current-block.ts#toCoreBlock` from the tree block plus the live buffer, so unflushed text
counts), `data/plugin-writes.ts#blockAfterOps` (place from the replica, as `/template` computes it),
committed through `EditorHost.commitOps` so one Cmd/Ctrl+Z takes the diagram back, written with
`applyOps` only when no editor shows the block; `focusBlock` goes through `requestBlockFocus`. Spec
`api-and-plugin-types.md` §5's "what the v1 client host implements" updated. `editor.selection()` and
`editor.replaceBlock()` still throw. **Test:** `e2e/tests/mermaid-after-text.spec.ts` "/mermaid after
existing text puts the diagram in its own block, which renders (B-344)" (stored
`["after text", starter, "next one"]`, caret inside the fence, `svg` drawn) and "undo takes the
inserted diagram block back in one step (B-344)" — both red before (`after text ```mermaid…` in one
block), green after; `plugins.spec.ts` (7) still green. Unit: `plugins/host.test.ts` "/mermaid in a
block with text puts the diagram in a new block after it (B-344)", "/mermaid in an empty block …", and
"editor.insertBlockAfter / focusBlock / currentBlock (B-344)" (4); `editor/current-block.test.ts` (3).
Not covered: `blockAfterOps` reads the block's place from the replica, so `/mermaid` typed into a block
created a moment earlier whose create has not reached the replica rejects with "no block with id"
(the slash command then does nothing) — unmeasured how often; `/template` has the same dependency.

---

### B-295 · Keys typed straight after Alt+Enter follows a link go into the block being left
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, adversarial verification of m9/focus
(pre-existing: `cf08d19` 2 of 2, branch 3 of 3) · **Test:** none yet

Editing `- go [[Target]]`, End, Alt+Enter, type `qq` at once: the stored block on the page left is
`go [[Target]]qq`. `nav.followLink` → `hosts.ts#openPageByRef` resolves the ref with a replica read
before it navigates, and the editor keeps focus through that gap (probe
`tools/probes/focus-return-verify.spec.ts` "B-295"; still `…]]qq` with the branch's fixes in). The
palette form of the same thing
was B-293's; this one is older and not the branch's. A general fix would end editing when a
navigation is requested rather than when the page unmounts — broader than a focus bug, so left for a
decision.

**Fixed 2026-09-13.** The general fix the entry named: a navigation requested from a key or command
ends editing when it is requested, not when the page unmounts. `app/hosts.ts#createNavigationHost`
calls `requestEditingEnd()` (the same signal Cmd/Ctrl+F uses) at the start of `followLink` for page,
tag and block links, `openPage` (palette page rows, Random page) and `openPageByRef` (`nav.openPage`,
agents). Every tree flushes what was typed and detaches the editor, so focus is on `<body>` until the
new page is clicked into — where `cf08d19` left it after the palette form (B-293). Not changed: web
links (they open in another tab and the editor keeps focus), `back`/`forward`/`openJournals`/
`openSearch` (not measured whether keys typed straight after them can land in the block being left)
and `revealBlock` (documented as not changing focus). Where the correct page already showed, nothing
is lost but the caret: keys typed before the new page is clicked into go nowhere. **Test:**
`e2e/tests/follow-link-typing.spec.ts` — "Alt+Enter on a [[link]], then typing at once: nothing lands
in the block being left (B-295)" and the `((block ref))` form; red before (5 of 5 each with
`--repeat-each=5`: `.cm-content` still focused straight after Alt+Enter; one earlier single run of the
`[[link]]` form passed, so the race is timing-dependent), green after (5 of 5 each). Unit:
`app/hosts.test.ts` "nav.followLink ends editing before it leaves the page (B-295)" (4).

---

### B-294 · Enter on the autocomplete that walking into an existing `[[link]]` opened duplicates the link's tail
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, adversarial verification of m9/focus
(pre-existing: same result with `apps/web/src` at `cf08d19`) · **Test:** none yet

`- alpha [[Target]] omega`, Home, ArrowRight ×9 (caret after `[[T`): the `[[` autocomplete opens
over a link that is already complete (B-203's precondition). Enter picks the active row and replaces
only the text between the trigger and the caret, so the rest of the old link stays behind it:
`alpha [[Target]]arget]] omega` (probe `tools/probes/focus-return-verify.spec.ts` "B-294", seen on `cf08d19` and
on the branch; once the active row was the query itself, giving `alpha [[T]]arget]] omega`).
Either the autocomplete should not open inside a complete link (noted, not asked, in
`docs/progress/focus.md` §3) or picking a row should replace up to the link's `]]`.

**Fixed 2026-09-13.** Of the two answers the entry offered, picking a row now replaces up to the
link's `]]`; the autocomplete still opens inside a complete link. Reasons: it is what spec R56
already described (the pick "consumes" a `]]` after the caret), it lets you retarget a link by
typing inside its name and picking another page, and B-203's Alt+Enter-with-the-popup-open path is
unchanged. `commands/autocomplete/trigger.ts#existingRefTailLength` finds the tail — text after the
caret up to and including `]]` (or `))` for `((`), containing no opener, closer or newline — and
`AutocompletePopup.tsx#queryEnd` extends the replaced span through it for page, date, create and
`[[`→block-ref picks. A `[[` typed straight before another link (`[[|[[Other]]`) does not swallow it.
`#tags` are not covered: B-380. **Test:** `e2e/tests/autocomplete-inside-link.spec.ts` — "Enter on
the autocomplete a walk into a complete [[link]] opened keeps one link (B-294)" and "typing inside an
existing link and picking another page replaces the whole link (B-294)" were red before
(`…Target]]!rget]] omega`, `…Other]]Target]] omega`), green after; "a new [[ typed right before an
existing link leaves that link alone (B-294)" guards the boundary (green before and after). Unit:
`AutocompletePopup.test.tsx` "a pick with the caret inside a complete link replaces the whole link
(B-294)" (red with the tail ignored), `trigger.test.ts` "existingRefTailLength" (3).

---

### B-346 · The marker commands (Mark TODO/DOING/DONE/…, Clear marker) act on one block of a multi-selection
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, reading `commands/registrations/task.ts`
while fixing B-345 · **Test:** none yet

Same shape as B-345, inferred from the code and not reproduced in a browser: `setMarker`,
`task.setMarkerDone` and `task.clearMarker` are enabled for `editorFocused || blockSelected` and act
on `targetBlockId(ctx)`, which is `selectedBlockIds[0]`. With three blocks selected, "Mark TODO"
should therefore mark only the first. Not fixed with B-345 because the right answer is less clear
here: marking every selected block is a plausible and useful meaning (Logseq cycles the marker of
every selected block on Cmd+Enter — from memory, not checked), where a date picker opened for several
blocks has no single date to start from. Owner decision: gate on `selectionCount == 1` like
`task.cycle`, or apply to all.

**Fixed 2026-09-13.** Owner decision relayed by the M10 coordinator: act on all selected blocks, as
one undo step. `task.setMarkerTodo/Doing/Waiting/Canceled` write `marker` on every selected block
(or the edited block), `task.setMarkerDone` computes R35's completion per block from its own dates,
and `task.clearMarker` clears every selected block that has a marker — each as ONE write through the
new `Store.setPropsOfBlocks` (`app/hosts.ts`), which commits one op batch anchored on the first block,
so the tree records one history step. `task.clearMarker`'s `when` became `isTask || blockSelected`:
the context snapshot reads `isTask` from the edited block only, so a selection had never been offered
"Clear task marker" at all (spec table and R39 updated). `editor/external-batch.ts` now refuses a
batch that writes a block the tree does not show, since its inverse would read no old value and undo
would write `null` over a real marker. `task.cycle` stays gated on one selected block (spec note 9).
**Test:** `e2e/tests/task-marker-keys.spec.ts` "the marker commands act on every selected block, as
one undo step (B-346)" — red before (only the first of three got TODO), green after; unit:
`commands/registrations/index.test.ts` "the marker commands act on every selected block, in one write
(B-346)" (5 tests), `app/hosts.test.ts` "several blocks' properties go as ONE batch",
`editor/external-batch.test.ts` "refuses a batch that writes a block this tree does not show".
Note: the coordinator's brief said "like Set scheduled date now does (B-345)", but B-345 was fixed the
other way — the date commands are not offered for several blocks — and that is unchanged here.

---

### B-282 · Cmd/Ctrl+Enter pressed twice in quick succession cycles the marker once
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, verifying `m9/undo` (probe P2 in
`tools/probes/undo-verify-edges.spec.ts`) · **Test:** none

Caret in a block with no marker, Cmd/Ctrl+Enter twice with no pause (Playwright `press` twice):
the server ends with `TODO`, not `DOING`, and the history holds two steps (the first Cmd/Ctrl+Z
leaves `TODO`, the second clears it). Same result with `apps/web/src` at `cf08d19`, so not caused
by `m9/undo`. Cause, by reading: `task.cycle` (`commands/registrations/task.ts`) reads the marker
from the replica (`Store.getBlockTaskState`) and the dispatcher does not await a command before
running the next (`keymap/dispatch.ts#runRow`: `void ctx.exec(...)`), so the second press reads
the marker before the first write reached the replica. Human key repeat is usually slower than
that window; unmeasured how slow is safe. Fix direction (not done): read the marker from the
editor tree when a tree shows the block, or serialize store-routed task commands per block.

**Fixed 2026-09-13.** `commands/registrations/task.ts` runs the task commands (`task.cycle`,
`task.toggleDone`, the six marker commands) through one queue (`createSerialRun`), so a second
Cmd/Ctrl+Enter starts only after the first has committed. That is enough, without reading the marker
from the editor tree: the tree's `commit` posts the write to the DB worker (`void applyOps`)
synchronously, before the queued command posts its `getBlockTaskState` query, and the worker's
`applyLocalOps` is synchronous, so the query sees the write. **Test:** `e2e/tests/task-marker-keys.spec.ts`
"Cmd/Ctrl+Enter pressed twice with no pause cycles the marker twice (B-282)" — red before (row stayed
`TODO`), green after, 4 of 4 with `--repeat-each=4`; it also presses twice from DOING (the R35
completion path) and takes four undo steps back. Unit: `commands/registrations/index.test.ts` "two
task.cycle runs started together advance the marker twice" (red with the queue removed) and "a cycle
queued behind one that throws still runs". Still unmeasured: a slower replica (a busy worker) does
not change the order, so it should not matter, but only a normal machine was tried.

---

### B-537 · The update reload is a race the page loses when `/api/session` takes over a second — B-532 is not fixed under a slow start
**Status:** fixed (for every client from this fix on; see below) · **Severity:** high · **Found:**
2026-09-13, desktop-shell verification · **Tests:** `e2e/tests/sw-update.spec.ts` › "a newer worker that
takes the page over before the page registered its own still reloads it (B-537)" (fails before: no
reload in 20 s), `apps/web/src/sw/takeover.test.ts` (4) · **Evidence:** `shots/verify/update-A-baseline/`,
`shots/verify/update-B-branch-slow-session/`, `shots/verify/update-C-fix-slow-session/`

B-532's fix (worker `skipWaiting` + `clientsClaim`) relies on the OLD page's `registerSW`
(workbox-window) seeing the new worker's `updatefound` and reloading on its `activated`. Workbox only
tracks an update whose `updatefound` fires AFTER `wb.register()` has attached its listener — and
`main.tsx` calls `registerServiceWorker()` only after `await initBootstrap()`, a round trip to
`/api/session`. `register()` of an already-registered, unchanged script URL does not itself check
for an update (spec: resolves with the existing registration); the check that finds a new build is
WebKit's navigation soft update, which the request log shows exactly one second after the document
request (`GET / … GET /sw.js dest=-` at +1.02 s, every launch). If the page has not registered by
then, the new worker installs and claims the page unseen — workbox's `activated` never fires, no
reload — and the page runs the previous client for the whole session again.

Reproduced in the devtest2 app with the same probe shape as B-532 (fresh store, graceful quits,
harness reading the loaded `index-*.js` and `performance` navigation type):
- baseline, OLD `adadff1` → NEW this branch, no delay: the first launch after the update reloads
  (`nav: "reload"`) onto NEW within ~1.2 s — B-532's claim holds;
- OLD this branch → NEW this branch with index.html's precache revision bumped, `/api/session`
  delayed 2 s by the logging proxy: the first launch after the update shows **OLD for the whole 30 s
  session** (`nav: "navigate"`, never reloaded) although the new worker was fetched at +1.04 s; the
  next launch shows NEW.

A two-second `/api/session` is not exotic for the desktop app: a server the app has just spawned, or
one busy with a large graph at start, answers its first requests slowly, and a slower Mac spends
part of that second evaluating the bundle.

**Fix.** A six-line classic `<script>` in `apps/web/index.html`'s `<head>` listens for
`controllerchange` and reloads when a worker takes over a page that a worker already controlled.
It runs while the HTML is parsed — long before the soft update a second later — so it sees every
takeover, tracked by workbox or not; the first install's claim (page not controlled yet, already the
newest build) does not reload. `sw/register.ts` passes a no-op `onNeedReload` so workbox does not
restart the navigation the listener began.

Proven in the devtest2 app, same slow-session shape (`/api/session` +2 s, OLD = this fix, NEW = this
fix with index.html's revision bumped): the first launch after the update requests the document again
at +1.09 s, right after the soft update's `GET /sw.js` at +1.03 s, and shows NEW (`nav: "reload"`)
for the session; the following launch is a plain `navigate` (no reload loop), and so is the first
launch on a fresh store.

Not rescued: a page still running a client from BEFORE this fix (every build up to and including
B-532's) decides with its old code, so it can lose the race once more on the launch that installs
this fix — the result of `update-B` again. From then on the listener is in the page.

---

### B-536 · Cmd/Ctrl+V into a block pastes nothing — the command dispatcher swallows the key for `edit.paste`
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, desktop-shell verification (checking
that Cmd+C/V/X/A/Z reach the webview, step 3) · **Tests:** `e2e/tests/keyboard-paste.spec.ts` (2, both
fail on the old dispatcher: "hello" stays "hello"), `commands/keymap/dispatch.test.ts` › "never
matches edit.paste's Cmd+V…"

In the block editor a real Cmd+V (Ctrl+V elsewhere) inserts nothing, in the desktop app and in
Chromium alike. `commands/registrations/structural.ts` registers `edit.paste` with
`mac: "Cmd+V"`, `when: "editorFocused"`; `buildKeymap` compiles it like any other row, so
`CommandLayer`'s capture-phase dispatcher matches it, calls `preventDefault()` — which cancels the
browser's paste, so the `paste` event the editor actually handles (`surface.ts`
`domEventHandlers.paste` → `BlockTree#onPaste`) never fires — and runs `edit.paste`, whose editor
side does nothing (no `case "edit.paste"` anywhere). Spec R33 says the row is informational and
"never matched by the keydown dispatcher"; the code did not do that. Every e2e paste test builds a
synthetic `ClipboardEvent("paste")`, which is why none caught it.

Evidence:
- Chromium, Playwright against a real server (`paste-probe2.cjs` in the verify scratch): a plain
  `<textarea>` gets "PASTED" from `Meta+V`; the block editor stays `"hello "`, and a document
  capture listener sees the `V` keydown with `defaultPrevented: true` after the dispatcher.
- WKWebView, devtest2 app, keys sent in-process through `NSApp postEvent` (probe harness): in
  Settings → Custom CSS (a textarea) Cmd+C / Cmd+V / Cmd+X / Cmd+Z / Shift+Cmd+Z / Cmd+A all work
  through the native Edit menu; in a block Cmd+C, Cmd+X, Cmd+Z, Shift+Cmd+Z work and Cmd+V inserts
  nothing (`shots/verify/v08-block-editor-clipboard.png`).

**Fix** (`commands/keymap/dispatch.ts`): the dispatcher skips `edit.paste` rows when matching a key
(R33's "never matched"), so the key's default — the native `paste` event — happens. The row stays
in the compiled keymap, so the palette and Help → Keyboard shortcuts still show Cmd+V. After the fix,
in the devtest2 app: copy a word in a block, Cmd+V → `"hello world world"`, Cmd+Z takes it back
(`shots/verify/v13-block-editor-paste-after-fix.png`).

---

### B-533 · The desktop app's menu bar has no Settings…, no Reload and an empty Help menu
**Status:** fixed (the client half tested; the native half built and launched, not clicked) ·
**Severity:** medium · **Found:** 2026-09-13, desktop-shell · **Test:**
`e2e/tests/desktop-shell.spec.ts` › "the native menu's Settings… and Keyboard Shortcuts open the
client's own panels (B-533)" (fails on the old code: nothing listens), `apps/web/src/platform/desktop-shell.test.ts` (5)

`main.rs` sets no menu, so Tauri installs its macOS default (`tauri-2.11.5/src/menu/menu.rs`,
`Menu::default`): *nooklet* (About, Services, Hide, Hide Others, Quit), *File* (Close Window),
*Edit* (Undo, Redo, Cut, Copy, Paste, Select All), *View* (Enter Full Screen only), *Window*, and a
*Help* menu with nothing in it on macOS. So the one place a Mac user looks for Settings (the app
menu, Cmd+,) has none, there is no Reload — the only recovery from a wedged page short of quitting —
and Help is empty. Settings is reachable in the client itself (`?` → Settings, Cmd+, when the
webview has focus), which is why this is medium, not high.

A custom menu replaces that default wholesale, so it has to carry the predefined Edit items over:
on macOS those items are how Cmd+C/V/X/A/Z reach a text field in a webview (Tauri ships them in its
default for that reason). Unverified here: that the keys work in the devtest window, before or
after — no Accessibility permission to send them.

**Fix.** `main.rs#app_menu` (macOS only — Tauri adds no default menu elsewhere, and neither do we):
Tauri's default item for item, plus *nooklet → Settings…* (Cmd+,), *View → Reload* (Cmd+R) above
Enter Full Screen, and *Help → Keyboard Shortcuts / nooklet Documentation / Report a Bug…*.
`on_menu` handles Reload (`WebviewWindow::reload`) and the two links (system browser, B-534) itself;
Settings… and Keyboard Shortcuts are the client's, so it evaluates
`window.dispatchEvent(new CustomEvent("nooklet:desktop-menu", {detail}))` in the page, and
`apps/web/src/platform/desktop-shell.ts#listenToDesktopMenu` (wired in `AppShell`) opens
`openSettings()` / `HelpMenu`'s now module-level `openShortcuts()`. It listens only when the shell's
`__NOOKLET_DESKTOP__` flag is present. The client binds nothing to Cmd+R, so Reload does not shadow
a command; Cmd+, is bound in both, and by WebKit's `WebViewImpl::performKeyEquivalent` the page
sees it first — opening Settings is idempotent either way.

Verified: the menu builds (the devtest app launches with it; a failing `app_menu` aborts the Tauri
build at startup) and the client half end to end in Chromium. ~~**Not** verified: choosing the items
in the real menu bar, or any key reaching the WKWebView.~~

**Verified in the app** (verification pass): the menu bar is as listed above (plus the items macOS
adds itself: Writing Tools, AutoFill, Dictation, Emoji & Symbols, full screen). Chosen from the menu:
Settings… and Help → Keyboard Shortcuts open the client's dialogs (`v10`, `v11`), View → Reload
reloads. Keys: Cmd+, with a block focused opens Settings (`v09`); Cmd+R reloads. In a plain textarea
Cmd+C, Cmd+V, Cmd+X, Cmd+Z, Shift+Cmd+Z and Cmd+A all work (the page leaves them unhandled, the Edit
menu's items do them); in a block Cmd+C, Cmd+X, Cmd+Z and Shift+Cmd+Z work, and Cmd+V did NOT — a
client bug, B-536, now fixed. The general pasteboard was snapshotted and restored around each run.

---

### B-532 · The service worker never takes over while an older one controls the page — the desktop app runs the previous client for a whole session after every update
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, the owner ("seems way behind"),
reproduced in desktop-shell · **Test:** `e2e/tests/sw-update.spec.ts` › "a newer service worker takes
over an open page and reloads it onto the new build (B-532)" (fails on the old code with the new
worker in `waiting`); probe `tools/probes/desktop-sw-update.sh`, screenshots `shots/update-before-fix/`
and `shots/update-after-fix/` (label crops in each `labels/`)

B-20 switched `vite-plugin-pwa` to `registerType: "autoUpdate"` so a new build would apply itself.
It does not, because `vite.config.ts` also sets `injectRegister: false`, and the plugin only turns on
`workbox.skipWaiting` / `workbox.clientsClaim` for autoUpdate when `injectRegister` is `"auto"` or
unset (`node_modules/vite-plugin-pwa/dist/index.js`, v1.3.0: `if ((injectRegister === "auto" ||
injectRegister == null) && registerType === "autoUpdate") { workbox.skipWaiting = true;
workbox.clientsClaim = true; }`). The generated `dist/sw.js` confirms it: `skipWaiting()` appears
only inside the `SKIP_WAITING` message handler, and there is no `clientsClaim()`. And in autoUpdate
mode `registerSW`'s update function never sends that message (`if (!auto) sendSkipWaitingMessage()`),
while `sw/register.ts`'s `onNeedRefresh` is never called in that mode at all. So a new worker
installs, precaches, and then **waits** for as long as any page is controlled by the old one; the
reload-on-`activated` that autoUpdate relies on never fires.

Reproduced in the devtest app (`tools/probes/desktop-sw-update.sh`, fresh WebKit store, graceful
quits): serve the `adadff1` client and launch; serve the `52e5d20` client and launch again. Each
index.html is stamped with a visible label naming its build and `index-*.js`:

- launch with the old client served: `shell: OLD adadff1 · index-DXnnFemz.js` (as expected);
- **first launch after the server has the new client: still `OLD adadff1`, for the whole 40 s
  session.** The request log shows the update WAS found — `GET /sw.js`, then the new build's
  `/static/index-DxOn0mZf.js` fetched with `sec-fetch-dest: empty` (the new worker filling its
  precache) — but no page ever asked for it;
- second launch: `shell: NEW 52e5d20 (no fix)` — the waiting worker took over only once the app
  had quit and no page was left for the old one to control; third launch: new as well.

So after any update the desktop app shows the previous client for the first whole session, which
is exactly "a build from today that seems way behind". In a browser the same bug pins a tab that
stays open (reloads do not activate a waiting worker; the hourly `registration.update()` just finds
the same waiting worker again). A guess, not checked: the owner's store still holding a Sep 11 client
fits B-430 — the Sep 11 app could not start its own server against the migrated graph, so it may
never have reached a newer client before this build's first launch.

Which client the owner's app shows is also not decided by the app build at all: the shell uses any
nooklet already answering on 6100, and on the owner's machine that is `pnpm nooklet serve` from the
main checkout (`lsof`/`ps`, read-only: pid started 17:22, serving that checkout's `apps/web/dist`).
A rebuilt `.app` alone changes nothing the window loads; rebuilding the client that server serves does.

**Fix** (`apps/web/vite.config.ts`): `workbox.skipWaiting: true` and `workbox.clientsClaim: true`,
explicitly, with the reason beside them; `sw/register.ts` loses the never-called `onNeedRefresh`
whose comment claimed it applied updates. The generated `sw.js` now calls `self.skipWaiting()` on
install and `clientsClaim()`. Nothing else was needed: the old page's own `registerSW` reloads when
a newer worker activates, and that code is already in every installed client since B-20.

Proven twice:
- Chromium (`e2e/tests/sw-update.spec.ts`): a page controlled by this build's worker, a newer
  registration of the same `sw.js` → before: no reload in 60 s, state
  `{"controlled":true,"scriptURL":".../sw.js","waiting":true,"installing":false}`; after: the page
  reloads by itself in ~2 s and settles with nothing waiting (3/3 with `--repeat-each=3`).
- WKWebView, the devtest app (`desktop-sw-update.sh`, same OLD `adadff1` client installed first,
  graceful quits, 6 s / 30 s screenshots): the **first** launch after the server has the fixed client
  already shows `shell: NEW with B-532 fix · index-B8cDJY3A.js` at 6 s, and so do both later
  launches. The request log shows the extra `GET /sw.js` of the reloaded page registering again.

This also rescues clients installed before the fix: the old page's worker never needed to change,
only the NEW worker has to skip waiting, and that is the code the server now serves.

Unverified: the owner's own store (not inspected, by the rules of this task); an app killed rather
than quit (probe quits normally); the reload landing mid-typing in WKWebView (pagehide flush is
covered for browsers by `reload-durability.spec.ts`, not re-run in the app).

---

### B-530 · The desktop launcher page is not in git, so a clean checkout cannot build the desktop app
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, desktop-shell (building a devtest
app from a fresh worktree) · **Test:** none automated — `cargo check` in a fresh worktree is the check

`tauri.conf.json` has `frontendDist: "../dist"`, i.e. `apps/desktop/dist/index.html` — the
hand-written launcher page that polls the server and redirects to it. The root `.gitignore`'s
`dist/` swallowed it, so it existed only in the checkout it was written in. In a fresh worktree:

```
error: proc macro panicked
   --> src/main.rs:163:16
163 |         .build(tauri::generate_context!())
    = help: message: The `frontendDist` configuration is set to `"../dist"` but this path doesn't exist
```

The release workflow (`.github/workflows/release.yml`) checks out fresh, so it cannot have built
the app either. Fix: `!apps/desktop/dist/` after the desktop lines in `.gitignore`, and the page
committed as it was in the main checkout (plus reading the port from the shell, below).

**Merge note (verification pass):** `main` has since moved the launcher to `apps/desktop/launcher/`
(`m11/delete-launcher`, `frontendDist` changed), so on merge this tracked `dist/index.html` and the
`.gitignore` negation become dead and should be dropped, carrying the `__NOOKLET_DESKTOP__.port`
read into the new launcher. `main.rs` and `AppShell.tsx` also conflict (`git merge-tree`).

---

### B-490 · The desktop app's launcher page was never committed — `apps/desktop/dist/` is gitignored
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, delete-launcher (B-430) ·
**Test:** `cargo check` in a fresh worktree (the build script fails without it); no automated test

`tauri.conf.json`'s `frontendDist` was `../dist`, and `.gitignore`'s `dist/` matches
`apps/desktop/dist/` — so the hand-written launcher page (`index.html`, the "Couldn't reach the
nooklet server" screen) existed only in the owner's main checkout (dated Sep 11) and in no commit.
A fresh checkout cannot compile the app: `cargo check` there fails in `tauri::generate_context!()`
with "The `frontendDist` configuration is set to `"../dist"` but this path doesn't exist" (seen in
this worktree before any change). The release workflow (`.github/workflows/release.yml`) checks out
clean and runs `tauri-action`, so it should fail the same way — reasoned, not run.

Fixed by moving the page to a tracked `apps/desktop/launcher/` (a hand-written page is not build
output; `dist` invited exactly this) and pointing `frontendDist` there; `cargo check` and
`cargo test` pass in this worktree. The stale untracked `apps/desktop/dist/` in the main checkout is
now unused and can be deleted. `cargo check` also needs `apps/desktop/sidecar/` to exist — that one
IS build output (`pnpm --filter @nooklet/desktop run sidecar`), so a bare `mkdir` is enough to check.

---

### B-430 · The desktop app says "Couldn't reach the nooklet server — start it" when its own bundled server refused to start
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, the owner opening a desktop build
from Sep 11 against a graph migrated since · **Test:** none yet

The launcher page tells you to run `pnpm nooklet serve`, which is wrong advice for a self-contained
app and hides the real reason. Reproduced by running the bundle's sidecar by hand against a copy of
the graph: `nooklet: database schema version 6 is newer than this build supports (4); upgrade
nooklet`, exit. `main.rs` inherits the child's stderr (nobody sees it from Finder), never checks
whether the child exited, and `wait_until_ready` just times out into the generic page. Fix: keep
the child's stderr tail, detect early exit, and show that message on the launcher page (with
"update the app" for a schema-too-new exit); only say "start a server" when nothing was spawned.

**Fixed 2026-09-13.** `apps/desktop/src-tauri/src/main.rs` pipes the bundled server's stderr
(still echoed to the app's own stderr), keeps its last 40 lines, and watches the child
(`watch_startup`): it answers → `ready`; it exits first → `exited` with the code, the tail, and a
reason read from the server's own words (`schema_too_new` for "is newer than this build supports",
`port_in_use` for Node's `EADDRINUSE`, both captured by running `nooklet serve` for real); still
silent after 30 s → `timed_out`, and watched on. A reused external server is `external`; a sidecar
that could not be launched is `spawn_failed`. The launcher page asks through a Tauri command,
`server_status` (local pages only — Tauri refuses app commands from the server's remote origin
without a capability), and `apps/desktop/launcher/status.js` turns it into words: "This graph needs
a newer version of nooklet … Update the app, then open it again", the server's output verbatim
underneath, and `pnpm nooklet serve` only for `external` or when there is no app to ask. While the
server is starting the page now says "Starting nooklet…" rather than flashing the "couldn't reach"
help for the second a normal launch takes.

Tests: `cargo test` in `apps/desktop/src-tauri` (6) — `a_child_that_exits_during_startup_is_reported_with_its_stderr`
spawns a child that prints the real message and exits 1, and fails if stderr is not captured or the
exit is not noticed; `every_status_serializes_to_the_shape_the_launcher_reads` pins the JSON against
`apps/desktop/test/server-status.json`; `apps/desktop/test/launcher-status.test.mjs` (4, `node
--test`, now `pnpm -r test` for `@nooklet/desktop`) renders the same fixtures; `e2e/tests/desktop-launcher.spec.ts`
(4) loads the page in Chromium with a stubbed `__TAURI_INTERNALS__`. Not verified: a built app
(`tauri build` was out of bounds) — `server_status` reaching the launcher inside WKWebView, and the
schema message appearing when the real app opens a too-new graph, are reasoned from Tauri 2.11.5's
source (`webview/mod.rs`: app commands from a local origin pass without an app manifest), not seen.

---

### B-311 · Pasting outline text with a page-properties pre-block drops those lines
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, server-ops (fixing B-235) · **Test:**
none; read, not run

`apps/web/src/editor/paste.ts#pasteMarkdownAsTree` inserts `parseOutline(text).blocks` and never
looks at `.properties`, so pasting `tags:: x\n\n- a\n- b` (or `- type:: book\n- next`, a bulleted
pre-block to the parser) into a block creates `a` and `b` and loses the property lines — the same
silent drop B-235 was on the server. Not fixed here (web editor, outside this branch). Fix
direction: paste has no page to give properties to, so keep such lines as a block of their own
(e.g. insert the pre-block's lines as one block's properties) rather than discard them.

**Fixed 2026-09-13.** `apps/web/src/editor/paste.ts#pastedBlocks`: when the pasted text parses with
page properties (lines before the first bullet, or a first bullet of nothing but property lines),
they become an empty first block carrying them as its properties, inserted with the rest — not
dropped. The pre-block's `id::` is not carried (a page id; paste mints new ids anyway). Text that
is nothing but property lines now creates that one block (before, no block at all, and an empty
target was still deleted with focus sent to id ""). Tests: `apps/web/src/editor/paste.test.ts` ›
"property lines the parser reads as a page-properties pre-block (B-311)" (4; 3 fail on the old
code) and `e2e/tests/paste-page-properties.spec.ts` (1, Chromium, port 6401: a real paste event
into a production build; the stored tree has the property block between the anchor and the pasted
bullets).

---

### B-324 · A Tasks view row shows only one date, so a task found by its deadline shows its scheduled date
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, fixing B-171 · **Test:** none

`views/TasksView.tsx` renders `formatDueDay(t.dueDay)` in `.task-due`, and `dueDay` is
`coalesce(scheduled_day, deadline_day)`. Since B-171 the Due from/to window matches either date,
so with a 2031-03-15..25 window the task "scheduled 2031-03-01, deadline 2031-03-20" is listed
with the label "2031-03-01" — outside the window the reader just typed, with nothing saying why it
is there. The row does not say whether its one date is a scheduled date or a deadline either. Likely
fix: show both dates when both are set, labelled as the journal agenda does
(`views/JournalAgenda.tsx`). Not done here: a display change beyond the filter bug.

**Fixed 2026-09-13.** A Tasks view row now shows the scheduled date and the deadline, each
labelled ("Scheduled 2032-04-01", "Deadline 2032-04-20 14:30", with the time when there is one),
both when both are set, stacked in the row's date column — `views/taskFilters.ts#taskDateLabels`,
rendered by `views/TasksView.tsx` (`.task-due .task-date`), styled in `styles/views.css`. Tests:
`apps/web/src/views/taskFilters.test.ts` › "taskDateLabels" (2) and
`e2e/tests/tasks-view-dates.spec.ts` (1, Chromium, port 6401: both labels on a scheduled task with
a deadline, a lone deadline with its time, a lone scheduled date, none for an undated task, and the
row found by its deadline in a Due window still labelled). Not checked at phone width by a test.

---

### B-370 · Undo of a batch that renamed a page and created a new one under its old name fails
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, while fixing B-366 · **Test:** none
(scratch probe only)

Not fixed here, for the coordinator (no number left in this branch's range): `batch.undo` cannot
reverse a single batch that renamed page A to B and then created a new A (`batch` op or a plugin) —
it writes the rename back before deleting the new A, core rejects the rename, and the call answers
400 with nothing written. Reproduced on this branch with a scratch probe; see
`docs/review/2026-09-13-rv-merge-server.md`, "Found while fixing".

**Fixed 2026-09-13.** `ops/batch-undo.ts` now orders the restore by page names before minting any
op: a page whose ops claim a key (a rename back, or an un-delete) goes after the page of the same
batch that holds that key now and gives it up (a page the batch created, deleted by the undo; or a
page renamed away or sent back to the trash). Blocks keep batch order. Undoing "rename A to B +
create a new A" and undoing that undo both answer 200; so does a chain (A to Archive, Draft to A).
Two pages swapping names form a cycle no order solves: still 400 `page-key-collision`, nothing
written — pinned by a test so a later change sees it. Test:
`packages/server/src/ops/batch-undo-name-order.http.test.ts` (3; the first two fail on the old
code with 400).

---

### B-322 · `page.backlinks` for a not-yet-created journal day named by a non-ISO title finds no linked references
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, reading `ops/page-backlinks.ts`
while fixing B-200 · **Test:** none

Found by reading, then reproduced through the web client: with the B-200 panel asking under the
raw route name, `/page/<Mmm do, yyyy>` for an uncreated day linked as `[[<iso>]]` listed no linked
references (the second B-200 e2e, run against that variant, "received []"). References are indexed under
`normalizePageName(canonicalRefName(name))` (`apply-ops.ts#normalizeKey`, ADR 018), so
`[[Sep 20th, 2026]]` is stored under `2026-09-20`. When the target has no page row,
`page-backlinks.ts` matches linked references (and excludes linked blocks from unlinked mentions)
with `normalizePageName(input.target)` — the raw title — while the tagged-pages lookup a few lines
below already uses `refKeyOf`. An agent asking for `target: "Sep 20th, 2026"` before that day's page
exists therefore gets `linked: []` even though blocks link to it; `target: "2026-09-20"` works. The
web client's missing-page view (B-200) sidesteps it by asking with `canonicalRefName`. Likely fix:
`const key = refKeyOf(input.target)` in that branch, with an http test. Not done here: a server op,
outside this branch's rendering scope.

**Fixed 2026-09-13.** `ops/page-backlinks.ts`, not-yet-created-page branch: the linked-reference
query and the unlinked-mention exclusion now key by `refKeyOf(input.target)` — the key refs are
indexed under — instead of `normalizePageName(input.target)`; the tagged-pages lookup shares the
same key. `target: "Sep 20th, 2026"` and `"20.09.2026"` now return the same linked references as
`"2026-09-20"`, and a block linking the day is no longer also listed as an unlinked mention of it.
Test: `packages/server/src/ops/page-backlinks-missing-journal.http.test.ts` (2; both fail on the
old code — "expected +0 to be 2", and the linking block in `unlinked`).

---

### B-390 · An empty block's mirror line `- ^id` reads back as the text `^id` with no id — 441 of 952 mirror files
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, core-ops (fixing B-310) ·
**Test:** `packages/core/src/outline.test.ts` › "a block whose line 1 is only its id (B-390)" (3),
`packages/server/src/mirror/export.test.ts` › "reads back empty blocks, a fence-first task and a
blank-line-first task as written"

The serializer writes a block whose line 1 is empty as `- ^id` (or `- TODO ^id`), but the parser
only took a lone `^id` when another line followed (OUT-14's fence form), and OUT-12's ` ^id`
suffix regex needs the space that stripping a marker also removes. So on re-read:

- every empty block (`- ^id`) came back with content `"^1k7…"` and no id;
- a task with an empty line 1 (`- LATER ^id` + `  > text`) came back with content `"^id\n> text"`
  and no id — the owner has one (`1m287mdbgs5v8t`);
- `- ^id\n  text` (content `"\ntext"`, no marker) lost its leading empty line.

Measured on a copy of the owner's graph with `tools/probes/mirror-roundtrip-graph.ts` (renders
each page exactly as `mirror/export.ts` does and parses it back): before the fix 441 of 952 pages
read back differently — 578 blocks with a wrong id and 598 with wrong content. After: 2 pages, 20
blocks, all the known pre-B-266 literal `SCHEDULED: <…>` lines (content moves into
`scheduled::`). Nothing reads the mirror back in normal operation, which is why it went unseen; it
bites on "walk away with the files" re-import, and — by reading `outline-bridge.ts`, not run — on
`page.append`/`block.insert` markdown holding a `- ^id` line: a new block with the text `^id`
instead of mcp-tools.md rule 6's upsert of that existing block.

Fix (`outline.ts#finalizeNode`): a line 1 that is exactly `^id` after marker/priority stripping
carries the id whether or not more lines follow; its now-empty line 1 is dropped only when the
next content line opens a fence (OUT-14), else kept as the content's own empty line. An empty
block with a `^id` is no longer taken for a page-properties pre-block (`parseOutline` tracks which
ids came from `^` syntax) — otherwise a page whose first block is empty would lose that block into
`page.properties.id`. Spec: OUT-14. Known remaining ambiguity: a block whose whole content is the
text `^<valid id>`, written without ids (`ids: "none"`), reads back as an empty block with that id.

---

### B-310 · A task block whose content opens with a code fence loses its marker in the mirror, and its code in `ids: "none"` text
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, server-ops (fixing B-151) ·
**Test:** none yet; `tools/probes/fence-first-task-roundtrip.ts` reproduces it

A block `{marker: "TODO", content: "```js\n- not a bullet\n```", properties: {foo: "bar"}}` with a
child (the store can hold one: `block.update {content: "TODO ```js\n…"}` writes exactly that):

- **With ids (the mirror):** OUT-14 writes `- ^id` alone on line 1 and the content from line 2 —
  and drops the marker/priority head entirely. Re-parsed: `marker: null`. The mirror is meant to be
  lossless.
- **Without ids:** `- TODO ```js` goes out on line 1, but the parser checks for an opening fence on
  the raw line (marker still attached), so no fence opens: `- not a bullet` becomes a second child,
  and the content comes back as `"```js"` alone.

Not in the owner's graph today (29 blocks open with a fence, none has a marker or a property —
checked on a copy, 2026-09-13), which is why nothing showed it. Fix direction (not done here — it
is the core parser and OUT-14's shape, both beyond this branch's bugs): the parser should look for
an opening fence after stripping marker/priority, and OUT-14 needs a form that keeps the head (for
example `- TODO ^id` alone on line 1), with markdown-grammar.md updated to match.

**Fixed 2026-09-13.** Two halves, one cause each, both in `packages/core/src/outline.ts`:

- Parser: line 1's fence was looked for on the raw line, marker still attached, so `- TODO ```js`
  never opened one. `firstLineOpensFence` now strips marker/priority first (`splitTaskHead`, shared
  with `finalizeNode`), in both places line 1 is read (block-level fence tracking and the
  property/content split).
- Serializer: OUT-14's form wrote `- ^id` and dropped the head. It now writes `- TODO [#A] ^id`,
  and the parser reads a line 1 left empty by head/id, followed by a line opening a fence, as not
  a content line. Without ids and with properties: after the closed fence (as B-151), or — fence
  never closes — `- TODO` alone on line 1 before the properties.

Spec: `docs/spec/markdown-grammar.md` OUT-14 rewritten, OUT-18's B-151 paragraph updated. Tests:
`packages/core/src/outline.test.ts` › "a task block that opens with a fence (B-310)" (5; 4 fail on
the old code), `packages/server/src/mirror/export.test.ts` › "reads back empty blocks, a
fence-first task and a blank-line-first task as written" (fails on the old code). Probe
`tools/probes/fence-first-task-roundtrip.ts` now prints the block back unchanged in both modes.
Not verified: how Logseq itself reads `- TODO ```js` in a file (no Logseq here); the owner's graph
has no such block.

---

### B-291 · Text composed in place (an IME's marked text, a dead-key accent) while the date picker is open goes into the block behind it
**Status:** wontfix · **Severity:** low · **Found:** 2026-09-13, m9/focus
(split out of B-147) · **Test:** none; probe `tools/probes/date-picker-composition.spec.ts`

B-147's second half, the part its fix could not reach. With the picker open over a block being
edited, a composition — emulated through CDP `Input.imeSetComposition` ("ˇ", then "č") and committed
with `Input.insertText` — is written into the block: editor `"compose ˇ"`, then `"compose č"`, and
the picker's query stays empty. Plain `insertText` right after it (what the B-147 fix takes) reached
the picker (`"zítra"`), so the probe tells the two apart. A composition's `beforeinput`
(`insertCompositionText`) cannot be cancelled, and CodeMirror applies the DOM change itself, so no
listener can keep it out while the editor holds DOM focus.

Unverified on real hardware: which layouts compose. By the B-147 entry's reading, a Czech Mac
layout's number-row letters are ordinary keydowns (fine), while háček/čárka dead keys and every CJK
IME compose (this bug). The picker's vocabulary is English words and digits, so what lands is junk
in the block, not a wrong date.

Why it is not fixed here: the only robust fix is for the picker to OWN focus while open — a
visually hidden input inside it takes every kind of text input natively — and hand focus back on
close (`commands/focus-return.ts#rememberFocus` now does that part). That reverses a deliberate
design choice in `DatePicker.tsx` ("the editor KEEPS focus… the caret is exactly where it was by
never having left"), changes what `e2e/tests/dates.spec.ts` asserts ("while the picker is open" the
editor is focused), and on a phone a focus move between inputs affects the virtual keyboard in ways
nobody here can test. Owner decision: keep "editor keeps focus" and accept this, or move focus
into the picker.


**Owner decision 2026-09-13: accepted as is.** The editor keeps focus while the date picker is open; composed text landing in the block is junk, never a wrong date. Revisit only if a real layout hits it in daily use.

---

### B-301 · An edit written just before a reload never reaches the server until something else is edited

**Status:** fixed · **Severity:** high (a device can hold an edit the server never gets; closing the
tab and continuing on another device loses it there) · **Found:** 2026-09-13, clipboard-sync,
measuring B-247 · **Test:** `e2e/tests/reload-durability.spec.ts` "an edit written just before a
reload is pushed after it, with no further edit (B-301)"

Type into a block, reload between ~0.5 s and ~0.8 s later (after the 500 ms text debounce handed the
op to the worker, before the 300 ms push debounce that follows): the reloaded page shows the text —
it is in the replica's `pending_op` outbox — but the server does not get it, 3 s later or ever,
until a later local write anywhere schedules a push (the probe's "one more edit elsewhere" pushed
it). `WorkerDb.start()` bootstraps, connects the live socket and pulls, and nothing at startup
pushes an outbox left by a previous session; `schedulePush` is only called by `applyLocal` and by
the online/visible/resume lifecycle events.

**Fixed 2026-09-13.** `SyncClient.connectLive` schedules an immediate push when `pending_op` is not
empty — once when called at startup (even if the socket never opens) and on every live-socket
`onOpen`, so an outbox that failed to push while the server was down also goes out on reconnect
instead of waiting for the next write. Tests: `e2e/tests/reload-durability.spec.ts` "an edit
written just before a reload is pushed after it, with no further edit (B-301)" (red before, green
after); `apps/web/src/sync/sync-client.test.ts` "pushes ops left in pending_op by an earlier
session as soon as it connects" and "pushes again when live sync reconnects after a failed push"
(both red with the change reverted), "does not push at all when the outbox is empty".

---

### B-303 · Ending an edit shows the block's last-fetched text until the write comes back, and a Cut in that window copies the old text

**Status:** fixed · **Severity:** high since B-245 (Cut deletes the block and puts the OLD text on
the clipboard: paste it elsewhere and the words just typed are gone; undo restores them, if you
notice) · **Found:** 2026-09-13, adversarial verify of `m9/clipboard-sync` ·
**Test:** `e2e/tests/selection.spec.ts` "Cmd/Ctrl+X straight after typing cuts the text as typed,
while the replica is still busy (B-303)"

Type into a block and, within the 500 ms text debounce, press Escape (or Shift+Down) and Cmd+C /
Cmd+X. Measured with a throwaway spec (MutationObserver on the first row, no artificial load):
the row reads `one typed` while editing, flips to `one` the moment editing ends, and back to
`one typed` 12–20 ms later; Cmd+C at gaps of 0, 100 and 300 ms after the last keystroke copied
`- one` (4 of 4 for Escape, 4 of 4 for Shift+Down), at 700 ms (debounce already flushed) `- one
typed`. Cmd+X in the same window put `- one\n- two\n` on the clipboard and deleted both blocks; the
undo brought back `one typed`, so the replica had the text and only the clipboard lost it. With the
worker busy (1.5 s loop, as on the real graph — B-302 measured 0.1–1.6 s stretches while typing),
the old text stays on screen for the whole stretch.

Cause: `BlockTree.tsx`'s tree effect reads `editingId()` tracked, so ending an edit re-runs it
against the page tree fetched BEFORE `flushPendingEdit`'s write; without the editing overlay, that
stale read replaces the optimistic text in `localBlocks` until the refetch after the write lands.
`selectionMarkdown` reads that tree. Copy (B-84) had the same stale window but no loss.

**Fixed 2026-09-13 (verify pass).** `BlockTree.tsx` keeps the buffer of each flushed text write
until the worker answers it (`unansweredText`) and lays it over whatever page tree the effect
re-runs with; the worker answers in message order, so a tree that resolves after the answer was
read after the write and needs no overlay. A later local op on the block other than a move (undo,
redo, merge, delete) drops the entry. Test: `e2e/tests/selection.spec.ts` "Cmd/Ctrl+X straight
after typing cuts the text as typed, while the replica is still busy (B-303)" — red before the fix
(the selected row itself read `jedna`, not `jedna – přidáno`), green after; it also checks the
property line reaches the clipboard and that one undo brings the typed text back on the server.
Not covered: the effect re-running between the answer and the refetch that follows it (one query
round trip) still shows the old text — only if editing changes in exactly that window.

Real graph (copy, 952 pages; `tools/probes/cut-just-typed.mjs`, no artificial load): on
`Megapage` (201 rows), type into row 2, Escape, Cmd+X 0 / 150 / 350 ms after the last key — the
pre-fix build put the OLD text on the clipboard all three times while the cut removed the block;
the fixed build put the typed text there all three times (and on `2026-05-03`), and one undo
restored the block with it each time. `nooklet verify` on the copy afterwards: OK, 20,485 ops.

---

### B-312 · A refused `page.append` to a page that does not exist yet leaves that page behind, empty
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, server-ops (fixing B-235) · **Test:**
none yet; reproduced with a throwaway vitest probe (not kept — the fix's test replaces it)

`page.append {page: "Fresh", markdown: "- a ^1k7f3q9xz2hav4"}` (an unknown `^id`) answers 400 — and
`SELECT COUNT(*) FROM page` went 1 → 2: `resolvePageRef(…, {create: true})` creates the page (or
journal day) with its own `applyOps` before the markdown is parsed or validated, and nothing rolls
that back when validation throws. Same for a dangling fence / markdown with no blocks, and for
B-235's new pre-block refusal. An agent retrying with fixed markdown gets its blocks on the stray
page, so the visible damage is an empty page (or an empty journal day) when it gives up instead.

---

**Fixed 2026-09-13.** `outline-bridge.ts#checkWriteMarkdown` parses and refuses write markdown
without touching anything; `page-append.ts` calls it before `resolvePageRef`, then hands the checked
tree to `prepareMarkdownInsert`. A `parent` no longer creates the page either (a page that does not
exist holds no parent; 404 as before, nothing written). Test that would have caught it:
`packages/server/src/ops/markdown-page-properties.http.test.ts` › "a refused page.append creates no
page (B-312)" — pre-block, unknown `^id`, unknown `^id` on an unwritten journal day, `parent` on a
missing page; all four failed on the old `page-append.ts` (row counts moved).

---

### B-281 · A date picked from a chip in another journal day, with a block still selected in this one: Cmd/Ctrl+Z takes back the wrong thing
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, verifying `m9/undo` (probe) ·
**Tests:** `e2e/tests/undo-gaps.spec.ts` "a date picked from a chip in another journal day, with a
block still selected in this one, is what Cmd/Ctrl+Z takes back (B-281)";
`apps/web/src/app/editor-host.test.ts` "taken by another tree while a selection stands in the
active one: that session ends (B-281)"

Journal stream, two days on screen. Click into a block of day A, type " typed", press Escape (the
block stays selected — and stays selected through clicks elsewhere, so its tree stays the active
editor host). Click the deadline chip of a block in day B, pick "+31d". Cmd/Ctrl+Z: the date stays
and " typed" is taken back in day A. The date's step sits in day B's history, where a later
Cmd/Ctrl+Z in day B would take it back by surprise (the B-241 shape). The e2e test fails on
`695af3a` (`deadline` still `+31d` 10 s after Cmd+Z).

Cause: B-142's `commitThroughEditor` lands the batch in the tree that shows the block (day B) and
makes it `recent`, but `historyEditorHost()` prefers `active` — day A, because of its standing
selection. So "the tree that takes the batch becomes the undo target" only held when nothing was
selected anywhere else. With editing (not a selection) in day A the chip's pointerdown already
ends that session, so only the selection case is affected.

**Fixed 2026-09-13.** `app/editor-host.ts#commitThroughEditor`: when a tree other than the active
one takes a batch that does not move the caret, it calls `requestEditingEnd()` — every tree ends
its editing session and drops its block selection, the selected tree withdraws as the active host,
and Cmd/Ctrl+Z reaches the tree that took the step. Cost: the block left selected in day A is no
longer selected after a date is picked in day B (a click into day B leaves it selected, P14 in the
verification probe; that inconsistency predates this branch and is not touched). The e2e test
fails before the change and passes after it, redo included; the unit test fails with the line
removed.

---

### B-280 · Typing then collapsing within half a second: Cmd/Ctrl+Z undoes the typing before the collapse
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, m9/undo (reading `BlockTree#commitOne`
while fixing B-162) · **Tests:** `e2e/tests/undo-gaps.spec.ts` "typing then collapsing inside the
write debounce: Cmd/Ctrl+Z undoes the collapse first (B-280)", "typing then Cmd/Ctrl+Enter inside
the write debounce: Cmd/Ctrl+Z takes back the marker first (B-142, B-280)"

Edit "parent" (it has a child), type " more", press Cmd/Ctrl+Up within 500 ms: the block
collapses. Cmd/Ctrl+Z: the typing goes ("parent"), the block stays collapsed; the second Cmd/Ctrl+Z
expands it. Undo order is the reverse of what was done. The e2e test fails on this branch before
the fix (`Expected: 2, Received: 1` rows after the first Cmd+Z).

Cause: `commitOne` (collapse and expand from the keyboard or the bullet arrow, an image upload
that lands after the editor moved on) and the marker commits (`task.cycle` in `runCommand` and
`runSelectionCommand`, `onToggleMarker`, the marker click) push their step without flushing the
pending text edit first. The keystrokes are recorded later — on the debounce timer, or by the
flush at the start of `doUndo` — so they land ABOVE the step that came after them. Every other
structural path goes through `runStructural`, which flushes first.

**Fixed 2026-09-13.** `BlockTree#commitStep` flushes the pending edit and stops capturing before it
commits, like `runStructural`; `commitOne`, the `task.cycle` case of `runCommand` and
`onToggleMarker` go through it. The collapse test fails before the change and passes after it.
The Cmd/Ctrl+Enter test does not isolate B-280: Cmd/Ctrl+Enter is taken by the global command
dispatcher (document capture phase) and runs `task.cycle` through the command `Store`, which since
B-142 commits through `runStructural` and so already flushed. What it does pin is B-142 for the
keyboard: with the store's editor commit disabled (the `cf08d19` behaviour) it fails —
`Received: "TODO"` after Cmd+Z — so Cmd/Ctrl+Enter was never undoable either.

---

### B-162 · Undoing a collapse ends editing, so redo has no keyboard target
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, impl-commands verification · **Test:**
none yet (reproduced with a throwaway e2e spec, not kept)

Pre-existing, not caused by this branch. Editing a block with children, Cmd/Ctrl+Up collapses it;
Cmd/Ctrl+Z expands it again but also ends editing (`.cm-content` count 0), so the Cmd/Ctrl+Shift+Z
that follows reaches no host and does nothing (3 rows stay 3). "Collapse all" behaves the same way.
Cause, by reading: `BlockTree.commitOne` (and `setAllCollapsed`) record the history entry with
`before`/`after` focus `null`, and `doUndo`/`doRedo` treat a null focus as "detach the surface".
Recording the editing block's caret when the edited row survives would keep editing through undo.
Not fixed here (outside this brief's scope).

**Status:** fixed · **Tests:** `e2e/tests/undo-gaps.spec.ts` "undoing a collapse keeps editing, so
redo collapses it again from the keyboard (B-162)", "undoing Collapse all keeps editing a block that
stayed on screen, and redo folds again (B-162)"; `apps/web/src/editor/undo-focus.test.ts`

Reproduced on `cf08d19` by both: after Cmd+Z the active element is `<body>`.

**Fixed 2026-09-13.** The cause was the one the entry read: `doUndo`/`doRedo` treated a step with
no recorded caret as "detach the surface", and collapse, expand, Collapse all, a keyboard marker
cycle and a command's batch all record none. Rather than record a caret at each of those call
sites, the rule itself changed (`editor/undo-focus.ts#focusAfterStep`, used by the one
`BlockTree#applyHistoryStep` both now share): no caret to follow leaves the editor where it is
while its row is on screen, and ends editing only when the step took that row away (an undone
create, an undone expand folding it back). That covers every null-focus step at once, including
ones nobody listed (Cmd/Ctrl+Enter then Cmd/Ctrl+Z also ended editing). Both e2e tests fail on
`cf08d19` and pass with the change.

---

### B-194 · Cmd/Ctrl+Z after the edited block left the page reverts it out of sight and unmounts the editor
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, verifying `m8/impl-editor` (probe) ·
**Test:** none (the probe was a throwaway spec; its steps are here)

Caret in "goes", type " typed"; another writer moves "goes" to another page
(`block.move_to_page` through the API). The row leaves and " typed" is written to the block on
the destination page (B-88, as intended). Now click into "keep", End, Cmd/Ctrl+Z: the undo takes
" typed" back on the OTHER page, where nobody sees it, and the editor disappears from "keep" —
`editingRowIndex` is -1, `document.activeElement` is `<body>`, and the next keystrokes go
nowhere. Probe on the branch: destination read back `["already here","goes","child"]`, no row
held the editor, typed "Z" landed nowhere.

Not introduced by B-88's fix: the same probe against `apps/web` at `da85cfb` (where the row stays
until the click into "keep", which flushes the same text transaction) ends identically. B-88's
flush only makes it reachable without that click.

Cause: `EditHistory` keeps transactions for blocks that are no longer in this tree, and
`BlockTree#doUndo`/`doRedo` call `attachEditing(res.focus.id, …)` without checking that the tree
has a row for that id — `editingId` then names a block nothing renders. Fix when it matters: skip
(or drop) history entries whose blocks have left the tree, or keep the editor where it is when the
focus target is absent; which one is the owner's call (should an undo reach a block that left?).

**Status:** fixed · **Tests:** `e2e/tests/undo-gaps.spec.ts` "Cmd/Ctrl+Z after the edited block
left the page neither reaches it nor loses the editor (B-194)"; `apps/web/src/editor/history.test.ts`
"EditHistory — steps on blocks that left the tree are dropped (B-194)" (4);
`apps/web/src/editor/undo-focus.test.ts` (5)

Reproduced on `cf08d19`: after the move, click into "keep", End, Cmd+Z, type "Z" — no
`.cm-content` anywhere (`element(s) not found`).

**Fixed 2026-09-13.** Both halves the entry offered, since they answer different questions:
- *Should an undo reach a block that left?* No. `EditHistory.undo`/`redo` take a `present(id)`
  predicate (`BlockTree#stillInTree`: in the tree, or created here and not yet returned by a
  refetch) and drop, not skip, every step on top whose recipes write to a block that is not present
  and is not revived by the step itself (`history.ts#reachable`) — then apply the next older one.
  Cmd/Ctrl+Z in a page only changes what that page shows; the text typed into "goes" stays on the
  page it was moved to. Dropped rather than kept for later: if the block comes back, an undo
  reaching it then would be a surprise, not an undo.
- *Where does the editor go?* A recorded caret is followed only into a block that has a row
  (`editor/undo-focus.ts#focusAfterStep`), so it can no longer be attached to a block nothing
  renders (also: under a collapsed parent, outside the zoom root, filtered out by find in page).

**Owner's call, flagged:** the entry left "should an undo reach a block that left?" to the owner.
This branch answers no. If the answer should be yes, delete the `present` argument in `doUndo`/
`doRedo` (two call sites); the focus rule stays either way. The e2e test fails on `cf08d19` and
passes with the change.


**Owner confirmed 2026-09-13:** an undo does not reach a block that left the page. Keep the `present` check.

---

### B-191 · Undo of `/template` into a bullet that already had one of the template's properties removes it
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, fixing B-108 · **Test:** none
(not reproduced in the app; from reading `editor/invert.ts`)

`/template` into an empty bullet writes the template's first-block properties onto that bullet,
and since B-108 the whole insertion is one editor undo step. The inverse of a `block.prop` is
computed from the editor's `EditableBlock`, which models only the reserved keys (`marker`,
`priority`, `collapsed`, `scheduled`, `deadline`, `repeat`, `done`); any other key inverts to
`null` (`invert.ts#propValueBefore`). So if the empty bullet already had `type:: a` (set through
the API, for one) and the template sets `type:: b`, Cmd/Ctrl+Z removes `type` instead of restoring
`a`. Fix when it matters: let an `OpBatch` carry the before-values of the properties it overwrites
(`data/templates.ts` would read them from `block_prop` while it builds the batch), or project
generic properties into the page tree, which today (`BlockRow`) has none.

**Status:** fixed · **Test:** `e2e/tests/undo-gaps.spec.ts` "undo of /template into a bullet that
already had the template's property restores the old value (B-191)"

**Fixed 2026-09-13, before this branch, by B-101** (`89c0f22`, merged in `cf08d19`). B-191 was
logged on `m8/impl-editor` from reading `invert.ts`, whose `propValueBefore` inverted every
non-reserved key to `null`. B-101's branch, merged afterwards, projected generic properties into
`EditableBlock.properties` and made `propValueBefore` read `block.properties[key]`, which is the
fix the entry asked for. No code change here: the e2e test above (empty bullet with `kind:: a`,
`/template` whose first block has `kind:: b`, Cmd+Z, server has `kind: a` again and the buffer
shows `kind:: a`) passes on `cf08d19`, and fails when `propValueBefore`'s default case is put back
to `return null` (server `{}` instead of `{ kind: "a" }`) — so it is the test that would have
caught it.

---

### B-142 · Cmd/Ctrl+Z does not undo a date set with the date picker
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, impl-dates · **Test:** none yet;
probe `tools/probes/picked-date-undo.spec.ts`

`/scheduled`, `tomorrow`, Enter, then Cmd+Z: the chip stays and the server still has
`scheduled:: <tomorrow>` 1.5 s later (probe output: `scheduled after Cmd+Z: 2026-09-14`). The picker
writes through the command `Store` (`app/hosts.ts#setBlockProps` → `applyOps`), and undo is
`BlockTree`'s `EditHistory`, which only records what goes through `BlockTree#commit`. By reading
the code, every `ctx.store` task command has the same gap — `task.setPriorityA/B/C` and the
palette's `task.setMarker*` use `ctx.store.setBlockProp` — but only the date case was run.
Fix needs a seam, not a patch in the picker: an `EditorHost` (or store) method that commits ops
through the active tree's history, used by every store-routed command. `BlockTree.tsx` is a
shared file this milestone, so not done on this branch.

**Status:** fixed · **Tests:** `e2e/tests/undo-gaps.spec.ts` "Cmd/Ctrl+Z takes back a date set
with the picker, keeps editing, and redo sets it again (B-142)", "Cmd/Ctrl+Z takes back a date
picked from a chip, with nothing being edited (B-142)", "priority and marker set from the palette
are each one Cmd/Ctrl+Z (B-142)", "typing then Cmd/Ctrl+Enter inside the write debounce:
Cmd/Ctrl+Z takes back the marker first (B-142, B-280)"; `apps/web/src/app/hosts.test.ts` "createStore block-property
writes (B-142)" (3); `apps/web/src/app/editor-host.test.ts` "a command's op batch reaches a tree
that shows its block, focused or not (B-142)" (3)

Reproduced on `cf08d19` by all three e2e tests before any change: the picked date stays
(`Received: "2026-09-14"` 10 s after Cmd+Z), the chip's date stays (`2026-09-25`, not the `09-22`
it had), and palette "Set priority A" stays `A`. So the palette marker/priority commands have the
gap too, as the entry guessed by reading.

**Fixed 2026-09-13.** The seam is the command `Store`, not each command: `app/hosts.ts#createStore`
builds every `setBlockProp`/`setBlockProps` write as one `OpBatch` and hands it to
`EditorHost.commitOps` (the method `/template` already used, B-108), falling back to `applyOps`
only when no tree takes it. Every store-routed write is covered at once: the date picker (slash
item, palette row, chip), `task.cycle`/`task.toggleDone`/`task.setMarker*`/`task.clearMarker`
from the palette or menu, and `task.setPriorityA/B/C`. That includes Cmd/Ctrl+Enter itself, which
the global dispatcher runs as the `task.cycle` command through the store, not through
`BlockTree#runCommand`: it was not undoable on `cf08d19` either (see B-280's second test). `liveEditorHost.commitOps`
(`app/editor-host.ts#commitThroughEditor`) now tries the active tree, then the tree whose session
ended last, then every mounted one (`registerEditorHost`, one line in `BlockTree`), and the tree
that takes the batch becomes the undo target. Without that, a date picked from a chip — nothing
edited or selected, so no active tree — still went past every history. A tree only takes a batch
for a block it shows (`external-batch.ts`), so a write never lands in the wrong page's history.
Cost: the store's write now resolves when the tree has the change, not when the replica does
(the tree does not await `applyOps`, same as every edit). The three e2e tests fail on `cf08d19`
and pass with the change; `dates`, `tasks`, `templates`, `template-undo`, `undo-redo`, `redo` and
`selection` specs stay green (55/55). On a copy of the owner's graph
(`tools/probes/undo-real-graph.spec.ts`): palette priority and Cmd/Ctrl+Enter undone on a
task-heavy page, a chip date undone on journal 2022-12-16; `nooklet verify` OK afterwards.

---

### B-314 · `block.update` `old_str` on a block's `collapsed:: true` line answers 200 and changes nothing
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, verifying m9/server-ops · **Test:**
`block-update-text.http.test.ts` › "folds and unfolds a block by editing its collapsed:: line with
old_str (B-314)"

`before` (and so the text `old_str` matches) renders a collapsed block as `parent\ncollapsed:: true`.
`block.update {old_str: "\ncollapsed:: true", new_str: ""}` → 200, and `block.read` still says
`collapsed: true`; adding the line to an expanded block → 200, still expanded (checked with a
throwaway vitest file against `makeTestServer`). `applyTextReplace` writes content, marker, priority
and properties from the parsed text and never looks at `node.collapsed`. Newly reachable: before
B-172 every collapsed block (its before-text has a second line) was refused outright. Fix
direction: in the `old_str` path only — where the before-text carries the line, so a change in the
parsed `collapsed` can only be the agent's edit — write `block.prop collapsed`; `content` stays as
it is (an agent's full text rarely repeats the line, and reading its absence as "expand" would
unfold blocks nobody asked to).

**Fixed 2026-09-13.** `block-update.ts`: the `old_str` path writes `block.prop collapsed` when the
edited text's `collapsed` differs from the block's; `content` is unchanged (the test also pins that
a `content` without the line leaves a folded block folded). The test failed before the change
("expected true to be false").

---

### B-313 · `block.update` `content` copied from `page_read` for a nested block turns its property lines into text and deletes the properties
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, verifying m9/server-ops · **Test:**
`outline-bridge.test.ts` › "reads `content` copied from page_read at any depth (auto)…",
`block-update-text.http.test.ts` › "takes content copied from page_read for a nested block without
losing its properties (B-313)"

`page_read` prints a block at depth *d* with its later lines indented `2·(d+1)` columns:

```
- a ^…
  - b ^…
    - TODO c ^…
      scheduled:: 2026-09-13
      more c
```

An agent that replaces block `c` with `block.update {content: "TODO c2\n      scheduled:: 2026-09-14\n      more c"}`
— the shape it just read, bullet and `^id` dropped, which mcp-tools.md §3.2 rule 10 now says `content`
accepts — gets 200, and the stored block is `content: "c2\n    scheduled:: 2026-09-14\n    more c"`
with **no** `scheduled` property: `applyTextReplace` unsets every key the parsed text lacks. B-172's
`"auto"` reading only recognises page_read's shape for a top-level block (it leaves the lines as
they are and lets the parser strip one 2-column continuation indent; 4 or 6 columns stay behind, and
an indented `key:: value` line is not a property line). Not new — the pre-B-172 parser
(`parseOutline("- " + text)`) produced the identical block, checked with a throwaway tsx probe —
but a silent data loss on the path the branch documents. Fix direction: under `"auto"`, remove the
later lines' common leading whitespace rather than assuming exactly one 2-column unit.

**Fixed 2026-09-13.** `outline-bridge.ts#singleBlockBullet` under `"auto"` removes the common
leading whitespace of the later non-blank lines (then indents them like flush text); a mix with no
common prefix (`"  a"` / `"\tb"`) keeps the old one-unit reading. Both tests failed on the branch
before the change (the HTTP one: stored `"c\n    scheduled:: 2026-09-20\n    more c"`, no property).
Measured on a copy of the owner's graph with `tools/probes/block-update-content-indent-graph.mts`
(every live block as `page_read` prints it at depth 0/1/2, copied into `content`): the one-unit
reading changed the properties of **866** blocks at depth 1 and 2; the common-prefix reading
changes none at any depth. Its cost: 14 blocks whose every later line carries its own indent
(e.g. a packing list indented three spaces) lose that indent when copied — whitespace, where the
one-unit reading lost the same whitespace at depth ≥ 1 plus properties. mcp-tools.md §3.2 rule 10
updated.

---

### B-148 · An agent's bad date through `ui_run` comes back as "window did not respond in time", not the reason
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, verify-impl-dates · **Test:** none;
throwaway e2e probe (a `write --ui-control` token minted with `nooklet token create` against the
e2e server's temp data dir, `nooklet.live.controlEnabled` set in localStorage)

`ui.run {command_id: "task.setScheduled", args: "tomorrow"}` → 200 `ran`, stored `2026-09-14`;
`{date: "2026-12-24 09:00"}` and `{date: null}` work too. But `args: "banana"`, `"+10000y"` or `42`
→ **500 `internal`, `window "…" did not respond in time`, hint "the window may be busy … try
again"** after the RPC timeout, nothing stored. The command rejects as designed
(`task.ts#runDateCommand` / `host.ts#set` throw `"banana" is not a date …`), but
`live/message-handler.ts#handleIncomingFrame` just awaits `runCommand`, `live/socket.ts` only
sends a reply in `.then`, so a rejection sends nothing (and is an unhandled rejection in the
window), and `CommandRunResult` has no field for an error anyway. So the agent is told to retry
the very input that will fail again. Not specific to dates — any command that throws over
`ui_run` does this — but these are the first commands that reject an argument on purpose.

Fix direction (not done — the `/ui/live` protocol, client and server, ADR 015): reply
`command.result` with an `error` message when the run throws, and surface it from `ui.run` as an
`invalid` error rather than a timeout.

**Fixed 2026-09-13.** Both halves of the `/ui/live` protocol, as the entry's fix direction said.
Client: `apps/web/src/live/message-handler.ts#handleIncomingFrame` catches a rejection from
`runCommand` and replies `command.result` `{ request_id, error }` (the thrown message, capped at
1,000 chars; also recorded in the window's activity log), so `socket.ts` sends a reply and there is
no unhandled rejection. Server: `packages/server/src/live/run-remote-command.ts` turns a reply with
`error` into `invalid` — "task.setScheduled failed in window "…": "banana" is not a date …", hint
"change args (or command_id) rather than retrying as is", `details.reason: "command_failed"` —
which `ui_navigate`/`ui_highlight` inherit. mcp-tools.md §4.3.21's Errors list it. Tests that would
have caught it: `apps/web/src/live/message-handler.test.ts` › "answers command.run with
command.result carrying the error when the command throws" and "reports a non-Error throw, and cuts
a huge message to a bounded length" (both failed before: the handler rejected), and
`packages/server/src/live/ui-run-error.test.ts` (ui_run → 400 with the window's reason in well
under the 2 s timeout; same through ui_navigate; a normal result still relayed — the first two
failed before: 200 `unknown_command`). And the real thing, kept this time:
`e2e/tests/agent-ops.spec.ts` › "ui_run with args the command refuses answers invalid with its
reason, not a timeout (B-148)" mints a `write --ui-control` token with the CLI against the run's
data dir, turns control on in a real Chromium window, and sends `task.setScheduled` `"banana"` and
`42` (400 `command_failed` in under 1.9 s each, nothing stored), then a real date (200 `ran`,
stored). With the old `message-handler.ts` built into the client it failed exactly as reported:
500 `internal`, "window … did not respond in time", hint "try again".

---

### B-235 · `page.create` with markdown silently drops a page-properties pre-block
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, impl-small (seeding a locked page) ·
**Test:** none yet

`POST /api/v1/page.create {"name": "X", "markdown": "read-only:: true\n\n- a\n- b"}` creates the
page and both blocks, but no `read-only` page property — the pre-block is neither applied nor
reported. Seen in `e2e/tests/read-only.spec.ts`'s first draft (the page rendered 3 rows, no lock).
`prepareMarkdownInsert` (`packages/server/src/ops/outline-bridge.ts`) calls `parseMarkdownBlocks`,
which by its name takes blocks only; not traced further. An agent that writes outline markdown the
way the mirror does loses its page properties without an error. `page.append` goes through the
same function — presumably the same, not checked. Fix: apply the pre-block's properties as
`page.prop` ops (create), or reject/warn when markdown carries one.

**Fixed 2026-09-13.** Cause as logged: `prepareMarkdownInsert` kept `parseOutline(...).blocks` and
never looked at `.properties`. `page.append` and `block.insert` dropped a pre-block the same way
(confirmed: both returned 200 with nothing set, before the fix). Now
(`packages/server/src/ops/outline-bridge.ts#prepareMarkdownInsert(…, "accept" | "refuse")`):

- `page.create` on a new page applies the pre-block as `page.prop` ops right after its
  `page.create` op (explicit `properties` win for keys both give), and markdown that is only a
  pre-block creates the page with those properties and no blocks (it used to fail "markdown did not
  parse to any blocks").
- `page.append`, `block.insert` and `page.create` with `if_exists: "append"` on an existing page
  refuse one: 400 `invalid`, "markdown starts with page properties (read-only), which only
  page_create applies", hint pointing at `page_update` and at putting block properties under a
  bullet. Refused rather than applied because an append silently changing the page's own
  properties would be as surprising as dropping them, and a first bullet holding only property
  lines (`- type:: book\n- next`) is a pre-block to the parser — an agent that meant a block needs
  to hear that.

`MarkdownInput`'s description and mcp-tools.md §4.3.8–10 say so. Test that would have caught it:
`packages/server/src/ops/markdown-page-properties.http.test.ts` (7 of its 8 cases failed before the
fix — every one but "still takes block properties under a bullet"). In a browser:
`e2e/tests/agent-ops.spec.ts` › "page.create applies a markdown read-only:: pre-block: the page opens
locked (B-235)". `e2e/tests/read-only.spec.ts`'s `openLocked` still sets the lock through
`properties` with a comment citing B-235; left alone (another branch's spec; it works either way).

An ordering trap met on the way, recorded because the obvious code hits it: minting the block ops
before the `page.create` op (to fold the pre-block into its `properties`) gives the page a later HLC,
`applyOps` sorts by HLC, and every block is rejected for a page that does not exist yet.

---

### B-236 · `page.update` refuses to set properties on a journal day ("cannot rename a journal day")
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, impl-small · **Test:** none yet

`POST /api/v1/page.update {"page": "<ISO day>", "properties": {"read-only": "true"}}` → 400
`{"code":"invalid","message":"cannot rename a journal day"}` although no `new_name` was given.
`packages/server/src/ops/page-update.ts` throws for any journal page before looking at what was
asked. So an agent cannot favourite, give an icon to, or lock a journal day, while a person can (the
properties panel writes `page.prop` locally). Fix: move the journal check inside the
`new_name !== undefined` branch, plus a server test for a properties-only update on a journal.

**Fixed 2026-09-13.** `packages/server/src/ops/page-update.ts` refuses a journal day only when a
`new_name` is given that differs from the day's name; a properties-only update on a journal applies
its `page.prop` ops like on any page. The op description (and mcp-tools.md's copy) now says a
journal's properties can be set, and the refusal's hint says how. Test that would have caught it:
`packages/server/src/ops/page-update-journal.http.test.ts` — set and unset properties on a journal
day (with rebuild parity), a real rename still refused with nothing written, `new_name` equal to
the day's own name accepted (the first and third failed with "cannot rename a journal day" before
the fix). In a browser: `e2e/tests/agent-ops.spec.ts` › "page.update sets a property on a journal
day (B-236)" (a `read-only:: true` day shows the lock badge).

---

### B-172 · `block.update` with old_str/new_str rejects any block that has a property line or a second line
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, impl-journal (an e2e spec flipping
`TODO` to `DONE` on a task with `scheduled::` through the API) · **Test:** none yet; reproduced by
`tools/probes/block-update-property-roundtrip.ts`

`POST /api/v1/block.update {id, old_str: "TODO", new_str: "DONE"}` on the block
`- TODO buy milk` / `  scheduled:: 2026-09-13` answers 400 "content must describe exactly one
block". The same happens for a block whose content has two lines. The op's own description tells
agents to use old_str/new_str "for a small edit like flipping a marker", so an agent cannot finish
a dated task that way. Cause (read, and confirmed by the probe): `renderSingleBlockText`
(`packages/server/src/ops/outline-bridge.ts`) strips the two-space indent from continuation and
property lines, and `parseSingleBlockGrammar` prepends `- ` only to the first line, so the edited
text parses as a block followed by stray top-level lines. Probably the same for `content` given
with unindented property lines, which is how the spec describes the grammar. Workaround used in
`e2e/tests/journal-agenda.spec.ts`: `properties: { marker: "DONE" }`. Not fixed here (server op,
outside this branch's task).

**Fixed 2026-09-13.** Cause confirmed as logged: `parseSingleBlockGrammar`
(`packages/server/src/ops/outline-bridge.ts`) put `- ` before line 1 only, so the flush-left lines
`renderSingleBlockText` writes (the `before` text) parsed as top-level blocks of their own. It now
builds one real bullet (`singleBlockBullet`): the continuation indent goes before every later
non-empty line. Two readings, chosen by the caller (`block-update.ts`): `old_str`/`new_str` edit
the `before` text, which is always flush (`"flush"` — any indent is the content's own);
`content` is `"auto"` — flush, unless every later non-blank line starts with two spaces or a tab,
which is `page_read`'s shape and the only multi-line shape `content` parsed before (kept working
so an agent's indented `scheduled::` line does not silently become text; the cost, recorded in
mcp-tools.md §3.2 rule 10: a content whose every later line really starts with two spaces loses
them). Tests that would have caught it: `packages/server/src/ops/outline-bridge.test.ts` ›
"single-block text round trip (B-172)" (render → parse for property lines, `done::` + priority,
multi-line, an indented line, a fence holding `- x` and `key:: v`, a fence-first block with a
property, `collapsed`; marker flip; both readings; nested bullets still refused — 11 of its 13 fail
on the old code), and `packages/server/src/ops/block-update-text.http.test.ts` (the real route:
TODO→DONE by `old_str` with `scheduled::`, DONE→TODO clearing `done::`, second-line edit, edit
inside a fence, fence-first block with a property, flush and indented `content`, nested bullet
hint, rebuild parity). `tools/probes/block-update-property-roundtrip.ts` now prints "ok" for all
three cases. `e2e/tests/journal-agenda.spec.ts`'s `properties: { marker: "DONE" }` workaround is
left as it is (it works either way).

Second cause, found while fixing B-235 and fixed in its commit: a block with **empty content and
only property lines** (10 such blocks in the owner's graph) still failed, because as the first
bullet of the parsed text it is exactly what the parser reads as a page-properties pre-block (OUT-2)
— no block came back, and its `collapsed` was lost with it. `parseSingleBlockGrammar` now parses
behind a throwaway first bullet (`- -`) and takes the second block. Tests: the round-trip case "an
empty block with only properties, collapsed" in `outline-bridge.test.ts` (failed "content must
describe exactly one block" before) and "edits an empty block that has only a property line (not a
page pre-block)" in `block-update-text.http.test.ts`.

In a browser: `e2e/tests/agent-ops.spec.ts` › "block.update flips TODO to DONE by old_str on a
scheduled task, and the row follows (B-172)". On real data: `tools/probes/single-block-roundtrip-graph.ts`
over a copy of the owner's graph — of 18,628 live blocks, the pre-fix parser refused **1,929** (every
block whose before-text has a second line); now 0 are refused and every block's content, marker,
priority, properties and collapsed survive the round trip, except the 20 blocks that still hold a
literal `SCHEDULED: <…>` line from the pre-B-266 import: re-parsing reads that line as `scheduled::`
(what the same text in a file means), so an `old_str` edit of one of those blocks moves the date into
the property. Those blocks were uneditable this way before; their repair is already an open owner
decision. Real edits through `nooklet serve` on that copy (DONE→LATER→DONE on a scheduled task,
a multi-line block with properties, an empty block with only properties, a fence-first block given a
property then edited inside the fence): all as expected, and `nooklet verify` OK afterwards
(20,442 ops).

---

### B-151 · A block that opens with a code fence loses its properties when serialized without ids
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, writing `core/block-text.ts` (B-101) ·
**Test:** none yet; `tools/probes/serialize-fence-props.ts` reproduces it

`serializeOutline(page, { ids: "none" })` writes a block's property lines straight after its first
line. When that line opens a fence (```` ```js ````), the property lines land inside the fence and
re-parse as code: `- ```js\n  foo:: bar\n  code\n  ```` comes back with `properties: {}` and the
`foo:: bar` line in the code. With ids (the mirror's default) OUT-14 puts `^id` alone on line 1 and
the round trip holds, which is why the mirror never showed it. Callers with `ids: "none"`:
`BlockTree.tsx`'s `block.copySelection` (copy then paste loses the property) and the server's
`outline-bridge.ts#renderSingleBlockText` (the before-text `block.update` matches `old_str`
against). `core/block-text.ts#joinBlockText` avoids the same trap by writing such a block's
properties after the closed fence. Fix: the same placement in `serializeOutline`.

**Fixed 2026-09-13.** `packages/core/src/outline.ts#serializeOutline`: a block with no id to put
alone on line 1 (OUT-14), no marker/priority, and a line 1 that opens a fence now gets its property
lines after the content when every fence in it closes (`fencesClosed`, the parser's own fence
tracking), otherwise as the bullet line itself (`- foo:: bar`, the fence opening on line 2) — the
two placements `block-text.ts#joinBlockText` already used. Both parse back with no parser change
(the parser takes a property line anywhere outside a fence); markdown-grammar.md OUT-18 records the
exception. Blocks with an id (the mirror) are unchanged. Tests that would have caught it:
`packages/core/src/outline.test.ts` › "a block that opens with a fence, without ids (B-151)" (closed
fence with a property-looking line inside and `collapsed`, unclosed fence, and no-properties
unchanged). `tools/probes/serialize-fence-props.ts` now prints the properties back for both modes.
Found in passing: B-310 (the same block with a marker). In a browser (added while verifying):
`e2e/tests/agent-ops.spec.ts` › "copying a fence-first block with a property and pasting it keeps
the property (B-151)" — Cmd/Ctrl+C, the clipboard text, a paste, the pasted block's stored
properties; with cf08d19's `outline.ts` built into the client it fails at the clipboard (the
property line inside the fence).

---

### B-364 · `BlockTree.tsx`'s header says `{{embed}}` renders a placeholder
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, merge-resolution review (F5) ·
**Test:** none (comment only)

The header's "Known data-seam gaps" says `{{embed}}` renders a placeholder rather than a live tree,
pointing to `render/tokens.tsx`. Embeds render their target read-only through `EmbedView` since
B-210; the impl-render merge rewrote the sentence before impl-embeds landed.

**Fixed 2026-09-13.** The header now names one gap, `.vr-ref-new` (still true: nothing in
`apps/web/src` emits the class, only `editor.css` styles it), and says embeds render read-only
through `render/EmbedView.tsx`, as `render/tokens.tsx` does. No test: a comment.

---

### B-363 · Printing with the find bar open prints the bar and only the matching blocks
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, merge-resolution review (F4) ·
**Test:** `e2e/tests/page-export.spec.ts` "printing with find in page open prints the whole page and
no find bar"

With find in page open and a query typed, Print page (menu, palette, or Cmd/Ctrl+P) puts the find
bar on paper above an outline cut down to the matches and their (faded) ancestors; collapsed
children are not expanded either.

`BlockTree`'s rows are `filtered()?.rows ?? flattenVisible(…, {expandAll: isPrinting()})`, so an
active filter wins over printing (B-221 and find in page met in a merge), and `print.css` hides the
page's other controls but not `.page-find`. The in-text find marks (CSS highlights) kept their
tint under the print palette too.

**Fixed 2026-09-13.** Printing wins: `BlockTree`'s `filtered` memo is off while `isPrinting()`, so
the rows are the whole page with collapsed children expanded and no match/context classes;
`afterprint` brings the filter back unchanged. `print.css` hides `.page-find` and makes both find
highlights transparent. The e2e test reads the DOM from a `beforeprint` listener around a real
`page.pdf()`. It failed first at each part: the bar visible under print media; with only the CSS
fixed, the printed rows were `parent of apple`, `hidden child` with one context and one match row;
the highlight backgrounds under print media were the find colours
(`color(srgb 0.54 0.36 0 / 0.28)`).

---

### B-362 · Cmd/Ctrl+Z on a page that was just locked still undoes into it
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, merge-resolution review (F3) ·
**Test:** `e2e/tests/read-only.spec.ts` "after a page is locked, Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z no
longer write to it (B-362)"

Edit a block, then have the page locked (`read-only:: true` from the properties panel, another
device, or an agent). Editing ends, as B-234 intends. Now press Cmd/Ctrl+Z with focus on the page:
the last edit is reverted and written to the locked page.

Undo after a session ends goes to the most recent tree (B-241, `historyEditorHost`), and with no
editor and no selection `BlockTree`'s host calls `doUndo()`/`doRedo()`, which never check the lock.
The lock's own guard is in `onContainerKeyDown`, which this path does not pass through.

Seen in the browser before the fix: the undo reverted `editable text` to `editable` on screen and
on the server (`page.read`), and put an editor back into the locked block; a redo did the same with
`editable text more`.

**Fixed 2026-09-13.** `doUndo` and `doRedo` refuse on a locked page and show the read-only notice,
as the tree's other writers do. The e2e test failed first — against the unfixed build at the undo
(`editable`), and with only the redo guard removed at the redo (`editable text more`) — and passes
with both guards.

---

### B-361 · Escape from find in page puts the caret back in the wrong place in a block with properties
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, merge-resolution review (F2) ·
**Tests:** `e2e/tests/page-find.spec.ts` "Escape puts the caret back in the same place in a block
that shows a property line (B-361)"; `apps/web/src/app/page-find.test.ts` "puts back a content
offset when the editing buffer shows property lines (B-361)"

Edit a block that has a property line, put the caret anywhere below its first line, press
Cmd/Ctrl+F, then Escape: the caret comes back further along than it was — by the length of the
property lines — or at the end of the block.

`openPageFind` stores `editing.end` as the caret to return to. That is an offset into the CM6
buffer (property lines included, B-101); on Escape the tree maps it into the buffer a second time
as if it were an offset into the content (`caretInEditText`). Find in page was written before
B-101 existed on its branch.

**Fixed 2026-09-13.** `openPageFind` takes the editor's whole selection and saves
`contentOffsetOf(content, end)`, a content caret, which is what a focus request carries
(`CommandLayer` already passed the full selection, so it is unchanged). Both tests failed first:
the unit case got `{offset: 31}` for 17; in the browser the caret came back at 41 instead of 31
(`first line` / `list:: number` / `second| line here`).

---

### B-360 · `/template` into an empty bullet that has a property puts the caret in the property line
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, merge-resolution review (F1) ·
**Test:** `e2e/tests/templates.spec.ts` "/template into an empty numbered item: what is typed next
extends the text, not the list property (B-360)"

Pick a template with `/template` in an empty numbered item (`list:: number`), or in any empty
bullet with a property line, and type: the characters go into the property's value, not after the
template's text. `list:: number` becomes `list:: numberx`, the item stops being numbered, and the
typed text is not in the block's content.

`BlockTree.runStructural`'s branch for a batch whose focus stays on the block being edited (B-108)
calls `surface.setCaret(res.focus.caret)` with a content-relative caret. Since B-101 the buffer
holds property lines after line 1, and `{at: "end"}` becomes the end of the buffer — the end of the
last property line. The impl-render merge converted `doUndo`/`doRedo` to `bufferCaret()` but not
this branch, and dropped the B-154 unit assertions on the caret instead of porting them.
`docs/BUGS.md` B-154's "through `onContent` … the caret ends after the text" no longer describes
the code (the text now arrives as a `block.text` op in a `commitOps` batch).

**Fixed 2026-09-13.** The same-block branch maps the caret into the buffer with `bufferCaret()`, as
`doUndo`/`doRedo` do. The e2e test (seed `- first` / `list:: number`, Enter, `/template` daily, type
`!`) failed first against the unfixed build — stored `{content: "Daily plan for [[Sep 13th,
2026]]", properties: {list: "number!"}}` — and passes with the fix. **For the coordinator:** B-154's
Fixed paragraph in `docs/BUGS.md` should say the template's text arrives as a `block.text` op in a
`commitOps` batch (not through `onContent`), and that the caret after it was wrong until B-360.

---

### B-368 · "Export page as markdown" names a long page's file differently from the mirror, and leaves out its title
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, merge review of server/core (F4) ·
**Test:** `packages/core/src/sync/page-outline.test.ts` "shortens a name past NAME_MAX to a prefix
and a hash, as the mirror names its file (B-368)", "puts the full name in title:: when, and only
when, the file name was shortened (B-368)";
`packages/server/src/mirror/export.test.ts` "the web export's file name and text are the mirror's,
long names included (B-368)"; `e2e/tests/page-export.spec.ts` "Export of a page whose name is past
NAME_MAX downloads the mirror's shortened file, title:: included (B-368)"

For a page whose name is longer than the mirror's 200-byte file-name limit (B-126) — easy with
`block.to_page`, which names a page after a block's first line — the web client's Export page as
markdown suggests a file name of the full, unshortened name (352 bytes for a 300-character Czech
name, past the 255-byte limit of APFS and ext4), while the server's mirror writes
`…oznámky z porady o~30f11c5a.md` with a `title::` line carrying the full name. The download has
no `title::`. `page-export.ts` promises the mirror's file "byte for byte", and core's
`pageMirrorPath` says the download and the mirror "carry the same name"; for such a page neither
is true, and a browser that cuts the over-long name leaves a file whose name no longer says what
the page is called.

Cause: the B-126 fix (security branch) shortened names in the server's own `pageFilePath` and
injected `title::` in `exportPage`; the impl-export branch had made the server call core's
`pageMirrorPath`. The merge kept the server's copy, so core's function — now used only by the web
export — never learned the limit.

**Fixed 2026-09-13.** One implementation, in core: `pageMirrorPath` shortens past 200 UTF-8 bytes
(code-point-safe, never inside a `%XX` escape, as B-126 did) and the new `pageMirrorOutline` adds
the leading `title::` for a shortened name. The server's `exportPage` and the web's
`renderPageMarkdown` both call them; the server's private `pageFileBase`/`pageFilePath` are gone.
The download gets `title::` (it is the mirror file); "Copy page as markdown" does not, having no
file name to have lost the page's name from. The suffix hash changed from the first 8 hex of
`sha256(name)` to 32-bit FNV-1a of the name's UTF-8 bytes, because core runs in the browser too,
where the only SHA is async (`crypto.subtle`). A mirror file shortened under the old suffix is
renamed on its next export by `exportPage`'s path-change cleanup; the owner's graph has none
(`nooklet export` of a copy: 952 pages, `failed: []`, 0 shortened names, longest file name 114
bytes). Tests that would have caught it: `core/src/sync/page-outline.test.ts` "shortens a name past
NAME_MAX to a prefix and a hash, as the mirror names its file (B-368)" (failed at `cf08d19`: the
path had no suffix) and "puts the full name in title:: when, and only when, the file name was
shortened (B-368)"; `server/src/mirror/export.test.ts` "the web export's file name and text are the
mirror's, long names included (B-368)"; `e2e/tests/page-export.spec.ts` "Export of a page whose
name is past NAME_MAX downloads the mirror's shortened file, title:: included (B-368)" — with the
three source files at their pre-fix versions Chromium suggested the full 345-byte name while the
mirror wrote `…čtvrtlet~6d458ccb.md`.

---

### B-369 · A keep_later_edits undo says "restored page "Old name"" for a page it left renamed or in the trash
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, while checking B-366 on a copy of the
real graph (`tools/probes/undo-names-real-graph.ts`) · **Test:**
`packages/server/src/ops/batch-undo-later-edits.http.test.ts` "the outline names a page as the undo
leaves it, not as it was before the batch (B-369)"

Set a property on "Plánování zahradních úprav", rename the page to "Plánování (přejmenováno)",
then undo the property change with `keep_later_edits` (History's Undo): the call succeeds, the page
keeps its new name, and the outline — the text an agent reads, and the MCP tool result — says
`restored page "Plánování zahradních úprav"`. Likewise for a page deleted since: `restored page
"Garden"` while Garden stays in the trash. The summary line names the before-image's name whenever
the undo wrote any op for the page, whatever it left the name and tombstone as.

**Fixed 2026-09-13.** The line uses the name the undo leaves the page with (B-366's `pagePlan`),
and says `(in the trash)` when the page stays there. Without `keep_later_edits` nothing changes for
a live page: the rename is undone too and the old name is the right one. Test that would have
caught it: `ops/batch-undo-later-edits.http.test.ts` "the outline names a page as the undo leaves
it, not as it was before the batch (B-369)" (said `restored page "Named Before"` before).

---

### B-367 · Undoing a page delete takes the name back from a live page's alias
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, merge review of server/core (F3) ·
**Test:** `packages/server/src/ops/batch-undo-alias.http.test.ts`

Delete page "Alex", add `alias:: Alex` to "@Alex", then undo the delete (History's Undo, or
`batch_undo` with the delete's `batch_id`): "restored page "Alex"". `page.read Alex` now returns the
restored page instead of "@Alex", and every `[[Alex]]` link goes there — the harm B-256 fixed for
the Trash view. `trash.restore` of the same page is refused with 409 "a live page, "@Alex", uses
"Alex" as an alias"; the undo is not.

Cause: B-256 added the alias check to `trash.restore` (`assertNameFree`) while another branch added
a parallel "restored name must be free" pre-check to `batch.undo`, copied from `trash.restore`'s
older key-only check. The merge kept both and gave the alias half to `trash.restore` only. Undoing
a `page.merge` itself is not affected: the merge adds the alias in the same batch, so its undo
removes it again — unless `keep_later_edits` keeps a later change to that alias.

**Fixed 2026-09-13.** `batch.undo`'s pre-check refuses a page name that a live page uses as an
alias, with the same `conflict` as a taken name ("cannot restore page "Alex": a live page,
"@Alex", uses "Alex" as an alias"), through `trash-restore.ts#livePageAliasing`, now exported and
taking a list of pages to leave out. Two things the reviewer's suggested fix ("exclude pages in the
batch") would have got wrong, both tested: a page the batch touched is judged by the aliases the
undo leaves it, not skipped — undoing a merge removes the alias the merge added, but with
`keep_later_edits` a later edit of that alias is kept and still shadows the restored page; and an
undo that moves no name (the page is live under the same key before and after) is not refused over
an alias that page already shadowed, which `page.create` allows. Test that would have caught it:
`ops/batch-undo-alias.http.test.ts` (4; the delete-then-alias case and the kept-alias merge case
answered 200 before this fix, at `d4f1335`; the other two guard the exemptions).

---

### B-366 · History's Undo is refused over a page name the undo would not touch
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, merge review of server/core (F2) ·
**Test:** `packages/server/src/ops/batch-undo-later-edits.http.test.ts` "a later rename or delete
it keeps does not make the undo fight over the page's old name (B-366)";
`ops/undelete-collision.http.test.ts` "batch.undo of a restore under new_name, after the old name
was taken, is conflict (B-366)"

Set a property on page "Alpha", rename the page to "Beta", create a new "Alpha", then Undo the
property change from History: "cannot restore page "Alpha": a live page is already named "Alpha"",
and nothing is undone. The undo would only have removed the property — History sends
`keep_later_edits`, which leaves the later rename alone — so there was nothing to collide with.
The same happens when the page was deleted after the change and its name reused: the page would
stay in the trash, yet the undo is refused.

Cause: `batch.undo`'s "is the restored name free" pre-check (added for B-90) compares the page's
name and tombstone from *before* the undone batch with live pages, and runs without asking which
fields `keep_later_edits` (B-251) will leave as they are. The two landed on parallel branches and
neither tested both.

**Fixed 2026-09-13.** `batch.undo` works out, once per page, what the undo will leave: the name
(the before-image's, or the current one when a later rename is kept), the tombstone (likewise),
and whether it writes a `page.rename` at all. The pre-check and the op builder both read that, so
the check asks about the name the undo actually claims. Doing only that (the reviewer's suggested
fix) was not enough for the delete case: the undo still wrote `page.rename` to the page's own name
on a page that stays in the trash, and core rejects any rename onto a key a live page holds, trashed
page or not — the call went from 409 to 400 with nothing undone. Such a rename is now not written;
it would have restored nothing. Side effect, tested: undoing a `trash.restore … new_name` after the
old name was taken again answered 400 `page-key-collision` from core, and now answers the
pre-check's 409 conflict. Tests that would have caught it:
`ops/batch-undo-later-edits.http.test.ts` "a later rename or delete it keeps does not make the undo
fight over the page's old name (B-366)" (409 at `cf08d19`) and `ops/undelete-collision.http.test.ts`
"batch.undo of a restore under new_name, after the old name was taken, is conflict (B-366)" (400 at
`cf08d19`).

---

### B-365 · The live mirror never retries a page file it failed to write
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, merge review of server/core (F1) ·
**Test:** `packages/server/src/mirror/live.test.ts` "retries a page it could not write on the next
sweep, without that page changing again (B-365)"

While `nooklet serve` runs, a page whose `.md` could not be written (a full disk, a permission
error, a sync client holding the file) stays missing from `pages/` until that page is edited again
or the server restarts. The log says "could not write 1 page file(s), will retry after the next
commit", and the next commit's sweep writes the other page it touched but says nothing about the
failed one and never tries it again. On a full disk every page in the sweep fails, so all of them
are dropped silently.

Cause: two fixes merged into one. B-126 made `exportAll` catch a page's write error and report it
in `failed` instead of throwing; B-260 made the sweep follow a `changes.seq` cursor and move it to
the head whenever `exportAll` returns. Each was right alone (before B-126 the throw kept the cursor
where it was; before B-260 the `updated_at > written_at` test picked the page again). Together, a
failed page falls behind the cursor, and later sweeps only look at pages touched after it.

**Fixed 2026-09-13.** The live mirror keeps the ids of the pages the last sweep could not write
and passes them to the next one (`exportAll`'s new `alsoPageIds`, candidates on top of the pages
touched since the cursor); the cursor still moves to the head. Rejected: leaving the cursor where
it was while anything failed (the reviewer's smallest version). One page that can never be
written (a directory in its place, a read-only file) would then pin the cursor, and every sweep
would re-render every page touched since, for as long as the server runs. With the carry-over a
page that keeps failing costs one render per sweep and is logged every time, and the log line's
"will retry after the next commit" is true. The test that would have caught it:
`mirror/live.test.ts` "retries a page it could not write on the next sweep, without that page
changing again (B-365)" — it failed at `cf08d19` on the second sweep, which logged nothing about
the page.

---

### B-326 · Any page written anywhere rebuilds a missing page's references panel: "Loading references…" and the scroll jumps to the top
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, adversarial verification of
`m9/render-views` · **Test:** `e2e/tests/render-views.spec.ts` ("a page that does not exist yet
keeps its references panel, and its place in it, when another page is written")

Reproduced in Chromium (production build, this branch) before touching anything: on
`/page/RVZ Scroll Target` (not created; 6 pages × 4 blocks link to it), scrolled 623 px down the
linked references in `.page-scroll`, one `page.create` of an unrelated page through the API — what
an agent or another device does — removed and re-added `.page-view-missing` and
`.references-panel` (a MutationObserver saw both), showed "Loading references…" again, and left
`.page-scroll` at 0. Three writes, three rebuilds.

Cause: `PageView.tsx` shows the missing view under `!page.loading && page() === null`, and
`usePageByName` refetches — `loading` true — on every write to the `page` or `page_prop` table,
whatever page it was. The existing-page view avoided exactly this (`<Show when={page()}>`, B-201's
same-object return); the missing view never had to, because until B-200 it held only a heading and
a button, whose rebuild nobody could see. B-200 put a fetched, scrollable, stateful panel inside
it.

**Fixed 2026-09-13.** `PageView.tsx` remembers the route name the lookup last settled for (an
effect, so it never sees a new name before that name's lookup has flagged itself loading) and keeps
the missing view up through a refetch for that same name: `page() === null && !renaming() &&
(!page.loading || settledName() === name)`. A new name still waits for its own answer. The e2e
scrolls a missing page's linked references, marks the panel element, writes a page through the API
that tags the target (so the panel listing it proves the write arrived), and asserts the same panel
element, no "Loading references…" and the scroll kept; it failed on the branch before the fix
(`samePanel: false, loadingSeen: true`) and passes. It then navigates to a linking page and back.
Also re-run: render-views(+phone), journal-agenda, journals, page-identity, page-rename, pages,
parity, references, references-cap, references-filters, tagged-pages, navigation, page-title-draft,
link-unlinked, trash, follow-link, history — 89 passed.
Real graph (same probe): `/page/book` scrolled, one unrelated `page.create` — same panel element,
no "Loading references…", scroll kept.

---

### B-325 · Clicking the empty line of a multi-line block puts the caret at the end of the block
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, adversarial verification of
`m9/render-views` · **Test:** `e2e/tests/render-views.spec.ts` ("clicking the empty line of a
multi-line block puts the caret on that line, not at the block's end"),
`apps/web/src/editor/caret.test.tsx` ("a point between a paragraph's children on an empty line…")

B-224's fix renders an empty line inside a block (`alpha\n\ngamma`) as two `<br>`s, and gives each
`<br>` its newline's offsets with the comment that "a click beside it resolves to a caret offset
(`../caret.ts`)". It does not. Measured in Chromium (production build, this branch): anywhere on the
empty line `caretRangeFromPoint` answers `(P, 2)` — a position between the paragraph's children,
before the second `<br>`, since there is no text node on that line to land in. `caret.ts` only walks
UP from the node it is given to the nearest `[data-from]`; a `<p>` has none, so
`resolveClickOffset` returned `null` and `BlockRowView` fell back to `content.length`. Clicking the
empty line and typing "beta" stored `alpha\n\ngammabeta`. Before B-224 the empty line was not drawn
at all, so this is new with the fix. The owner's graph has 214 non-fence blocks with an empty line
(sqlite backup, `content like '%\n\n%'`).

**Fixed 2026-09-13.** `caret.ts#offsetBetweenChildren`: when the hit test answers a position
between an element's children, the child just after it gives its `data-from` (or, at the end, the
child just before gives its `data-to`); only when neither carries offsets does the old walk-up run.
The e2e clicks the empty line of three blocks — plain, Czech with hidden `**` markup, and one with
a property line (whose editing buffer puts `rvblank:: ano` after the first line, B-101) — types, and
reads the stored blocks: on the branch before the fix all three got the text appended at the end
(`gammabeta`, `konecstřed`, `druhýprostřední`); with it they read `alpha\nbeta\ngamma` and so on.
The unit test stubs `caretRangeFromPoint` with the measured `(P, 2)` answer; it failed before
(`null`). The text-node path is unchanged (`focus.spec.ts` "clicking inside a word…" still passes).
Real graph (sqlite backup, production build, `tools/probes/render-views-blank-line-real-graph.mjs`):
clicking the empty line of `2022-12-02`'s block `1m287mdbejacmc` (`🧵🐁🐀\n\nA problem…`, 6
`<br>`s for 6 newlines, surrogate-pair emoji before the break) and typing put the marker at offset 7,
on the empty line.

---

### B-171 · The Tasks view's due-date window ignores a deadline when the task is also scheduled
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, impl-journal (reading
`views/taskFilters.ts` for reuse) · **Test:** none

`filterTasks`' "Due from / Due to" compares `due_day`, which is `coalesce(scheduled_day,
deadline_day)`. A task scheduled 2026-09-01 with a deadline of 2026-09-20 is invisible to a
2026-09-15..2026-09-25 window even though its deadline falls inside it. Not fixed on this branch
(the Tasks view is outside the task); the journal agenda does not reuse `filterTasks` for this
reason and matches both columns.

**Status:** fixed · **Test:** `e2e/tests/render-views.spec.ts` ("the Tasks view's due window finds a
deadline on a task that is also scheduled"), `apps/web/src/views/taskFilters.test.ts` ("the due
window looks at the scheduled date AND the deadline", 4 cases)

**Fixed 2026-09-13.** `views/taskFilters.ts#inDueWindow` matches when the scheduled date or the
deadline lies in the window, one date satisfying both bounds (a task scheduled before a window with
its deadline after it is not in it); `filterTasks` uses it instead of comparing `dueDay`. The e2e
seeds three tasks in 2031 — scheduled 03-01 with deadline 03-20, scheduled 03-18, scheduled 03-01
only — and sets the window 03-15..03-25 in the real Tasks view: 2 rows expected; on `cf08d19`'s
`taskFilters.ts` it got 1 (the deadline task missing). The unit cases "a deadline inside the
window…" and "an open-ended bound…" failed before. The existing fixture task that had only
`dueDay` now also carries the `scheduledDay` it would have in real data. Left as it was: the row's
date label (B-324).

---

### B-200 · A page that does not exist yet shows none of its references
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, building B-111 · **Test:** none

Open `/page/book` on a graph where pages carry `tags:: book` (the owner's has one) or where blocks
say `[[book]]`, but no `book` page was ever created: the view says "This page doesn't exist yet"
and a Create button, and nothing else. `page.backlinks {target: "book"}` answers with the linked
references and, since B-111, the tagged pages — the server deliberately handles a not-yet-created
target (see the comment in `ops/page-backlinks.ts`) — but `PageView.tsx` only mounts
`ReferencesPanel` inside the `page()` branch. In a wiki a referenced-but-uncreated page is a normal
thing to open, and its references are the reason to open it. Likely fix: mount
`<ReferencesPanel target={props.name()} …>` under the missing-page message too. Not done here:
it changes the missing-page view another branch (`m8/qafix-render-sync`) is editing, and whether an
uncreated page should show references is a product call.

**Status:** fixed · **Test:** `e2e/tests/render-views.spec.ts` ("a page that does not exist yet
shows what links to it and what is tagged with it", "a journal day nobody has written shows the
links to it, whatever date format the URL uses")

**Fixed 2026-09-13.** `PageView.tsx`'s missing-page branch mounts `ReferencesPanel` under the
"doesn't exist yet" message (and the agenda, for a date), so a referenced-but-uncreated page lists
its tagged pages and linked references the way Logseq does — the product question the entry left
open was settled by the brief ("that is how Logseq behaves"). Two details: the target is
`canonicalRefName(name)`, because references to a day are indexed under its ISO name and the
server's missing-page branch matches the raw title (B-322 — with the raw name the date test failed,
"received []"); and the panel gets `unlinked={false}`, a new `ReferencesPanel` prop, because its
"Link all" runs `mentions.link`, whose `requirePage` would only answer 404 for a page that does not
exist. Once Create is pressed the ordinary view's panel, unlinked half included, takes over (checked
in the same e2e). The first test cannot pass on `cf08d19` — nothing under the missing view rendered
a panel. Real graph (backup copy, `tools/probes/render-views-real-graph.mjs`): `/page/book`, which
the owner never created, now shows "Pages tagged book" 1 and "Linked references" 9 with 9 rows —
exactly `page.backlinks {target: "book"}`'s `tagged_total` 1 and `linked_total` 9 — and no unlinked
section.

---

### B-225 · The page title row's History link and empty icon slot cannot be discovered on a phone
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, while placing the page actions in the
same row · **Test:** none

`.page-history-link` and `.page-icon-button-empty` (`styles/views.css`) are `opacity: 0` until the
title row is hovered or the control has keyboard focus. A touch screen has no hover, and unlike
`.all-pages-star` (`views/all-pages.css`) there is no `@media (pointer: coarse)` rule revealing
them, so on a phone the History link is an invisible tap target that still takes ~60px from the
title. The page actions star and "…" button added for B-220–B-222 are always visible on purpose.

**Fixed 2026-09-13.** With B-350: on a screen without hover (`@media (hover: none)`) the History
link and the empty icon slot are `display: none` instead of invisible tap targets taking ~94px of
the title row, and the page "…" menu (`views/PageActions.tsx`) carries "Add icon" / "Change icon"
(opens the row's own icon editor through `PageIcon.tsx#requestPageIconEdit`) and "Page history" on
every device. Test that would have caught it: `e2e/tests/page-title-fit.spec.ts` "a 17-character
name fits on one line: the hover-only controls take no room" and "the page's history and a new icon
are in the … menu instead" (both failed before).

**Status:** fixed · **Test:** `e2e/tests/render-views-phone.spec.ts` ("a phone's title row has no
invisible controls; History and Add icon are in the … menu"), `e2e/tests/render-views.spec.ts` ("on
a desktop the title row keeps History and the icon slot behind hover; the menu has both")

Measured before fixing (iPhone 13 descriptor, production build, `cf08d19`): in a 366 px title row
the invisible empty icon slot took 39 px and the invisible History link 55 px, leaving the title
input 164 px; forcing both visible showed the name clipped to "RV Phone Prob".

**Fixed 2026-09-13.** Revealing both on a coarse pointer (the `all-pages.css` recipe) would have
made them reachable but kept the title at 164 px, so instead: under `@media (pointer: coarse)`
`views/page-actions.css` takes `.page-history-link` and `.page-icon-button-empty` out of the row
(`display: none`; a page that has an icon keeps it, it was never hidden), and the "…" page actions
menu gains "Page history" (a link to `/history/<name>`) and, while the page has no icon, "Add icon",
which opens the row's own editor through `views/page-icon-request.ts` (a page-id-keyed signal the
editor consumes). The menu items are there on a desktop too; the desktop row is unchanged (hover
reveal, checked by the desktop e2e). One hookup line in `PageView.tsx` passes `pageId` and `icon` to
`PageActions`. The phone e2e taps through both menu items and checks the title now takes over 60% of
the row; with the old `page-actions.css` it failed at "History link hidden" (received: visible —
an opacity-0 element is a live tap target). Ran under the descriptor's own engine, as
`phone.spec.ts` does; not tried on a physical iPhone, where focusing the icon input from a menu tap
depends on WebKit's user-gesture rule.

---

### B-321 · A journal agenda item carries `data-block-id`, so reveal and the agent flash can land on it
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, `grep data-block-id` while
fixing B-211 · **Test:** `apps/web/src/views/JournalAgenda.test.tsx` ("a row click navigates to
the task, a heading click to its page")

Same trap as B-211. `views/JournalAgenda.tsx#EntryRow` puts `data-block-id="<task id>"` on each
`li.journal-agenda-item`. On the journal stream (`JournalStreamView.tsx`) Today's agenda is
rendered after Today's outline and before every older day's, so a task written on an older day and
scheduled for today appears in document order before its real row: `shell/Shelf.tsx#revealOnPage`
and `live/RemoteFlashOverlay.tsx#findBlockRow` (`document.querySelector('[data-block-id=…]')`)
pick the agenda entry. Nothing reads the attribute on the agenda item.

**Fixed 2026-09-13.** The item is marked `data-agenda-block-id`. The component test asserts no
`[data-block-id]` in the rendered agenda (failed before) and the new attribute's value. Believed
rather than browser-verified for the stream ordering itself: no e2e seeds a task on an older journal
day scheduled for today (journal-day offsets are shared across specs), and the agent flash has no
browser-side trigger short of a plugin; `e2e/tests/journal-agenda.spec.ts` still passes (6/6).

---

### B-320 · A plugin-drawn fence inside an embedded block is handed the host block, not its own
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, reading `PluginFence.tsx`
while fixing B-211 · **Test:** `apps/web/src/editor/render/PluginFence.test.tsx` ("a fence inside
an embedded row / a query result is handed that block, not the host row's")

Not reproduced in a browser — found by reading. `render/PluginFence.tsx#fenceContext` finds the
fence's block as `el.closest("[data-block-id]")`. An embedded row (`EmbedView.tsx`) deliberately
carries `data-embed-block-id` instead, so a ```` ```mermaid ```` fence inside an `{{embed}}`
walks past its own row to the outliner row that holds the embed, and the renderer's
`RenderInfo.block`/`page` describe the host block and page. The B-211 fix moves query hits off
`data-block-id` too, which would give fences inside query results the same wrong answer (today they
get the right one, by the very attribute that causes B-211).

**Fixed 2026-09-13.** `fenceContext` looks for the nearest
`[data-query-hit-id], [data-embed-block-id], [data-block-id]` and reads whichever of the three the
match carries. The component test renders a fence inside an `li` carrying each inner attribute,
inside a `[data-block-id]` host: the embed case failed before (renderer got `bhost000000001`);
both pass. Not checked in a browser with a real mermaid plugin inside an embed —
`e2e/tests/plugins.spec.ts` (outliner rows only) still passes.

---

### B-211 · A ```` ```query ```` result on the same page can be scrolled to instead of the real row
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, reading `data-block-id` users while
building embeds · **Test:** —

Not reproduced in a browser — found by reading. `render/QueryFenceView.tsx#HitView` puts
`data-block-id="<id>"` on every result row, the same attribute the outliner's rows carry
(`BlockRowView.tsx`). `shell/Shelf.tsx#revealOnPage` and `live/RemoteFlashOverlay.tsx` both find a
row with `document.querySelector('[data-block-id="…"]')`, which returns the first match in document
order. A query block above its own results on the same page (a page of tasks with a
`TODO` query at the top) therefore makes "reveal this block" from the shelf outline, and an agent's
change flash, land on the result inside the query instead of on the block. Fix: a distinct
attribute on hits (`data-query-hit-id`), as embedded rows use `data-embed-block-id`.

**Status:** fixed · **Test:** `e2e/tests/render-views.spec.ts` ("revealing a block lands on its
row, not on a query result above it"), `apps/web/src/editor/render/render-seams.test.tsx` ("lists
hits grouped by page with a count…")

Reproduced in a browser before fixing (Chromium, production build, `cf08d19`'s
`QueryFenceView.tsx`): a page whose first block is a ```` ```query TODO tag:rvreveal ```` fence
and whose third is the matching task. Shelving the page, switching the card to its outline and
clicking the task's entry put `shelf-reveal-target` on the `li.vr-query-hit` and never on the
task's `.vr-row`; `document.querySelectorAll('[data-block-id=<id>]')` returned
`["vr-query-hit", "vr-row"]`, in that order.

**Fixed 2026-09-13.** `QueryFenceView.tsx#HitView` marks a result `data-query-hit-id`, the way
embedded rows already use `data-embed-block-id`, so `[data-block-id]` only ever names outliner
rows. The e2e asserts that invariant for the task's id and then runs the real shelf-outline reveal;
both parts failed on the old file (the invariant with the two-element list above, the reveal with
the row's class never gaining `shelf-reveal-target`) and pass with the fix. The component test now
also asserts no `[data-block-id]` inside a rendered query. Moving hits off the attribute changed
what `PluginFence` finds for a fence inside a result — handled with B-320.

---

### B-224 · A multi-line block renders its lines run together, with no line break
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, screenshot while building the page
export · **Test:** none yet

A block whose content is `Poznámka: **žluťoučký kůň**\nsecond line` (stored exactly so — checked
with `page.read`) renders as "Poznámka: **žluťoučký kůň**second line": one `<p class="vr-paragraph">`
whose spans jump from `data-to="27"` to `data-from="28"` with no `<br>` for offset 27. A plain
`plain first\nplain second` renders "plain firstplain second" the same way. `@nooklet/core`'s
`tokenizeContent` does insert `br` tokens and `render/tokens.tsx` has a `br` case, so the render
path in use is dropping them somewhere between the two. Reproduced on a production build at
`06ed234` + this branch's uncommitted web changes (none of which touch `render/`), Chromium, seeded
through `page.create` markdown with a continuation line. Not fixed here: `render/tokens.tsx` is
another branch's file this round (`m8/impl-render` exists).

**Status:** fixed · **Test:** `e2e/tests/render-views.spec.ts` ("a multi-line block renders each
line on its own line"), `apps/web/src/editor/render/tokens.test.tsx` ("a multi-line paragraph keeps
a <br> at each newline…", "quote -> <blockquote class=vr-quote>, one <br> between its lines")

Cause (read, then confirmed by a failing unit test and a failing e2e): `render/tokens.tsx#BlockContentView`
rendered a paragraph's and a quote's `lines` back to back with no `<br>` between them. The `br`
tokens exist only in `tokenizeContent`'s flat stream (used by `InlineContent`), never in
`classifyBlockContent`'s per-line arrays, which is what every outliner row, query hit, embed and
shelf card renders. It had been that way since the renderer was written (`b957731`); the existing
unit test `quote -> <blockquote class=vr-quote>` asserted the run-together text
`"line oneline two"`, so the defect was codified rather than caught.

**Fixed 2026-09-13.** `tokens.tsx#Lines` renders each line's tokens with a
`<br data-from data-to>` between consecutive lines, the offsets being that newline's own position in
`ctx.source` (read from the source rather than the neighbouring tokens, since an empty line has no
tokens). Heading trailing lines were already one `<p>` each and are unchanged. The e2e seeds the
entry's own two blocks through `page.create` markdown, checks `page.read` stores the `\n`, then
asserts one `<br>` per row and that the second line's first glyph sits below the first line's; it
failed on `cf08d19`'s `tokens.tsx` (`br` count 0) and passes with the fix. The unit tests failed
before (no `<br>`) and pin the offsets `27`/`39`/`40` for `Poznámka: **žluťoučký kůň**\nsecond
line\n\nfourth`. Real graph (backup copy, production build, `tools/probes/render-views-real-graph.mjs`):
on `2023-02-17` (26 rows, 19 multi-line) and `TTRPG/VTM-alpha` (88 rows, 10 multi-line) every
paragraph row's `<br>` count equals its stored text's newline count; no console errors beyond one
image asset the sqlite copy does not carry.

---

### B-355 · The Search filters put Task / Show / Journals only between "Updated after" and "Updated before"
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, M8 views QA (finding Q6) ·
**Test:** `apps/web/src/views/SearchView.test.tsx` "keeps Updated after and Updated before next to
each other, as the one range they are"

Filter order is Tag, Namespace, Updated after, Task, Show, Journals only, Updated before, so the
two halves of one date range are split (about 430px apart at 390px wide).

**Fixed 2026-09-13.** "Updated before" moved to straight after "Updated after" in
`views/SearchView.tsx` (the M8 selects had been inserted between them, `03cb6ef`). Order now Tag,
Namespace, Updated after, Updated before, Task, Show, Journals only. Real graph copy: the two date
labels 61px apart at 390px and at 1400px (the panel is one column at both). Test that would have
caught it: the named component test (failed before: the label after "Updated after" was "Task").
A DOM-order check, so a unit test is the honest level; the e2e search specs
(`search-filters`, `search-cleared`, `journal-display-names`) still pass over the reordered panel.

---

### B-354 · Search hits and Find & Replace groups name journal days by their ISO storage name
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, M8 views QA (finding Q5) ·
**Test:** `e2e/tests/journal-display-names.spec.ts`

With the journal title format `E, dd.MM.yyyy`, a search hit reads "2024-09-22 › todo" and a Find &
Replace group "2022-12-16", while the agenda and tagged-pages lists on the same screens say "Sun,
22.09.2024". ADR 018: every place that shows a page name to a person goes through the display name.

**Fixed 2026-09-13.** Both render `data/page-title.ts#displayRefName(name)` (the hit and the match
carry only a name, which is the case that function exists for) in `views/SearchView.tsx` and
`views/FindReplaceView.tsx`; navigation still uses the stored name. Real graph copy: hits read
"Sun, 22.09.2024 › todo › zaplatit zalohu na delnase", replace groups "Fri, 16.12.2022". Tests that
would have caught it: `e2e/tests/journal-display-names.spec.ts` — the search test failed before
(received `["2026-08-13", "Journal Names Plain Page"]`), and the replace test failed with only
`SearchView.tsx` fixed.

---

### B-353 · Clearing the search box leaves the previous results on screen, under any filter chosen next
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, M8 views QA (finding Q4) ·
**Test:** `e2e/tests/search-cleared.spec.ts`

Search "zaplatit" (49 results), clear the box: "Type to search." shows, and so do "49 results" and
all 49 rows. Choosing Task = LATER then leaves the same 49 rows (DONE and unmarked blocks among
them) under a filter they do not satisfy. A reload clears it.

**Fixed 2026-09-13.** Cause: with an empty query `SearchView`'s source memo is `undefined`, so no
search runs, and a Solid resource whose source goes `undefined` keeps its last value; the list read
that value unconditionally. `safeResults()` (and the error line) now also require a query
(`views/SearchView.tsx`). Real graph copy: typed 49 results; cleared → hint only, 0 rows; cleared +
LATER → hint only, 0 rows; typing again under LATER → 2 results. Test that would have caught it:
`e2e/tests/search-cleared.spec.ts` (failed before: 1 summary where 0 expected).

---

### B-352 · A phone without a keyboard cannot open the command palette
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, M8 views QA (finding Q3) ·
**Test:** `e2e/tests/phone-palette.spec.ts`

At 390px with touch, no control in the top bar, sidebar drawer, page "…" menu, editing toolbar or
Help menu opens `.cmd-palette`; only Cmd/Ctrl+K does. So everything that exists only as a palette
command is out of reach on a phone: Random page, Collapse all / Expand all, Open this page on the
shelf, and every other command without a button.

**Fixed 2026-09-13.** A "⌘ Command palette" row at the top of the sidebar — the drawer, on a
phone — on every device (`shell/PaletteButton.tsx`, `palette-button.css`, two lines in
`Sidebar.tsx`). It runs `palette.open` through `exec`, like the key; where there is a keyboard it
shows the live binding. In drawer mode (`max-width: 44rem`) it closes the drawer first, so the
drawer does not sit over what the command does next.

Tried first and dropped: a ⌘ icon in the top bar. On the owner's graph at 390px the bar already
holds the word count and the "Agents can see this window" badge; one more icon shrank every icon
button from 26px to its 18px glyph and, once that was stopped, pushed the badge to a third line
(53px in a 44px bar). Reclaiming gaps and padding kept the badge at two lines only by truncating the
word count ("2527 …") or by pixel-tuning against badge text that changes with its state and the
device's font. The sidebar has room and is where a phone user goes to get anywhere.

Opening it while editing ends the edit (the drawer toggle is a press outside the outline,
`BlockTree.tsx`), so block-level commands are not offered from it — the long-press menu has those;
page-level ones are. Real graph copy at 390px (`/page/TODO`): the row first in the drawer, drawer
closed after, Collapse all 111 → 41 rows, Expand all back to 111, Open a random page (TODO → "RPG on
Harry Potter theme with Robin"), all by tap. Tests that would have caught it:
`e2e/tests/phone-palette.spec.ts` (5; all five failed with the `Sidebar.tsx` hookup commented out).

---

### B-351 · The block context menu opens partly off-screen in the lower half of the window
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, M8 views QA (finding Q2) ·
**Test:** `e2e/tests/context-menu-placement.spec.ts`, `apps/web/src/app/menu-placement.test.ts`

Right-click a row at y≈520 of a 900px window (or long-press one at y≈490 of an 844px phone): the
menu's top is 536 and its bottom 1047, so "Move to page…" and the "Created … · Edited …" line are
below the window, and the menu has no scroll to reach them. `BlockContextMenu.tsx` clamps its top
to `innerHeight - 320`, a height the menu had before M8 added "Open on shelf" and the timestamps
footer; it is now 511–542px.

**Fixed 2026-09-13.** The menu is placed from its measured size (`app/menu-placement.ts#placeMenu`,
a `ResizeObserver` in `BlockContextMenu.tsx`, so the late footer re-places it): downward from the
pointer when it fits, else upward from it, else pinned to the bottom margin; shifted left to stay
on screen; `max-height` plus `overflow-y: auto` when the window is shorter than the menu. The
bottom edge is the phone's keyboard toolbar when one is showing (`usableViewport`): a first version
that used the window's height still put "Move to page…" and the footer under the 44px toolbar
(z-index 900) on a long-press at 0.55 of an 844px screen — seen in a real-graph screenshot, then
reproduced by the e2e test once it measured against the toolbar's top. Real graph `/page/TODO`:
desktop presses at y=272/522/740 give bottoms 798/537/755 of 900; phone long-presses at
y=267/486/704 give 791/791/720 above the toolbar at 799; footer and "Move to page…" on screen in
all six. Tests that would have caught it: `e2e/tests/context-menu-placement.spec.ts` (7; five
failed before the change, e.g. bottom 1040 > 900, and two phone cases failed against the
window-height-only version, bottom 836 > 799) and `apps/web/src/app/menu-placement.test.ts` (8).
Not verified: a real iPhone with the on-screen keyboard open (the toolbar's top is taken as the
keyboard's top; placement is computed when the menu's size changes, not when the keyboard moves).
Pre-existing, not touched: biome's `useSemanticElements` error on the menu's `role="separator"`
div (present at `cf08d19`).

---

### B-350 · On a phone the page title is cut off after about 12 characters
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, M8 views QA (finding Q1) ·
**Test:** `e2e/tests/page-title-fit.spec.ts`

At 390px (Chromium, `isMobile`, `hasTouch`) `/page/Deciding%20on%20a%20Job` shows "Deciding on a"
and hides "Bike"; `TTRPG/VTM-alpha` and `RPG on Harry Potter theme with Robin` are clipped the same
way. The title input is 164px wide in a 366px row (`scrollWidth` 219 > `clientWidth` 164). The rest
of the row is the empty icon slot (39px, `opacity: 0`), the History link (55px, `opacity: 0`) and the
M8 star and "…" (90px with 44px touch targets). The two invisible controls only appear on `:hover`,
which a touch screen does not have (that half is B-225). At desktop width a 36-character name is
clipped too (`scrollWidth` 451 > `clientWidth` 424): the title is an `<input>`, which cannot wrap.

**Fixed 2026-09-13.** Two causes, two changes. (1) The title is a one-row `<textarea>` that grows
to its value (`views/PageTitleField.tsx`, hooked into `PageView.tsx`): a long name wraps at any
width, Enter still commits and never inserts a break, a pasted line break becomes a space, and the
height is re-measured when the value or the field's width changes. (2) Under `(hover: none)` the
empty icon slot and the History link leave the row (`views/page-title.css`), and the "…" menu
gains "Add icon"/"Change icon" and "Page history" (B-225). The row's controls now sit on the
title's first line (`align-items: flex-start` plus a first-line centring margin). `print.css` and
two specs that named `input.page-title-input` now name the textarea. Real graph copy at 390px:
"Deciding on a Bike" and "TTRPG/VTM-alpha" one line in a 270px field (was 164px, clipped),
"RPG on Harry Potter theme with Robin" two lines, the 76-character `hls__The_Design_of_…` name five
lines, none clipped; at 1400px the same four fit (1, 1, 2, 3 lines). Test that would have caught it:
`e2e/tests/page-title-fit.spec.ts` — the four fit/menu tests failed before the change (`clippedX:
true`, no "Add icon" item); the fifth (Enter renames, no line break) guards the textarea swap.

---

### B-347 · With blocks selected, Backspace or Delete typed in the command palette deletes the selected blocks
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, writing the B-345 e2e test (its
`fill("")` on the palette input deleted two selected blocks) · **Test:**
`e2e/tests/palette-text-keys.spec.ts`; probe `tools/probes/palette-keys-delete-selection.spec.ts`

Select two blocks (Escape, Shift+ArrowDown), Cmd/Ctrl+K, type `abc`, press Backspace to fix a typo:
the two selected blocks are deleted — on the server too — and the palette input still reads `abc`.
Delete does the same. Probe output: `PROBE Backspace: rows=1 input="abc" stored=["p three"]`, same
for Delete. Anyone correcting a palette query while blocks are selected loses those blocks, and the
palette covers the page, so they may not see it happen.

Likely cause (read, not traced): `app/CommandLayer.tsx#KeyboardDispatch` runs every keydown on
`document` in the capture phase through `keymap/dispatch.ts`, whose context still says
`blockSelected` while the palette is open; `block.deleteSelected` (Backspace, and Delete as a
secondary binding) matches and preventDefaults before the input sees the key. The date picker
avoids this by claiming keys itself (B-145); the palette does not. Other text inputs over a standing
selection (page title, search, page properties) probably behave the same — not probed.

A second probe with eight keys in the palette over a two-block selection (2026-09-13, run once, not
kept): Backspace and Delete deleted both blocks; Cmd+A selected all three blocks instead of the query
text; Tab/Shift+Tab moved focus out of the input; Enter closed the palette and cleared the
selection; Shift+ArrowUp and Cmd+Z changed nothing visible.

**Fixed 2026-09-13** (outside the QA list: found while fixing B-345, fixed because it loses data).
New `app/text-field-keys.ts#textFieldOwnsKey`: a text-editing key — Backspace, Delete, arrows,
Home/End/PageUp/PageDown with any modifier (except Alt+Left/Right outside macOS, Back/Forward), and
Mod+A/C/X/V/Z — whose target is a text field other than the block editor (`.cm-editor`) is left to
the field; `CommandLayer`'s global keydown listener returns before dispatch. Escape, Enter, Tab and
the global shortcuts still dispatch from text fields. Spec: R12a. The e2e test was red before the
hookup (`Backspace` left the input at `abcd`) and green after; it also checks Cmd/Ctrl+A selects the
query and that Backspace with the palette closed still deletes the selection. Unit:
`app/text-field-keys.test.ts`. Behaviour change to know about: Cmd/Ctrl+Z inside a plain text field
(palette, page title, search) is now the field's own undo instead of the outliner's (`edit.undo` is
`when: true`); the undo/redo, template-undo, redo and focus specs still pass, and that a field's
native undo now works was not checked. Tab and Enter in the palette over a selection behave as
before (not data loss; not changed here).

---

### B-345 · "Set scheduled date" with several blocks selected dates only the first one
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, exploratory QA of M8 editor features
(Q6, `scratchpad/m9/qa-m8-editor/final.mjs`) · **Test:** `e2e/tests/dates.spec.ts` "with several
blocks selected the date commands are not offered, since they date one block (B-345)"

`- TODO m1` / `- TODO m2` / `- TODO m3`: click m1, Escape, Shift+ArrowDown (two rows selected),
Cmd+K, "Set scheduled date", `tomorrow`, Enter. Only m1 got `scheduled::`; m2 stayed selected with no
date, and nothing said that only one block would be dated. "Set deadline date" is the same command
shape.

Cause: both commands were enabled for `editorFocused || blockSelected` and open one picker for
`targetBlockId(ctx)` — the first selected id (R38 speaks of "the selected block's row", singular).

**Fixed 2026-09-13.** The smaller of the two fixes QA offered: `task.setScheduled`/`task.setDeadline`
are gated on `editorFocused || (blockSelected && selectionCount == 1)`, like `task.cycle`, so a
multi-selection is not offered them (spec table and R38 updated). Dating every selected block would
need a picker with no single starting date and a multi-block write; not done. The e2e test was red
on the old `when` (the palette listed "Set scheduled date" for two selected blocks) and green after;
unit: `commands/registrations/index.test.ts` "the date commands date one block (B-345)" (2/2 red
before).

---

### B-343 · After `/image` or an image paste the caret stays before the inserted image markdown
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, exploratory QA of M8 editor features
(Q4, `scratchpad/m9/qa-m8-editor/misc2.mjs`) · **Test:** `e2e/tests/image-insert.spec.ts`, both
tests (they now type after the insert)

`- image here`, End, ` /image`, Enter, pick a PNG, wait for the upload, type `Z`: the block became
`image here Z![](assets/….png)`. The upload and the image itself are fine; the caret was left just
before the image, so whatever is typed next lands in front of it instead of after it (the way
`/mermaid` and every other editor places the caret).

Cause: `BlockTree.tsx#insertUploadedImage` dispatched the insertion with no `selection`, and CM6
maps a cursor that sits exactly at an insertion point to before the inserted text.

**Fixed 2026-09-13.** The dispatch sets `selection: {anchor: head + markdown.length}`. Both e2e tests
were red before (`look  Z![](assets/….png)`, `pasted  Z![](…)`) and green after. The other branch of
that function (the editor has moved to another block; the text is written into the old block's
content) has no caret to place and is unchanged.

---

### B-341 · On a read-only page, clicking a date chip opens the picker and writes or removes the date
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, exploratory QA of M8 editor features
(Q2, `scratchpad/m9/qa-m8-editor/locked2.mjs`) · **Test:** `e2e/tests/read-only.spec.ts` "a date
chip on a locked page refuses with the notice and never opens the picker (B-341)"

On a page with `read-only:: true` (the Read-only badge showing), clicking the Scheduled chip of
`TODO locked task` opened the date picker; `+10d` Enter rewrote `scheduled:: 2026-09-20` to today+10,
and the picker's Remove deleted the date. No read-only notice appeared — while a click on the task
marker, a drag and Enter on the same page are refused with one (B-234).

Cause: `editor/DateChips.tsx` (impl-dates) and the page lock (impl-small) merged separately; the
chip's click handler opened `blockDatePicker` unconditionally, and nothing passed it the lock.

**Fixed 2026-09-13.** `DateChips` takes `onLocked`; `BlockRowView` sets it on a locked row to its new
`onReadOnlyRefused`, which `BlockTree` wires to the read-only notice — so the chip refuses exactly
the way the marker does. The e2e test was red before the fix (no notice) and green after.

---

### B-340 · Backspace/Delete merge silently drops the merged block's task marker, dates and properties
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, exploratory QA of M8 editor features
(Q1, `scratchpad/m9/qa-m8-editor/merge2.mjs`, `props.mjs`) · **Test:**
`e2e/tests/merge-keeps-fields.spec.ts` (both tests)

On `- notes here` / `- TODO buy milk` (with `scheduled:: 2026-09-20` and `owner:: dan`), Backspace
at the start of `buy milk` stored `notes herebuy milk`: no TODO, no scheduled date, no `owner`.
Backspace at the start of an empty block that carries `list:: number` and `source:: book` deleted
the block and both properties. Delete at the end of a buffer (pulling the next block in) and
merging a numbered `delta` with `tag:: x` into a plain block lost them the same way. Nothing warns;
only an immediate Cmd+Z brings the data back.

Cause: `editor/commands.ts#mergeWithPrevious`/`#deleteForwardMerge` wrote only `block.text` (the
joined contents) and `block.delete`; nothing else the deleted block held was written anywhere, and
`content === ""` was taken to mean "empty block" even with properties on it.

**Fixed 2026-09-13.** New `editor/merge-fields.ts#carryFields`: the staying block takes every field
it does not set itself (marker, priority, scheduled, deadline, repeat, done, generic properties) as
`block.prop` ops in the same structural commit, so one Cmd+Z undoes the whole merge. Decisions,
recorded in spec R20a: the marker is carried as a marker rather than as the word `TODO` at the join
(Logseq's raw-text merge leaves it as text; here that text would sit on line 1 when the previous
block is empty, and the mirror would write it back as a task — the B-342 mismatch); when both blocks
set the same field to different values the merge is refused and the outliner's toast names the field
and both values (`mergeRefusedMessage`), because keeping either value silently loses the other.
`done` never refuses. The e2e spec was red on `cf08d19` (both tests: TODO/scheduled/owner and
list/source gone; no notice) and green after; unit: `commands.test.ts` "merges keep what the merged
block carried (B-340)" (4 of 6 red before the fix, the other two guard the Enter-then-Backspace
numbered-item flow and shared fields).

---

### B-296 · After the palette or the Move to page picker gives focus back, text with no keydown lands at the start of the block
**Status:** fixed · **Severity:** medium (text goes in the wrong place, silently) · **Found:**
2026-09-13, adversarial verification of m9/focus (on the owner's graph copy first) · **Test:**
`e2e/tests/focus-return.spec.ts` "the caret comes back where it was, mid-block, through the palette
and the Move to page picker"; unit `commands/focus-return.test.ts` "puts the caret back inside an
editable, not at its start (B-296)"

B-161's focus return on this branch calls a plain `element.focus()` on CodeMirror's `.cm-content`.
The overlay's input had taken the document selection, so the browser puts the DOM caret at the start
of the editable. CodeMirror's state selection is still right, and it has a guard for exactly this
("the browser moved the selection to the start on focus", `DOMObserver.readSelectionRange`), but the
guard runs when the `selectionchange` is delivered. A key with a keydown is fine (CodeMirror settles
the selection first); text that arrives with no keydown before that — an IME commit, dictation, the
emoji picker, Playwright `insertText`/`type("Ž")` — is inserted where the DOM caret is: the start.
`EditorView.focus()` would not have this (`observer.ignore` + `docView.updateSelection()`), but
`commands/` cannot reach the view. The module comment ("its own focus handler keeps the caret where it
was") was an unverified assumption.

Evidence (`apps/web/src/commands/focus-return.ts` at `2924c05`). Real graph copy, a plain Czech block
on a 201-block page: Home, ArrowRight ×4, Cmd+K, Escape, `type("Ž")` → stored at offset 0; without
the palette → offset 4. e2e data (`tools/probes/focus-return-verify.spec.ts` "B-296", 4 rounds per run, 2 runs): caret at
offset 2, Cmd+K, Escape, then — digit key: 8/8 at 2; `insertText` at once: 8/8 at 0; `type("Ž")` at
once: 8/8 at 0; `insertText` 50 ms later: 8/8 at 2. The `caret()` read straight after Escape is 0
every time, even when the text then lands right. Not visible in `cf08d19`, where nothing gave focus
back (the text went nowhere). The branch's tests typed `!` (a keydown) at the end of the block.

**Fixed 2026-09-13.** `rememberFocus` also records the document selection when it lies inside the
element that had focus, and after `focus()` puts it back with `setBaseAndExtent` in the same task —
only onto nodes still inside the element (a re-rendered line leaves the caret to the editor), and an
offset that no longer fits is ignored. Inputs keep their own selection and are unaffected. The e2e
test puts the caret at offset 2 and inserts `č`, `ř` (palette, Escape) and `ž` (palette → Move to
page… → Escape) with `insertText` straight after each Escape: it failed 2 of 2 before
(`řčžabcdefghij`, `žřabčcdefghij`), and `focus-return.spec.ts --repeat-each=2` passed 20 of 20 after.
The unit test failed before the change and passes after.

---

### B-293 · Choosing a page in the palette while editing: keys typed before the new page shows go into the block being left
**Status:** fixed · **Severity:** medium (text lands on a page nobody is looking at) · **Found:**
2026-09-13, adversarial verification of m9/focus · **Test:** `e2e/tests/focus-return.spec.ts`
"choosing a page in the palette while editing: what is typed before it shows never lands in the
block being left"

A regression from B-161's fix on this branch. The palette now gives focus back to whatever had it as
it closes — including when the row chosen was a page (`selectRow` → `props.onSelectPage`) or
"Create page …" (`props.onCreatePage`). Both leave the page, but not at once:
`hosts.ts#createNavigationHost.openPage` resolves the page name with a replica read before it
navigates, and creating a page is a write first. In that gap the editor on the page being left is
focused again, so what is typed goes into its block — and is saved there, on a page that is no
longer on screen.

Probe (`tools/probes/focus-return-verify.spec.ts` "B-293", port 6401): edit `- origin`,
Cmd+K, type another page's name, Enter, type `qq` at once. On `2924c05`: `activeElement` right after
Enter is `.cm-content`, and the stored block on the page left is `originqq` (1 of 1); same with the
Create page row (1 of 1). With `apps/web/src` checked out at `cf08d19`: focus on `<body>` and the
block stays `origin` (both). "Open journals" run from the palette does not show it (that navigation
is synchronous, so the editor is already detached when the palette closes).

**Fixed 2026-09-13.** `commands/palette/CommandPalette.tsx#selectRow` skips the focus return for the
rows that leave the page: a page, "Create page", and a command in the `Navigation` category (probe:
"Follow link under cursor" run from the palette resolves the link before it navigates — `qq` went
into the block 1 of 2 on the branch, 0 of 2 with `apps/web/src` at `cf08d19`). Escape, Cmd/Ctrl+K, a
backdrop click, any other command row (and a command that closes the palette itself, like Move to
page…) and Shift+Enter onto the shelf still give focus back. Focus after such a row is where
`cf08d19` left it (`<body>` until the new page is clicked into). Tests that would have caught it:
`e2e/tests/focus-return.spec.ts` "choosing a page in the palette while editing: what is typed before
it shows never lands in the block being left" (page row and create row) and "following a link from
the palette while editing: what is typed before the page shows never lands in the block being left";
each reads `activeElement` straight after Enter, types `qq`, and checks the stored block on the page
left. The first failed 3 of 3 before the change, the second 2 of 2 with only the page-row half in;
after: `focus-return.spec.ts --repeat-each=2` 18 of 18, views + follow-link + commands 42 passed.
A plugin command that navigates asynchronously from outside the `Navigation` category is not
covered.

---

### B-203 · Alt+Enter ("Follow link under cursor") did nothing in a Playwright-driven Chromium on macOS
**Status:** fixed · **Severity:** unknown · **Found:** 2026-09-13, verifying B-104 ·
**Test:** none

Noticed in passing, not investigated, and not caused by this branch (a plain `[[Taxes]]` behaves
the same as an alias link). Repro on a served graph: a page with one block `alpha [[Taxes]] omega`,
click the end of the block (`.cm-content` focused), `Home`, `ArrowRight` ×9 (the DOM selection then
sits inside `Taxes`), `page.keyboard.press("Alt+Enter")`: the URL stays on the page, and no
navigation follows within 1.5 s. `nav.followLink` (`commands/registrations/nav.ts`, `when:
"editorFocused && caretInLink"`) has no e2e test. Unconfirmed whether the key never matches, the
context's `caretInLink` is false, or Playwright's macOS Alt handling differs from a real keyboard —
try it by hand before spending time on it.

**Diagnosis 2026-09-13 (m9/focus): a real bug, not a test-harness artifact.** Probe
`tools/probes/alt-enter-follow-link.spec.ts`, Chromium on macOS, port 6401, five cases:

- A — the entry's exact steps (`alpha [[…]] omega`, Home, ArrowRight ×9, `Alt+Enter`): nothing.
  The window saw `keydown key=Enter code=Enter altKey=true`, and it bubbled back up with
  `defaultPrevented=false` — no handler took it. A `.cmd-popup` was open before the key.
- B — caret at the end of a trailing `[[link]]`: followed. No popup open.
- C — A's caret, the key sent as a raw CDP `Input.dispatchKeyEvent` (`modifiers: 1`), the way a
  real keyboard's event reaches the renderer: nothing — so not Playwright's Alt handling.
- D — the caret further inside the link: nothing, popup open.
- E — A's caret, the popup dismissed with Escape first, then `Alt+Enter`: followed.

Cause: walking the caret into an existing link re-detects the `[[` trigger before the caret
(`CommandLayer`'s keyup re-detection) and opens the page autocomplete, which claims the popup keys.
The global keymap (`commands/keymap/dispatch.ts`, R12 step 2) then yielded every `Enter` to the
popup, modifiers or not — but the editor, which is what hands that popup its keys, only offers it
keys without Cmd/Ctrl/Alt (`BlockTree.tsx#dispatchKey`). So `Alt+Enter` belonged to nobody. The
same holds for anything else bound to a modified Enter/Tab/arrow while the autocomplete or slash
menu is open (Cmd/Ctrl+Enter `task.cycle`, Alt+Up/Down `block.moveUp/Down`). A real keyboard
takes the same path; only "put the caret in a link without opening the popup" (End after a
trailing link, as in `follow-link.spec.ts`) avoided it.

**Fixed 2026-09-13.** The yield now asks whether the popup would actually receive the key:
`commands/popup-keys.ts` — a claim can say it is `editorFed` (AutocompletePopup, SlashMenu), and
`popupTakesKey(event)` is "a popup key, and either the popup has its own input or the key has no
Cmd/Ctrl/Alt". `keymap/dispatch.ts` step 2 consults it (injectable `popupTakesKey`, default the old
rule), `provider/CommandProvider.tsx` passes the real one, and spec R12 step 2 says so. Every other
claimant (palette, page picker, page actions, help menu, template picker, context menu, date picker)
keeps the old rule, so a modified key typed into the palette's input still never runs against the
block behind it.
Consequence worth knowing: with the autocomplete or slash menu open, Cmd/Ctrl+Enter (`task.cycle`)
and Alt+Up/Down (`block.moveUp/Down`) now run their commands instead of doing nothing, the same as
with no popup. Tests that would have caught it: `e2e/tests/follow-link-popup.spec.ts` "Alt+Enter
follows a [[link]] the caret was walked into, though that opened the autocomplete" (failed on
`cf08d19`: the URL stayed on the page) and, for the boundary, "with the autocomplete open, plain
Enter is still the popup's: it picks a row, it does not split the block"; unit
`commands/popup-keys.test.ts` (4) and `keymap/dispatch.test.ts` "step 2 asks popupTakesKey: a key
the popup never receives is dispatched (B-203)". Not fixed, and not asked: whether walking the caret
into an existing link should open the autocomplete at all.

---

### B-147 · Text that reaches the page before the picker is listening, or without a keydown, goes into the block behind it
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, verify-impl-dates · **Test:** none;
measured with throwaway Playwright probes (numbers below)

Two ways the picker's "keys never reach the block" rule has a hole, both because the editor keeps
DOM focus and the picker takes keys from a window `keydown` listener:

1. **Type-ahead.** `open()` reads the block (`getBlockTaskState`, a replica query) and lazy-loads
   `DatePicker.js` before the listener exists. Enter on the slash menu → picker mounted measured
   25 / 10 / 7 ms on the e2e graph and 6–24 ms (8 opens) on a copy of the owner's graph. A key
   pressed inside that window lands in the block: `" /sched"`, Enter, `tom` typed at once gave
   the block `fast typist t` and a picker holding `om` (invalid, so Enter only showed an error).
   Human keystrokes after Enter are normally slower than the gap, hence low.
2. **No keydown.** Text committed by an IME, a dead-key composition, dictation or a virtual
   keyboard arrives as `beforeinput`/`input` with no `keydown` of its own. Emulated with
   Playwright's `keyboard.type("zítra ěščřžýáíé")` (non-US characters go through `insertText`):
   the picker saw `ztra`, the block got `íěščřžýáíé`. Unverified on a real keyboard: a Czech
   layout's number-row letters (ě š č ř ž ý á í é) should arrive as ordinary keydowns and work;
   letters built with a dead háček/čárka key (ď ť ň, most capitals) should not. The picker's
   vocabulary is English words and digits, so this mostly matters for junk landing in the block. `docs/progress/impl-dates.md` §5 already names the
   mobile half of this.

Fix direction: hold keys from the moment `open()` is called (a capture listener handed to the
picker, replayed on mount), and take `beforeinput` `insertText` while open. Not done here.

**Fixed 2026-09-13** — both holes the entry names, except composition, now B-291. Reproduced first:
the four e2e tests below failed on `cf08d19` (keys typed in the gap went to the block and the
picker's query stayed empty; Escape in the gap dropped the block into selection mode and the
picker opened anyway; `insertText("zítra")` went into the block).

1. **Type-ahead.** `commands/date-picker/type-ahead.ts#holdPickerInput`: the host
   (`date-picker/host.ts#open`) starts a window capture hold the moment it is asked to open — before
   the replica read and the lazy import. The hold reads each key with the picker's own
   `pickerKeyAction` (shared, so an early key means what it would have meant later), swallows and
   keeps the picker's keys and keydown-less text, cancels on Escape (swallowed, and later keys are
   the block's again), on a Cmd/Ctrl shortcut (left to do its job) and on a press anywhere.
   `openDatePicker` does not open for a cancelled hold, and otherwise replays the held input right
   after `render` returns — one synchronous stretch, so nothing can be typed between the replay and
   the picker's own listener — then releases it. Keys held after one that closed the picker (a
   replayed Enter) are dropped; they were already swallowed and cannot go back to the block.
2. **No keydown.** The open picker and the hold both take `beforeinput` `insertText`.

Tests that would have caught it: `e2e/tests/date-picker-type-ahead.spec.ts` "keys typed before the
picker is listening go to the picker, not the block", "a whole date and Enter typed before the
picker is listening sets the date once it is", "Escape typed before the picker is listening cancels
it: nothing opens, nothing is stored", "text that arrives without a keydown goes to the open picker,
not the block" — the gap is made deterministic by delaying the picker's chunk 800 ms with
`page.route` (service workers blocked so the request is routable), not by typing fast. Unit:
`commands/date-picker/type-ahead.test.ts` (10), `host.test.ts` "createDatePickerHost.open holds
type-ahead (B-147)" (2). With `dates.spec.ts`: 11 of 11 passed at load average 82.

---

### B-231 · Pressing on a context-menu separator or its padding ends editing while the menu stays open
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, impl-small, while adding B-230 ·
**Test:** none yet

The menu items guard their `mousedown` (B-71), but the menu's other content does not: a press on a
`.ctx-sep` line or on the `.ctx-menu` padding moves focus to `<body>`, which ends editing (B-74),
and the menu's own dismiss listener ignores presses inside the menu, so it stays open over a row
that is no longer being edited. Inferred from the same mechanism the B-230 footer hit (its e2e test
failed with `activeElement is body` without the guard); not separately reproduced on a separator.
Likely fix: `onMouseDown={(e) => e.preventDefault()}` on the `.ctx-menu` container itself in
`app/BlockContextMenu.tsx`, plus an e2e test pressing on a separator.

**Fixed 2026-09-13.** Reproduced first (the entry had it inferred only): right-click a block being
edited, press on the first `.ctx-sep` — `activeElement is body`, the menu still open. One
correction to the entry: the row KEEPS the editor (the snapshot at the failure still shows the
"Block content" textbox) — editing does not end, but nothing can type into it until a click, which
from the keyboard is the same thing. Fix as the entry proposed: `onMouseDown` `preventDefault` on
the `.ctx-menu` container in `app/BlockContextMenu.tsx`, so no press anywhere in the menu moves
focus (the items' own guard from B-71 and the timestamps footer's from B-230 stay; they are now
redundant but harmless). Test that would have caught it: `e2e/tests/focus-return.spec.ts`
"pressing on a context-menu separator or on the menu's padding keeps the block in edit mode"
(a separator, then the menu's padding at (2, 2), focus read after each, Escape, `End` + `!` in the
stored block); failed before the change, passes after. context-menu + block-timestamps +
focus-return + selection: 41 passed, 1 skipped.

---

### B-195 · "Move to page…" onto the block's own page while editing it leaves an unfocused editor
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, verifying `m8/impl-editor` (probe) ·
**Test:** none (throwaway probe)

Caret in the first block, right-click it, "Move to page…", pick the page it is already on. The
block moves to the end of the page (correct), and its row still holds the editor, but focus is on
`<body>` — the picker took it and nothing gives it back — so typing goes nowhere until a click.
Before B-88's fix removed `leaveEditing` from this command, it ended editing first and left the
block selected with the outliner focused (typing did nothing there either, but nothing looked
editable). The row did not leave the page, so the tree's new end-editing path (B-88) does not run.
Same family as B-193: a picker or palette closing without handing focus back to the editor.

**Fixed 2026-09-13.** Reproduced first as an e2e test (failed on `cf08d19`: `activeElement is body`
straight after the picker closed). Same cause as B-161: the "Move to page…" picker
(`app/refactor-host.tsx#pickPage`) puts focus in its input and nothing gave it back. It now records
what had focus before it mounts (`commands/focus-return.ts#rememberFocus`) and gives it back as it
closes, after its root leaves the document and before the command's server op — so when the pull
moves the row to the end of the page, the editor is focused again and `BlockTree`'s
`refocusAfterReorder` keeps it through the DOM move. Run from the palette, the palette gives focus
back to the editor as `closePalette` runs, so the picker records the editor, not `<body>`. Tests that
would have caught it: `e2e/tests/focus-return.spec.ts` "Move to page… onto the block's own page
while editing it leaves the editor focused and typeable" (right-click, pick its own page, focus
read straight after Enter and again after the row moved, `End` + `!` lands in the stored block) and
"Move to page… run from the palette hands focus through the palette and the picker back to the
editor" (Escape out of the picker); both failed with `refactor-host.tsx` at `cf08d19`.

---

### B-161 · e2e "opening the palette while editing and closing it hands focus back to the editor" fails
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, impl-commands e2e sweep ·
**Test:** `e2e/tests/views.spec.ts` "opening the palette while editing and closing it hands focus
back to the editor"

**Seen by five workstreams on 2026-09-13** (B-193, B-226, B-246, B-270 are the same report). In the coordinator's runs it failed inside full-suite runs on a loaded machine (12.2 s timeout) and passed alone twice; treat it as flaky-under-load until someone reproduces it on a quiet machine.

Open a page, click into a block, Cmd/Ctrl+K, Escape: the palette closes but `.cm-content` is not
focused (`toBeFocused` times out, "inactive"), so the `!` typed next goes nowhere. On port 6402 it
passed twice earlier the same morning and then failed three runs in a row — once in a 19-spec sweep
and twice alone (`--repeat-each=2`) — **including with every `apps/web/src` file this branch changed
restored to `da85cfb`**, so this branch did not cause it. Reading the code, nothing hands focus
back to the editor when the palette closes (the palette input takes focus in a microtask on open;
removing it leaves focus on `<body>`), so the test passing at all may depend on timing — e.g. the
input's `focus()` landing before or after the element is attached. Machine load at the time was
heavy (a dozen agents). Not investigated beyond that; logged so it is not mistaken for a
regression from whichever branch merges next.

2026-09-13, verify pass of `m9/clipboard-sync`: "opening the palette while editing and closing it
hands focus back to the editor" failed in chunk 3 of a full run and then **alone**, so it was
repeated with a throwaway copy using a fresh page name each time: 8 of 8 failed on the branch,
3 of 3 at load average 2.3, and 4 of 4 with `apps/web/src` checked out from `cf08d19` — so it is
not this branch and not machine load. After Escape closes the palette, `document.activeElement` is
`BODY` (`document.hasFocus()` true). Not investigated further here.

**Diagnosis 2026-09-13 (m9/focus).** Not load-dependent at its core: nothing in the app gave focus
back when the palette closed. The palette's input takes focus in a microtask on open; Escape (or
Cmd+K, a backdrop click, a chosen row) unmounts it and focus falls to `<body>`, where it stayed.
Measured with `tools/probes/palette-escape-focus.spec.ts` on port 6401, production build:

- The test's own steps, machine at load ≈4 on 14 cores: `.cm-content` focused 0 of 6 runs; the
  real `views.spec.ts` test alone: failed 1 of 1; the whole of `views.spec.ts` (a traced copy):
  failed, 28 others passed.
- Under ten busy `node -e 'for(;;){}'` loops (load ≈8): 0 of 8. Under CDP CPU throttling ×20: 0
  of 6.
- With animation frames delayed 150 ms (init script): **4 of 4 passed** — and the `focusin` trace
  shows why: 100 ms after Escape the editor is focused from inside a frame callback, the
  `requestAnimationFrame` backstop `surface.attach` armed when the test's click entered editing.

So the test passed only when the click's frame-later refocus landed AFTER Escape: on a machine
starved enough that frames lag the keyboard (the dozen-agent runs at load 17-35), sometimes; on a
quieter one, never. That is why five workstreams saw "fails alone, passes in the full run" and the
coordinator saw the opposite — both were timing, and the test's auto-retrying `toBeFocused()`
(10 s) gave a stale backstop all the time it needed to rescue it. The same backstop's other
direction is B-290.

**Fixed 2026-09-13.** `apps/web/src/commands/focus-return.ts#rememberFocus`: the palette records
what had focus as it opens (an effect on `isOpen`, which runs before the input's focus microtask)
and gives it back as it closes, synchronously, in the same task as the key or click that closed it
— however it closes (Escape, Cmd+K again, a row, a command that closes it). It gives focus back
only when the palette is what lost it (focus on `<body>` or still inside the overlay) and only to
an element still in the document, so a command that moved focus on purpose, ended editing or
navigated away keeps its result. Outliner focus in block selection comes back the same way. The
test is now deterministic: `e2e/tests/views.spec.ts` "opening the palette while editing and
closing it hands focus back to the editor" reads `activeElement` once, straight after Escape
(`expectEditorFocusedNow`), instead of `toBeFocused()` retrying for 10 s, asserts the palette input
really had focus first, uses a page per repeat/retry (`--repeat-each` used to fail on the typed
text), and checks the stored block. Tests that would have caught it:
that test, and `e2e/tests/focus-return.spec.ts` "Escape out of the palette gives the editor focus
back in the same keystroke, even with frames arriving late", "Cmd/Ctrl+K pressed again to close the
palette also gives the editor focus back", "the palette opened from block selection gives the
outliner its keys back"; unit `apps/web/src/commands/focus-return.test.ts`.

Proof, port 6401: with `CommandPalette.tsx` and `surface.ts` restored to `cf08d19`, all five of
those e2e tests failed (`activeElement is body`). Loop under 20 busy node processes (load average
12 → 41): the ORIGINAL test (only its page name made unique) 0 of 10, the new form 0 of 10. With
the fix, same load (36 → 64), `--repeat-each=10` over the original test, the four palette tests in
`views.spec.ts` and the four in `focus-return.spec.ts`: 90 of 90 passed. Duplicates closed by this:
B-173, B-182, B-193, B-213, B-226, B-246, B-270.

`e2e/tests/views.spec.ts` "opening the palette while editing and closing it hands focus back to
the editor" failed 8 times in a row on port 6461 around 12:00 (load average ≈15): in a 12-spec run,
alone, `--repeat-each 4`, and `--repeat-each 2` twice — the last with every app file this branch
changes (`PageView.tsx`, `PageActions.tsx`, `PageIcon.tsx`, `print.css`, `BlockContextMenu.tsx`,
`context-menu.css`, `Sidebar.tsx`) restored to `cf08d19`. It had passed on this branch an hour
earlier. Another m9 branch carries a fix (`d69414f`, "the palette gives focus back when it closes;
a late frame no longer steals it (B-161, B-290)").

**Status:** still failing (not fixed here)

Another data point, 2026-09-13 on port 6404: "opening the palette while editing and closing it hands
focus back to the editor" failed in every run on this branch — inside a 4-spec run, `views.spec.ts`
alone (28/29), and the full n–z half (295 passed, 1 failed) — and then failed 2/2
(`--repeat-each=2`) with every `apps/web/src` source file this branch changes restored to
`cf08d19`. So it fails on `cf08d19`'s client here too, though the coordinator's full run on the same
commit passed it; machine load (a dozen agents) is the difference in sight.

---

### B-290 · Clicking into a block and pressing Cmd/Ctrl+K before the next frame: the editor takes focus back from the open palette
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, m9/focus (diagnosing B-161) ·
**Test:** `e2e/tests/focus-return.spec.ts` "a click into a block then Cmd/Ctrl+K before the next
frame: what is typed goes to the palette"; probe `tools/probes/palette-escape-focus.spec.ts` "a
late frame after entering editing vs an open palette"

The mirror image of B-161, from the same line of code. `editor/surface.ts#attach` re-asserts focus
twice after entering edit mode — a microtask and a `requestAnimationFrame` backstop — and the frame
one takes focus back from ANYTHING (`!view.hasFocus`), not only from the `<body>` a removed element
leaves behind. On a loaded machine a frame can arrive long after the input events that followed
it: a click into a block, Cmd+K, and the palette's input takes focus; then the late frame focuses
the editor underneath the open palette, and what is typed goes into the block, not the palette.

Probe, frames delayed 150 ms with an init script (what a starved renderer does to begin-frames
while input keeps being dispatched): click a block, Cmd+K, wait, type `zz` → `activeElement` is
`.cm-content` and the palette query is `""`, 3 of 3. Control with no delay: the input keeps focus
and the query is `"zz"`, 3 of 3. Not seen by a person yet; a fast Cmd+K right after a click on a
busy machine is the shape it would take.

**Fixed 2026-09-13.** The frame-later backstop in `surface.attach` now takes focus only from
`<body>` or from the element that still had focus when the attach ran (where entering edit mode
leaves it); focus that moved anywhere new in between was someone's decision and stays. The
microtask refocus is unchanged. Test that would have caught it: `e2e/tests/focus-return.spec.ts` "a
click into a block then Cmd/Ctrl+K before the next frame: what is typed goes to the palette" —
frames delayed 400 ms by `e2e/helpers/focus.ts#delayAnimationFrames`; it failed on `cf08d19`'s
`surface.ts` (`activeElement` was `.cm-content` under the open palette) and passes with the fix
(10 of 10 under load, see B-161).

---

### B-247 · An edit queued behind a busy replica worker is lost if the page reloads first
**Status:** fixed · **Severity:** high (silent data loss; needs a busy worker and a reload within
seconds) · **Found:** 2026-09-13, rerunning QA's `t2.mjs` for B-244 on a copy of the real graph ·
**Test:** — (probe: `tools/probes/busy-replica-reload.mjs`)

On the real graph, `t2.mjs` accepts a `[[` row and reloads the page ~1.9 s later for the next
variant. Twice (ClickNew, EnterExisting) the editor showed `x [[…]]` and the server never got it,
not even after later loads; with 5 s more before each reload, all six variants were stored. The
probe makes it deterministic: keep the replica worker busy for 4 s (a synchronous loop evaluated
in it), type ` queued`, wait 1.2 s (past the 500 ms text debounce), reload. Stored: `x`. The same
with the reload after the busy period: `x queued`. Plain typing with an idle worker and a reload
1.9 s later loses nothing (5/5).

Reading, not verified: `BlockTree.flushPendingEdit` hands the op to `applyOps`, a Comlink message
to the worker; the op only becomes durable (state + `pending_op`, one transaction) when the worker
runs it. A message still queued when the document unloads dies with the worker, and the
`pagehide` flush has the same problem. What keeps the worker busy on a big graph: the cold
bootstrap (measured ~2.2 s blocked on first load) and, plausibly, the `[[` popup's block search
(`LIKE %q%` over every block, re-run on every keystroke). A fix needs a durable hand-off that does
not wait for the worker (e.g. the unflushed edit written synchronously on the main thread and
replayed at start), which is a design decision, not a one-liner.

**Measured 2026-09-13 (clipboard-sync)** with `tools/probes/replica-busy-window.mjs` against a copy
of the real graph (952 pages, 18.6k blocks), Chromium, on a machine shared with a dozen agents (so
two runs differ). The loss window is the DB worker's event-loop lag — a heartbeat inside the worker
records every gap over 50 ms:

| phase | longest gap | total blocked |
|---|---|---|
| cold first load (fresh OPFS, bootstrap) | 1,835 / 2,070 ms | 2,081 / 2,659 ms |
| warm reload | 222 / 271 ms | 343 / 419 ms |
| plain typing, 201-block page | 127 / 1,602 ms | 127 / 3,175 ms |
| `[[proj` popup search | 388 / 763 ms | 637 / 1,460 ms |

End to end, **with no artificial load**, typing ` kept` into a fresh small page and reloading N ms
later (reloaded page's text = the replica; server read 3 s later): 0 ms → replica `x kept`, server
`x`; **100 ms → `x`, 300 ms → `x`** (the edit is gone from the replica, not merely unpushed); 700 ms
→ replica `x kept`, server `x`; 1,500 ms → both `x kept`. So the pagehide flush is not a reliable
hand-off even to an idle worker: its message is posted while the document unloads, and whether the
worker runs it before it is torn down is a race the page right after a load (the worker still
answering that load's queries) loses. The second half of what the probe shows — an op durable in
the replica that the server never gets — is B-301.

Also seen in the existing suite: `editing.spec.ts` "typing immediately after Enter is not
discarded" failed once (after its reload, 1 row instead of 2) — consistent with this mechanism, not
proven to be it.

Test before the fix: `e2e/tests/reload-durability.spec.ts` "an edit queued behind a busy replica
survives a reload after the text debounce (B-247)" and "... inside the text debounce (B-247)" — both
fail on `cf08d19` + B-233/B-245 (server keeps `x`).

**Fixed 2026-09-13** — the cheapest safe mitigation; the options and what is still open are in
`docs/proposals/002-pending-edits-durability.md`. New `apps/web/src/db/unapplied-ops.ts`:
`db/client.ts#applyOps` writes each batch to `localStorage` synchronously before posting it and
removes it when the worker answers (kept if the call fails). At `initDb`, batches of page loads
that are gone — each load holds a Web Lock named after itself, released by the browser with the
document — are replayed through a new worker method, `WorkerDb.replayLocalOps`, which skips op ids
already in the replica's `op` table (so a batch that did land is not pushed again) and otherwise
runs `applyLocal`; a second pass runs 5 s later in case the old document's lock was released late.
A batch whose replay fails is kept for the next start. Tests: `e2e/tests/reload-durability.spec.ts`
"an edit queued behind a busy replica survives a reload after the text debounce (B-247)" and
"... inside the text debounce (B-247)" — 15/15 runs green with the fix (`--repeat-each=5`), and
4/4 red with only the `localStorage` write disabled (B-301's fix still in), so the copy is what
fixes them. Unit: `apps/web/src/db/unapplied-ops.test.ts` (record/settle, only dead owners' batches,
order, quota, unreadable entries, replay keeps a failed batch), `db/client-unapplied.test.ts` (the
copy exists synchronously before the worker answers; `initDb` replays an orphaned batch and removes
it), `db/worker-core.test.ts` "applies and queues ops the replica never saw, and skips ones it
already recorded". Chromium only: WebKit/WKWebView and Capacitor are unverified (proposal §4). Not
covered: a renderer crash inside the editor's 500 ms text debounce, where no `pagehide` runs.

Re-measured on the real-graph copy with the fixed build: reloads 0, 100, 300, 700 and 1,500 ms
after typing all kept the text in the replica AND on the server, without a further edit (before:
100 and 300 ms lost it, 0 and 700 ms left it unpushed). `pnpm nooklet verify` on that copy
afterwards: OK, 20,466 ops replayed, rebuild matches live state.

---

2026-10-03 (local-graphs): a follower replica with no sync target replays orphaned batches into memory and settles them; with the new lock wait this should no longer happen on relaunch, but a genuine second tab of a local-only graph would still do it.

### B-245 · Cmd+X on a block selection does nothing
**Status:** fixed · **Severity:** low · **Found:**
2026-09-13, exploratory QA (Q6) · **Test:** —

Select blocks, Cmd+C copies their markdown (B-84), Cmd+X does nothing: selection, clipboard and
database unchanged. Logseq cuts. Not a regression: `keydown.ts` has no Mod+X mapping in selection
mode and `docs/spec/commands-and-keymap.md` defines no cut command. Needs a spec line (a
`block.cutSelection` = copySelection + deleteSelected as one undo step) before it is built; left
for the owner/coordinator to schedule.

Taken on 2026-09-13 (clipboard-sync). Plan as the entry proposed: `block.cutSelection` =
`block.copySelection`'s text on the clipboard, then `block.deleteSelected`'s ops, recorded as one
undo step; a spec row before the code.

**Fixed 2026-09-13.** `block.cutSelection` (Cmd+X / Ctrl+X, `blockSelected`) — spec row in §E and
a paragraph in R31 of `docs/spec/commands-and-keymap.md`. The copy text now comes from one function,
`editor/selection-clipboard.ts#selectionMarkdown`, which both Copy and Cut call (moved out of
`BlockTree.tsx` unchanged, plus a guard for an id no longer in the tree). The cut writes that text,
and only once the clipboard write has resolved builds `deleteSelectedBlocks` against the tree as it
is then and commits it as ONE history entry (`cutToClipboard`): with no `navigator.clipboard` (plain
http from another machine is not a secure context) or a refused write, nothing is deleted. Like
Copy, it is reached through the command registry's key binding, not `keydown.ts#resolveCommand`
(spec §E note 11). Tests: `e2e/tests/selection.spec.ts` "Cmd/Ctrl+X cuts the selection as markdown,
and one undo brings it all back (B-245)" — clipboard text, rows gone from the page and from the
server, one Cmd+Z restores all three blocks with the child still indented, on the server too; it
fails with the registration removed (clipboard stays "sentinel"). Unit:
`apps/web/src/editor/selection-clipboard.test.ts` (subtree written once, reading order, properties
kept, delete only after the write resolved, nothing deleted with no clipboard or a refused write).

Not done: no "Cut" entry in the block context menu (`app/BlockContextMenu.tsx` lists Delete but not
Copy either); `docs/wiki/pages/Keyboard shortcuts.md` is generated and was not regenerated here —
run `node docs/wiki/tools/generate-shortcuts.mjs` after merging.

---

### B-233 · `editing.spec.ts` "Enter creates a second bullet" fails when run right after `a-fresh-journal.spec.ts`
**Status:** fixed · **Severity:** low (test harness) · **Found:** 2026-09-13, impl-small · **Test:**
the spec itself

`cd e2e && NOOKLET_E2E_PORT=<port> pnpm exec playwright test tests/a-fresh-journal.spec.ts
tests/editing.spec.ts --project=chromium` → "Enter creates a second bullet and both keep their
text" sees 3 rows, not 2. Reproduced on the base commit `da85cfb` (extracted with `git archive`),
so not caused by this branch. All specs share ONE server per run (`global-setup.ts` runs once;
`playwright.config.ts`'s comment "Each spec gets its own server" is wrong), `a-fresh-journal`
leaves two blocks in today's journal, and `editing.spec.ts`'s `openJournal` only seeds a VIRTUAL
day. Presumably passes in the full suite only because of what the specs between them do — not
checked. Fix: give that test its own page (as the next test in the file already does).

**Cause, found 2026-09-13 (clipboard-sync).** Not a product bug, and not simply "a-fresh-journal
leaves two blocks". Whether it leaves ANY depends on a race: its two blocks are applied to the
browser context's own OPFS replica and pushed to the server after a 300 ms debounce, and the test
ends (context closed, replica thrown away) right after its last local assertion. Measured on
`cf08d19` with a throwaway spec between the two that read `page.read <today>` from the server:
3 runs out of 3, the server had **no** page for today at all, and `editing.spec.ts` passed 5/5 —
its `openJournal` found a virtual day and seeded exactly one block. When the push does land first
(a loaded machine, as on the day it was found), today already has two blocks and "Enter creates a
second bullet" counts 3 rows, because it asserted an absolute count of 2 against a journal every
spec shares. Deterministic reproduction: seed `- first thought\n- second thought` into today via
`page.append` from a spec that runs before `editing.spec.ts` → "Expected: 2, Received: 3".

**Fixed 2026-09-13.** The test was wrong, not the product: Enter on the first of N journal blocks
correctly adds one row. `editing.spec.ts` "Enter creates a second bullet and both keep their text"
now counts the rows it starts with and expects one more, and `a-fresh-journal.spec.ts` "Enter on a
brand-new journal day continues into the next bullet" waits until the server holds its two blocks,
so the journal every later spec sees is the same on every run instead of depending on a push
debounce. Verified: with the seeded two-block today, the old assertion fails (3 ≠ 2) and the new
one passes; `a-fresh-journal` + `editing` together passed 3 runs of 3 after the change. The test
that would have caught it is the seeded run above; it is not kept as a spec because it only
exists to prove the assertion was state-dependent.

In one of those runs, `editing.spec.ts` "typing immediately after Enter is not discarded" failed
once after the reload (1 row, expected 2: the new block and its text both gone) and passed on the
two reruns — plausibly the loss mechanism of B-247 (not verified at this point), not this bug; see there.

---

### B-334 · `SearchView.test.tsx` fails under load: its first test imports the view cold
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, m9 cleanup, full `apps/web` run at
load average ~70 · **Test:** `apps/web/src/views/SearchView.test.tsx` (the file itself)

Two tests failed in one full run ("a task marker searches blocks with that marker…" and "shows a
hint and does not search before anything is typed"); the failure output was not captured, and a
second full run at load ~40 passed. Alone at load 46 the first test took 2,201 ms and the others
2–311 ms: `renderSearch()` did `await import("./SearchView.js")` inside the test, so the first
test paid the cold import within its 5 s — the B-144 pattern. This branch had just given
`SearchView.tsx` two more imports (`describeError`, `routes/page-path.ts`), which can only have
made that import heavier.

**Fixed 2026-09-13.** The view is imported statically at the top of the test file, loaded while the
file is collected; the first test then took 33 ms. **Test:** the file itself — believed fixed on
the timing evidence, not on a reproduced failure. `JournalStreamView.test.tsx` imports its view
the same way inside a helper; not seen failing, left as it is.

---

### B-180 · The desktop app ships no built-in plugins' server halves
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, impl-plugins (by reading, not
reproduced in a built app) · **Test:** none

`packages/server/src/cli.ts#pluginDirsFor` finds the built-in plugins at `plugins/` three levels
above the CLI file, and `apps/desktop/build-sidecar.mjs` copies no `plugins/` directory into the
sidecar. So in the Mac app the `page.wordcount` op and its `page_wordcount` MCP tool do not exist,
and word-count's client half (bundled into the web build since B-103) shows no count there — its
`rpc.call("count")` has no server half to answer. Fix: ship the built-in plugins' server bundles
with the sidecar (or discover them from a resource path the sidecar sets).

**Reproduced 2026-09-13** before fixing: built the sidecar at `9402f31` (`node
apps/desktop/build-sidecar.mjs`), copied it out of the repo into an app-bundle layout and started it
the way `main.rs` does on a scratch graph: `GET /api/v1/plugins` answered `{"plugins":[]}`,
`page.wordcount` 404, 29 MCP tools and no `page_wordcount`. Shipping the `plugins/` sources would
not have been enough: the loader bundles a plugin at startup, resolving `@nooklet/plugin-api` and
`zod` through the server's `node_modules` (a bundled server has none) and writing
`.nooklet-build/` into the plugin's directory (inside the signed app; read-only when the app runs
from its disk image). Loading the packaged plugins from a read-only directory the ordinary way left
word-count in `error` (checked with a throwaway copy of the test below).

**Fixed 2026-09-13.** The built-ins ship already bundled, and the host takes them as they are.
`packages/server/src/plugins/bundled.ts#packageBundledPlugins` bundles each built-in's halves with
the loader's own `bundleServerEntry` / `bundleClientEntry` into `<out>/<name>/server.mjs` /
`client.js` plus a `package.json` pointing at them; `build-sidecar.mjs` step 6 runs it (through
`tsx`'s `tsImport`) into `sidecar/plugins/`, and fails the build if word-count is missing.
`server.mjs`'s banner sets `NOOKLET_BUNDLED_PLUGINS_DIR` (unless already set) to the `plugins/`
beside it, so `main.rs` needed no change; `cli.ts#pluginDirsFor` uses that directory instead of the
repo's `plugins/` when the variable is set, for `serve` and `plugin list|enable|disable`.
`PluginHostDeps.bundledDirs` (`createAppWithPlugins`'s `bundledPluginDirs`) marks such directories:
their entries are imported and served through `bundler.ts#alreadyBundled` — hashed, never
re-bundled, nothing written. Cost: the sidecar grows by ~13 MB (word-count's server half 1 MB with
zod inlined; mermaid's client half 12 MB, which the web build also carries — the desktop web app
compiles the client halves in and fetches none of these; shipped so Settings → Plugins lists the
same three plugins with the same halves as `nooklet serve`). **Tests that would have caught it:**
`packages/server/src/plugins/bundled.test.ts` (packages the repo's plugins, makes the output
read-only, loads it from outside any `node_modules`: all three active with the same halves, no
`.nooklet-build`, `page.wordcount` answers, word-count's client half served at its listed URL) and
the re-runnable end-to-end check `tools/probes/sidecar-plugins.mjs` (a built sidecar, copied
read-only to a temp app layout, started from `/`: before, 4 of 4 checks failed; after, 4 of 4 —
three plugins listed, `page.wordcount` 200 with the right count, `page_wordcount` among 30 MCP
tools, client half 200). The full Tauri app was not built; `tauri.conf.json` maps the whole
`../sidecar` directory as a resource, so `plugins/` rides along by reading, not by a built `.app`.

---

### B-332 · Alt+Enter on `[[Some Page]]` opens `/page/some page` — the lowercased key, not the name
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, m9 cleanup, probing B-331 · **Test:**
`apps/web/src/app/hosts.test.ts` "nav.followLink for page links", `e2e/tests/namespace-paths.spec.ts`
"Alt+Enter on a [[namespaced link]] opens it at its path"

Put the caret in `[[NSPath Area/Leaf Page]]` and press Alt+Enter ("Follow link under cursor"): the
page opens, but the address bar reads `/page/nspath%20area/leaf%20page`, while clicking the same
link gives `/page/NSPath%20Area/Leaf%20Page`. The canonical-route effect (B-104) deliberately leaves
a URL that differs from the page's name only in case, so the lowercase URL stays — in the address
bar, Back, a copied link, and the History link's comparisons. `createNavigationHost#followLink`
passed the link through `normalizePageName`, which is the lookup KEY (NFC, whitespace collapsed,
lowercased), not a display name.

**Fixed 2026-09-13.** `followLink` navigates to `pageRoutePath(link.name)` — the name as written,
exactly what a click on the rendered link does. **Tests that would have caught it:**
`apps/web/src/app/hosts.test.ts` "nav.followLink for page links" (2 of 2 failed before) and
`e2e/tests/namespace-paths.spec.ts` "Alt+Enter on a [[namespaced link]] opens it at its path"
(failed on `a9ea71a` with `/page/nspath%20area/leaf%20page`).

---

### B-331 · A rendered link to a namespaced page points at `/page/Area%2FLeaf`, not `/page/Area/Leaf`
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, m9 cleanup (review finding F9 of
`m8/rv-web-security`, whose fix `373c654` was not merged; re-probed on the merged tree) · **Test:**
`apps/web/src/editor/render/page-hrefs.test.tsx`, `e2e/tests/namespace-paths.spec.ts`,
`apps/web/src/source-guards.test.ts`

Hover, middle-click, "Copy link" or open-in-new-tab on `[[NSPath Area/Leaf Page]]` and the address
is `/page/NSPath%20Area%2FLeaf%20Page`. The page still opens — the route is a splat and the name is
decoded — which is why nobody saw it, but it is not the page's address as the app itself navigates
to it (`/page/NSPath%20Area/Leaf%20Page`), and `pathToPageName` documents that the app never
produces `%2F`. Probed with `e2e/tests/namespace-paths.spec.ts` on `a9ea71a`, every way into a
page: the `href` of a `[[link]]`, a `#[[tag]]`, a `[label]([[page]])`, a query result's page heading
and an embed's source line all carried `%2F` (six render sites: three in `editor/render/tokens.tsx`,
one in `QueryFenceView.tsx`, two in `EmbedView.tsx`, each `encodeURIComponent` over the whole
name), and so did every screen showing one of those links (a page's linked references, the shelf).
The URL after navigating was right everywhere: palette, link click, shelf card, a reference, a
tagged page, the trash and its restore notice, history and its back link, search, all pages.
Page paths were still built inline in twelve places (`hosts.ts` twice plus its own exported
`pagePath`, `Sidebar.tsx` twice, `PageView.tsx`'s history link, and the six above) besides
`views/navigateTarget.ts`, the module that had the functions.

**Fixed 2026-09-13.** Redoes `373c654` on the merged tree. `apps/web/src/routes/page-path.ts` (no
imports, so the renderer does not pull in the data layer) holds `pageNameToPath`, `pathToPageName`,
`pageRoutePath`, `pageZoomRoutePath` and `historyRoutePath`; `views/navigateTarget.ts` keeps only
`goToTarget`; `hosts.ts#pagePath` is gone (the client plugin host gets `pageRoutePath`). All twelve
inline sites and every importer go through it. A bookmarked `%2F` URL still opens the page (the
route decodes its splat) and is not rewritten. **Tests that would have caught it:**
`apps/web/src/editor/render/page-hrefs.test.tsx` (6 of 6 failed before with `%2F`: link, tag,
label, query heading, embed source, embed at the depth limit); `e2e/tests/namespace-paths.spec.ts`
(9 tests, one per way into a page; on `a9ea71a` 5 failed — the rendered hrefs, and the palette and
shelf screens that show them; after, 9/9); the guard in `apps/web/src/source-guards.test.ts`
"are built only by routes/page-path.ts" (failed before, listing the sites).

---

### B-144 · Two web unit tests fail under load: the query fence's first render and `page-title`'s first test
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, impl-dates · **Test:** the
tests themselves

On the shared machine, `pnpm -r test` and `apps/web` `vitest run` intermittently failed
`src/editor/render/render-seams.test.tsx` "says what is wrong, and where, for a query that does
not parse" (its `waitFor`, default 1 s, gives up before the lazy `QueryFenceView` import has
resolved — the DOM dump shows the plain `<pre>` fallback) and `src/data/page-title.test.ts`
"renders a journal by its day and an ordinary page by its name" (its first `vi.resetModules()` +
`import()`; message not captured). Both pass alone, every time tried (4/4). Not caused by this
branch: with `editor/BlockRowView.tsx` swapped back to `da85cfb`'s, 3 of 3 full `apps/web` runs
had one or two of these failures; with this branch's, 3 of 8 runs (counting one `pnpm -r test`)
had one, and the last 3 in a row were clean. A timed probe of the
`QueryFenceView` import alone measured 0.9–3.7 s depending on machine load. Likely fix: a longer
`waitFor` timeout on the first lazy render, and a per-test timeout on the first cold import.

**Fixed 2026-09-13.** Both tests spent their own timeout loading a module cold: `page-title.test.ts`'s
first `vi.resetModules()` + `import("./page-title.js")` (the first test measured 609–724 ms here,
every later one 1–3 ms), and `render-seams.test.tsx`'s first query fence, whose `lazy()`
`import("./QueryFenceView.js")` had to transform the view and its imports inside `waitFor`'s 1 s.
Each file now imports that module statically, so it is loaded while the file is collected, where no
timeout runs; the tests then wait on a cached module (3 ms). Evidence that this removes the load
dependency rather than widening a margin: copies of both tests with the budget cut below the cold
cost — a 150 ms test timeout for the page-title test, an 8 ms `waitFor` for the fence — failed 3 of
3 runs cold and passed 3 of 3 with the static import (probe copies deleted after; numbers only).
**Test:** the two tests themselves, `apps/web/src/data/page-title.test.ts` "renders a journal by its
day and an ordinary page by its name" and `apps/web/src/editor/render/render-seams.test.tsx` "says
what is wrong, and where, for a query that does not parse". `embed.test.tsx` already works around the
same lazy-chunk cost with a 5 s `waitFor`; left as it is.

---

### B-330 · A search or graph that cannot reach the server does not say where it tried, and several views drop the server's hint
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, m9 cleanup (review finding F8 of
`m8/rv-web-security`, whose fix `3d73b13` was not merged) · **Test:** `data/api-client.test.ts`, `views/server-errors.test.tsx`, `source-guards.test.ts`

Two ways to call a server op existed in `apps/web`: `callOp` (network failures become an
`ApiError` naming the address it tried; a rejection keeps the server's `hint`) and
`api-client.ts#createApiClient`'s private `post()`, used by `search`, `page.backlinks` and
`graph.links`, with no network wrapping. So the Search view said "Could not reach the server." (its
own regex over "Failed to fetch") and the Graph view "TypeError: Failed to fetch", where Settings
says which address it tried. Separately, the views that show a failure each formatted it their own
way — `errorText` in Search and Find & Replace, `String(err)` in Graph / Diagnostics / Settings,
`err.message` in History, Trash and the refactor alerts — and every one of those drops the
server's `hint` (`graph.replace`'s "fix the pattern, or set regex: false…"). And `batch.undo` had
three wrappers: `history.ts#undoBatch`, `refactorApi.undoBatch`, and an inline `callOp` in
`ReferencesPanel`.

**Fixed 2026-09-13.** Redoes `3d73b13` on the merged tree. `apiClient` is an object whose three
methods call `callOp` (`post`, `createApiClient` and `ApiClientOptions` are gone; `page.backlinks`
keeps its B-253 cursor walk). `refactor-api.ts#undoBatch` is the one `batch.undo` wrapper, with
History's `keepLaterEdits` / `ignoreBatches` / `kept` (B-251) moved there from `history.ts`;
`refactorApi.undoBatch` and `ReferencesPanel`'s Undo are that function. Every view that shows an
error renders it with `describeError` — Search, Find & Replace, History (Undo, Restore), Trash,
Graph, Diagnostics, Settings, the refactor alerts, and the three whose errors are not server ones
(Connect, graph mismatch, a plugin fence), so the rule has no exceptions to remember. **Tests that
would have caught it:** `apps/web/src/data/api-client.test.ts` (7 of 10 failed before: the network
cases for `search` / `page.backlinks` / `graph.links` / `batch.undo`, and the three through the shared undo
wrapper), `apps/web/src/views/server-errors.test.tsx` (3 of 3 failed
before: Find & Replace hint, Search address, History Undo hint), and the guard
`apps/web/src/source-guards.test.ts` (2 of 2 failed before: a hand-rolled formatter in a UI file,
`"batch.undo"` outside `refactor-api.ts`).

---

### B-213 · e2e "opening the palette while editing and closing it hands focus back to the editor" fails at `da85cfb`
**Status:** duplicate · **Severity:** medium · **Found:** 2026-09-13, running neighbouring specs for
embeds · **Test:** `e2e/tests/views.spec.ts` "opening the palette while editing and closing it hands
focus back to the editor" (the failing test itself)

**Duplicate of B-161.**

Not diagnosed. On port 6407 the test failed three runs out of three: twice on `m8/impl-embeds`, and
once with every existing web file this branch modifies checked out at `da85cfb` (its new modules
then unreferenced; client rebuilt by the run) — so it is not the embeds work. It fails at `expect(editor(page)).toBeFocused()` after Escape
closes the palette: `.cm-content` is still in the DOM but "inactive" for the full 10 s, so typing
afterwards would go nowhere — the B-72 symptom that test was written for. The other 118 tests in
journals/selection/context-menu/navigation/focus/phone/tasks/views passed in the same run.

*Addendum (verification pass, 2026-09-13):* order-dependent. After `b4ed719` the whole of
`views.spec.ts` passed 29/29 on 6407 — this test included — while the same test run alone
(`-g "opening the palette while editing"`) failed 3/3 with the same "inactive" `.cm-content`. Still
not diagnosed; it does not touch embeds.

---

### B-217 · `nooklet serve --help` does not print help: it opens and serves the default graph
**Status:** duplicate · **Severity:** medium · **Found:** 2026-09-13, verifying `m8/impl-embeds` (by
accident) · **Test:** —

**Duplicate of B-146**, which is fixed (`cli-args.ts#wantsHelp`).

`pnpm exec tsx src/cli.ts serve --help` (from `packages/server`, meaning "show serve's options")
ignored `--help`: it resolved `--data` to its default `~/.nooklet/default`, opened that database with
`migrate: true`, ran the dev-mode rebuild verify over its 20,411 ops, loaded plugins, and died only
because port 6100 was already taken by the owner's running app (`EADDRINUSE`). Had the port been
free it would have served — and started the live markdown mirror on — the owner's real graph. The
directory's mtimes (graph.sqlite, -wal, pages/, journals/ all 09:19:42, the command ran at ~09:26)
show nothing was written this time. `cli.ts#main` only honours `help`/`--help` as the COMMAND (the
`default:` branch); a subcommand never looks at the flag. For a repo whose working rule is "never
open ~/.nooklet/default", a help flag that opens it is a trap. Fix direction: any `--help`/`-h` flag
prints `USAGE` and exits before `dataDir()` is ever called.

---

### B-173 · B-72's "palette closes and hands focus back to the editor" e2e fails on da85cfb
**Status:** duplicate · **Severity:** low · **Found:** 2026-09-13, impl-journal (running
`views.spec.ts` alongside the journal specs) · **Test:** `e2e/tests/views.spec.ts` "opening the
palette while editing and closing it hands focus back to the editor"

**Duplicate of B-161.**

Fails 2 of 2 on this branch and 1 of 1 on a clean `git archive da85cfb` checkout (port 6403,
load average ~17): after Escape closes the palette, `.cm-content` is "inactive" rather than
focused for the whole 10 s. So it predates this branch. Not investigated: whether it is a
regression of B-72 since 2026-09-12 or something about headless focus on a loaded machine.

---

### B-182 · Closing the command palette with Escape leaves the editor unfocused again
**Status:** duplicate · **Severity:** medium · **Found:** 2026-09-13, impl-plugins (regression of a
B-72 fix) · **Test:** `e2e/tests/views.spec.ts` "opening the palette while editing and closing it
hands focus back to the editor" — currently failing

**Duplicate of B-161.**

Edit a block, Cmd/Ctrl+K, Escape: the palette closes but `.cm-content` is no longer focused, so the
next keystroke goes nowhere. The e2e test B-72 added for exactly this fails on `da85cfb` itself
(1 run, port 6404, production build) and on `m8/impl-plugins` (2 runs), each time with
`toBeFocused` → "inactive" after 10 s — so it is not load and not the plugin host. Not
investigated beyond establishing that; which commit between B-72's fix and `da85cfb` broke it is
the next question (`git bisect` over `e2e/tests/views.spec.ts -g "opening the palette"`).

---

### B-252 · `block.update` with `old_str`/`new_str` fails on any block that has a property
**Status:** duplicate · **Severity:** medium · **Found:** 2026-09-13, in passing while writing the B-251
tests · **Test:** none yet

**Duplicate of B-172**, which describes the same failure more broadly (a property line or a second line).

`page.create` `- one`, `block.update {content: "two", properties: {status: "draft"}}`, then
`block.update {old_str: "two", new_str: "two, edited later"}` answers 400 `content must describe
exactly one block`. The same happens after `content: "DONE two"` (the `done::` property). Seen in
a vitest run against `makeTestServer`; not yet reduced further.

Likely cause, unverified: `outline-bridge.ts#renderSingleBlockText` strips the two-space indent
from the property lines, and `parseSingleBlockGrammar` re-parses the replaced text as
`- two, edited later\nstatus:: draft`, where the unindented property line is a second block.
Agents editing any block with properties (every DONE task, 700 on the owner's graph) by
`old_str` hit this.

---

### B-193 · `views.spec.ts` "opening the palette while editing and closing it hands focus back to the editor" fails here, on the base commit too
**Status:** duplicate · **Severity:** low · **Found:** 2026-09-13, impl-editor's wider e2e run ·
**Test:** `e2e/tests/views.spec.ts` "opening the palette while editing and closing it hands focus
back to the editor" (B-72's test)

**Duplicate of B-161.**

Cmd/Ctrl+K while editing, Escape: the palette closes, but `.cm-content` is not focused ("inactive")
for the whole 10 s wait. Failed 3 of 3 runs on `m8/impl-editor` (port 6405), and 1 of 1 with
`apps/web` checked out at `da85cfb`, so this branch did not cause it. Not diagnosed. The
coordinator's full run on `a6c2859` did not list it as failing, and nothing under `apps/web` or
`e2e/` changed between `a6c2859` and `da85cfb` — so either it is load- or machine-dependent (the
machine was running a dozen agents' builds and browsers) or that run passed it by chance. Next
step: run the single test on an idle machine; if it still fails, trace focus on Escape
(`e2e/helpers/focus.ts#installFocusTrace`).

Verification pass, same branch and port, later the same day: `views.spec.ts` passed in full (with
parity, popups, autocomplete, journals, a-fresh-journal, tasks, replace, query and phone: 122 of
122), so the failure is intermittent or load-dependent rather than deterministic.

---

### B-226 · `views.spec.ts` "opening the palette while editing and closing it hands focus back to the editor" fails at `da85cfb`
**Status:** duplicate · **Severity:** medium · **Found:** 2026-09-13, e2e run for
this branch · **Test:** that test

**Duplicate of B-161.**

After Cmd/Ctrl+K and Escape the palette closes but `.cm-content` never regains focus
(`toBeFocused` times out at 10 s; the locator resolves, state "inactive"). Failed 6 of 6 runs on
port 6408, Chromium: in a 12-spec batch; in `views.spec.ts` alone; alone with `-g` on this branch;
alone with the title-row controls removed; alone with the page-action commands and print hookup
also removed; and alone with `apps/web/src`, `packages/core/src` and `packages/server/src`
checked out from `da85cfb` (production build, fresh server) — so it is not caused by this branch. The coordinator's full run at `a6c2859` did not list it among
failures, so either `06fd859`/`da85cfb` or the machine's state since then changed something;
neither was checked. B-72's fix names this test. Nothing in `CommandPalette.tsx` restores focus
explicitly, so whatever used to return it to the editor is worth finding first.

**Note (adversarial verification, 2026-09-13):** order-dependent, not simply broken. On this branch
at `14272fc` it **passed** inside a full `views.spec.ts` run (batch with page-export, pages,
page-icons, phone, navigation, history: 72 passed) and **failed 3 of 3** run alone with
`-g "hands focus back" --repeat-each=3`. The same test is already logged by other branches as
B-161 (`impl-commands`), B-193 (`impl-editor`) and B-246 (`qafix-editor`) — merge as one entry.

---

### B-246 · `views.spec.ts` "opening the palette while editing and closing it hands focus back to the editor" fails at da85cfb
**Status:** duplicate · **Severity:** low (test or focus regression, undiagnosed) · **Found:**
2026-09-13, while regression-running e2e for B-243 · **Test:** the one named

**Duplicate of B-161.**

Mod+K while editing, Escape: the palette closes and `.cm-content` is never focused again
(`toBeFocused` times out, "inactive"). Fails 3/3 on port 6460: twice in the full `views.spec.ts`
with this branch's changes, and once alone and once in the full spec with `apps/web/src` checked
out at `da85cfb`, so it is not caused by this branch. The coordinator's last full run on
`a6c2859` did not list it among failures. Nothing in `apps/web/src` explicitly returns focus to
the editor when the palette closes (no `focus()` call in `CommandPalette`/`palette-controller`),
so whatever made it pass before is worth finding before "fixing" the test. Order matters: it
PASSED once, in a run of context-menu + focus + help + undo-redo + views on one server (views
last), and failed again right after, alone and as the whole views spec. So it depends on what
the server or client went through first, not only on the code. Not investigated further on this
branch.

---

### B-270 · Closing the command palette with Escape leaves the editor unfocused
**Status:** duplicate · **Severity:** medium · **Found:** 2026-09-13, rv-web-reactivity's broader
e2e pass · **Test:** `e2e/tests/views.spec.ts` "opening the palette while editing and closing it
hands focus back to the editor" (B-72's regression test) — failing

**Duplicate of B-161** (the same failing test, seen from the reactivity review).

Edit a block, press Mod+K, press Escape: the palette closes but `.cm-content` is not focused, and
typing goes nowhere. Failed three times in a row on port 6472 at load average ≈35 — twice on this
branch and once with every source file this branch changes restored to `da85cfb`, so it predates
the branch. Not investigated; it may be timing under load, but it did not pass once.

---

### B-146 · `nooklet serve --help` ignores `--help` and serves the owner's real graph — migrating it and rewriting its mirror
**Status:** fixed · **Severity:** high (data safety; every agent on this machine is told never to
open `~/.nooklet/default`) · **Found:** 2026-09-13, verify-impl-dates — by doing it, by accident ·
**Test:** none yet

`pnpm nooklet serve --help`, run to read the flags, printed no usage: `cli-args.ts#parseArgs`
turns `--help` into an ordinary flag nothing reads, `cli.ts` only prints usage for a top-level
`help`/`--help`, and `serve` with no `--data` falls back to `$NOOKLET_DATA`, then
`~/.nooklet/default`. It opened the owner's graph with `migrate: true` and the live mirror on, and
listened on port 6100 until killed (~10 minutes later).

What it changed in `~/.nooklet/default`, measured against a `sqlite3 .backup` taken 33 s before it
started (09:19:07; server wrote from 09:19:40): `schema_migration` 1 → 3 rows (migrations "derive
page_alias … (B-55)" and "add idempotency … (B-58)" applied), `page_alias` 0 → 3 rows, `setting`
+1 row (`refs.pipe_alias`), `mirror_file` 0 → 952 rows, and all 952 `journals/*.md` +
`pages/*.md` files rewritten (mtime 09:19:41). `block`, `page`, `op`, `block_prop`, `page_prop`,
`ref`, `device`, `token`, `changes` are byte-identical to the backup (row dumps hashed). The
mirror is derived from the DB (never read back), so the rewrite loses nothing the DB holds; what
the files said before is not recoverable here. The pre-incident DB copy was kept at
`<verify scratch>/graph/graph.sqlite` (session scratch, not durable).

Fix direction (not done — `cli.ts` is shared): `--help` / `-h` on any subcommand prints that
command's usage and exits 0 before `open()`; arguably unknown flags should be an error for writers.

**Fixed 2026-09-13.** `cli.ts#main` checks `cli-args.ts#wantsHelp` (`--help`, `-h`, or `help` in
any position) before any command runs, prints usage and returns — no graph is opened. Verified by
`NOOKLET_DATA=<scratch> pnpm nooklet serve --help`: usage printed, no data dir created. The owner's
graph content was unchanged by the incident (block 18,628 rows and op max seq 20,411 before and
after; the verifier's row hashes of every content table matched); the pre-incident copy is kept
at `~/.nooklet/backup-2026-09-13-before-accidental-serve.sqlite`. Test:
`packages/server/src/cli-args.test.ts` "--help, -h or help in any position is a request for usage,
never a command (B-146)".

---

### B-138 · Block text reaches the render sinks unchecked: `javascript:` links, app classes, page-sized formulas
**Status:** fixed · **Severity:** low (security hardening) · **Found:** 2026-09-13, web review
(F4, F5, F6) · **Tests:** `e2e/tests/untrusted-content.spec.ts` (one test per sink);
`apps/web/src/editor/render/untrusted-content.test.tsx`; `apps/web/src/app/hosts.test.ts`

**As merged:** the fence info-string and KaTeX size fixes landed. The link-scheme *allowlist* did not: B-268 had already landed a *denylist* of script-capable schemes (`editor/render/safe-href.ts`), which keeps app links such as `zotero://` working; Alt+Enter goes through the same guard.

Block text arrives by sync, import and MCP agents, so anything it can make the renderer do, a
synced device or an agent can do. Three sinks took it as given:

1. **Links (F4).** `[x](javascript:alert(document.domain))` rendered as
   `<a class="vr-link" href="javascript:…">`, and Alt+Enter handed the same href to `window.open`.
   In Chromium and WebKit neither ran script in the app origin (where `localStorage` holds the
   device token), but only because both sinks carry `target=_blank`/`noopener` — the review's
   probe leaked the token from the same anchor without `target`. The SPA sends no CSP, and the
   Tauri WKWebView (`csp: null`) was not tested. Reproduced in the e2e test before the fix: the
   anchor carried `href="javascript:alert(document.domain)"`.

**Fixed 2026-09-13 (links).** `editor/render/asset-url.ts#safeHref` allows http, https, mailto, tel
and relative hrefs, reading the scheme with the WHATWG URL parser so `java\tscript:` or a leading
control character resolve as the browser would; anything else renders its label with no `href`,
and `followLink` opens nothing. The allowlist is exactly what the owner's graph uses (2,298 links:
https/http/relative/mailto/tel — `tools/probes/link-schemes-in-graph.ts`), so no existing link
lost its target; an app scheme added later (`zotero://`) needs adding there.

2. **Code fence classes (F5).** The whole fence info string went into `<code class>`, so
   ```` ```js cmd-overlay ```` gave `class="language-js cmd-overlay hljs"`: any app class, including
   the command palette's fixed full-screen `.cmd-overlay` scrim, from one synced block. Inside the
   outline `.vr-row`'s `content-visibility: auto` contains a fixed descendant to its row; in the
   Shelf, which has no containment, it covers the viewport. Reproduced in the e2e test before the
   fix (`["language-js", "cmd-overlay", "vr-row", "hljs"]`).

**Fixed 2026-09-13 (fence classes).** `editor/render/highlight.ts#languageClass` takes the first
word only — the rule `resolveLanguage` already used for the grammar — reduced to `[\w+-]`; both
branches of `CodeFence` use it. `data-lang` keeps the raw info string (an inert attribute value).
In the owner's graph every fence info string but one is a single language word; the exception is a
log line pasted after the backticks, which now yields `language-Wed`.

3. **Formula sizes (F6).** KaTeX ran with its default `maxSize` of Infinity, so
   `$\rule{99999em}{99999em}$` painted a box 99,999em square: the e2e test measured its row at
   1,574,998 px tall before the fix. `\raisebox{99999em}` and `\hspace{99999em}` did the same.

**Fixed 2026-09-13 (formula sizes).** `editor/render/math.ts#renderTexSync` passes `maxSize: 20`,
which KaTeX applies to `\rule`, `\raisebox` and `\hspace`. `\kern` is not capped by KaTeX; it
shifts content sideways, and the e2e test checks a `\kern99999em` block does not widen the page.
The review also suggested `display: inline-block; overflow: hidden` on `.vr-math-rendered`; not
done: `tools/probes/inline-block-clip-baseline.mjs` shows it lifts every formula 11 px off the text
baseline in Chromium and WebKit, and clipping would not stop a tall box growing its row anyway.
`math.test.ts` (real KaTeX; failed before) and the e2e test above.

---

### B-139 · Alt+Enter on a `((block ref))` does nothing
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, reading `app/hosts.ts` for B-137 ·
**Tests:** `e2e/tests/follow-link.spec.ts` "Alt+Enter on a block ref opens the referenced block on
its page"; `apps/web/src/app/hosts.test.ts` "nav.followLink for block refs"

Put the caret inside `((<block id>))` and press Alt+Enter ("Follow link under cursor"): nothing
happens — the URL stays on the current page. Reproduced in the e2e test before the fix (received
`/page/Follow%20Ref%20Source`).

**Fixed 2026-09-13.** `followLink`'s block case resolved the page through
`NavDeps.pageNameForId(link.id)`, but B-82's fix wired `pageNameForId` to
`store.ts#resolvePageName`, which looks the id up in the PAGE table, so a block id never matched and
the navigation was silently skipped. The block case now asks `resolveBlockPageName` (as
`revealBlock` already did) and zooms with `pageZoomRoutePath`.

---

### B-137 · Alt+Enter on an asset link opens a blank app page instead of the file
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, web review (F3) · **Tests:**
`e2e/tests/untrusted-content.spec.ts` "Alt+Enter on an asset link opens the asset from the server
root, not below the page route"; `apps/web/src/app/hosts.test.ts`

Put the caret in `[spec](../assets/x.pdf)` on `/page/Projects/Aurora` and press Alt+Enter ("Follow
link under cursor"): the new tab opens `/page/assets/x.pdf` — the app shell, not the PDF.
Clicking the same rendered link works. B-51 again, on the keyboard path. Reproduced in the e2e
test before the fix ("Received: http://127.0.0.1:6473/page/assets/rv-sec-spec.pdf"). With
`VITE_API_BASE_URL` pointing at another server even a root-relative path went to the wrong origin.

**Fixed 2026-09-13.** `createNavigationHost#followLink` handed the token's raw href to
`window.open`, which resolves a relative URL against the current route; the rendered `<a>` goes
through `editor/render/asset-url.ts#assetUrl`, and now so does this.

---

### B-136 · History, Trash and a query fence sit on "Loading…" forever when their read fails
**Status:** duplicate · **Severity:** medium · **Found:** 2026-09-13, web review (F2) · **Tests:**
`e2e/tests/load-errors.spec.ts` "History says it could not load, and Retry recovers", "Trash says
it could not load, and Retry recovers"; `apps/web/src/views/load-errors.test.tsx` (all three
views)

**Duplicate of B-131.** B-131's fix is what landed.

Open `/history/<page>` or `/trash` while the server is unreachable (or answers 401, or does not
know the page yet): "Loading…" stays indefinitely and the "Could not load … Retry" line never
appears; the error surfaces only as an unhandled rejection in the console. A ```` ```query ````
fence whose evaluation fails stays on "Running query…" and never says "Query failed". B-10 and
B-80 again, in the M7 views. Reproduced in both tests above before the fix.

**Fixed 2026-09-13.** Reading an errored Solid resource — `resource()` and `resource.latest` both —
re-throws, and each view read its resource directly in a `when` or `each`. With no error boundary,
the throw discarded the render pass, so the error branch the views already had was never written.
Every read now goes through a guard that returns `undefined` while the resource is errored:
`usePageHistory` exposes `page` (and derives `batches`/`hasMore`/`loadMore` from it),
`TrashView` reads `list()`, `QueryFenceView` reads `latest()` and drops "Running query…" once the
evaluation has failed. "Older changes" failing now says so too instead of rejecting silently.

---

### B-135 · After opening Trash or History, pages stop updating until a reload
**Status:** duplicate · **Severity:** high · **Found:** 2026-09-13, web review (F1) · **Tests:**
`e2e/tests/change-bus.spec.ts` "a page still picks up an API write after the Trash view was opened
and left"; `apps/web/src/db/client.test.ts`

**Duplicate of B-130** (found by two reviewers the same morning). B-130's fix is what landed; this branch's version of the change-bus fan-out was not merged.

Open a page, open Trash from the sidebar, press Back, then have an agent append a block over the
API: the page keeps showing its old content indefinitely (15 s and counting), although the write
reached this device. The same holds for the journal stream, All Pages, tasks, backlinks, query
fences and `((ref))` text, and the sync indicator stops moving. A reload fixes it until Trash or
History is opened again. Reproduced in the e2e spec above before the fix ("Received string:
first").

**Fixed 2026-09-13.** The worker keeps one change callback and one sync-status callback, each
registration replacing the last, and `db/client.ts` forwarded every subscription straight through.
`data/history.ts` subscribed its own copy of the invalidation bus the first time Trash or History
rendered, which unplugged `data/store.ts`'s — and store's "already wired" flag meant it never
plugged back in. `db/client.ts` now registers with the worker once and fans out to a set of
subscribers (each gets an unsubscribe; one throwing listener cannot starve the rest).
`history.ts` no longer keeps its own counters: it stamps through store's new `serverStampedFor`.
The push-queue-drained bump (B-83) moved from `useSyncStatus` into store's wiring, so it no longer
depends on the sync indicator being mounted and fires once per drain rather than once per mounted
indicator; `useSyncStatus` unsubscribes on cleanup, so Diagnostics opening and closing does not
leak listeners. `client.test.ts` fails against a pass-through client (single-slot fake worker);
`change-bus.spec.ts` fails against the old build.

---

### B-134 · Replace all can write a replacement or flags other than what the fields show
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, web reactivity review (F7) ·
**Tests:** `e2e/tests/review-reactivity.spec.ts` "Replace all pressed right after editing the
replacement writes the edited text (B-134)"; `apps/web/src/views/FindReplaceView.test.tsx` "does
not write the debounced replacement when the field changed a moment ago", "does not write a flag
the preview on screen was not computed with", "is disabled while the preview for the current
fields is still loading"

**Merged as B-250's implementation** (the same bug, found twice). The e2e test named here was kept and passes against B-250's fix.

Change the replacement text (or flip Regex / Match case) and press Replace all within 250 ms: the
old replacement or flags are written. Likewise while the new preview is still loading, the button
stays enabled on the old preview's matches. `replaceAll()` sends the debounced `input()` and
`canReplace` ignores `preview.loading` — against the page's promise that the preview is exactly
what the real run writes.

**Fixed 2026-09-13.** `replaceAll` builds its request from the live fields, and `canReplace` —
which `replaceAll` also checks — requires the debounced input to equal the live fields and the
preview not to be loading, so the button is disabled from the edit until the matching preview is on
screen. Reproduced first in a real browser: fill "wombat", wait for its preview, fill "numbat" and
click at once — the unfixed page wrote "the wombat smiles"; with the fix Playwright's click waits
for the button to re-enable and "the numbat smiles" is written.

---

### B-133 · A ```query hit nested more than 60 blocks deep into another hit is counted but not shown
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, web reactivity review (F5) ·
**Tests:** `e2e/tests/review-reactivity.spec.ts` "a query hit nested past the 60 rendered
descendants of another hit is still shown (B-133)"; `apps/web/src/data/queries.test.ts` "lists a
nested hit on its own when its ancestor's rendered subtree was cut before it", "a cut-off hit
brings its own nested hits back with it, each listed once"

A `TODO` project block with 70 child notes and then a `TODO` subtask: the fence header says
"2 blocks on 1 page" but only the project and its first 60 descendants render — the subtask is
nowhere. `runQuery` folds a hit under its ancestor hit whenever it is anywhere in the ancestor's
depth-3 subtree, but `toResultBlock` stops emitting after `QUERY_CHILD_CAP` (60) descendants.

**Fixed 2026-09-13.** `toResultBlock` records every descendant it actually emits; `runQuery`
renders the outermost hits first, then lists on its own any shown hit none of them emitted
(outermost of those first, so a promoted hit's own nested hits stay folded under it and nothing is
listed twice). `nested` now counts hits that are really rendered nested. Both the unit case and the
e2e case failed first (the subtask absent). On a copy of the owner's graph (952 pages, 686 task
markers, no `TODO`s — it uses LATER/NOW/DONE) the shape does not occur today: `DONE`, `LATER`,
`NOW`, `WAITING` and `DONE limit:1000` give identical counts before and after, nothing missing,
no id rendered twice.

---

### B-132 · A page's History skips changes when the graph changes during "Older changes", and Restore skips them too
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, web reactivity review (F4) ·
**Tests:** `e2e/tests/review-reactivity.spec.ts` "History lists every batch when the graph changes
while Older changes is loading (B-132)"; `apps/web/src/data/history.test.ts` "a refresh that lands
while an older page is in flight leaves no hole in the timeline"

Click "Older changes" while an agent or another device writes anything: the timeline can come back
with a hole (reviewer's model: `32,31,30,29,28` then `25,24,…` — 27 and 26 never shown, and later
"Older changes" clicks continue below the hole). "Restore this version" below the hole undoes only
the batches it lists, so it skips the hidden ones and still reports "Restored".

`usePageHistory`'s first page refetches on any change and clears the appended pages when it
resolves; an in-flight `loadMore` then appends its page (fetched from the old cursor) on top of the
new first page. The server cursor is "older than seq X", so the k batches between the new first
page's end and the old cursor are lost.

**Fixed 2026-09-13.** `usePageHistory` keeps a generation counter, bumped when a first page lands
(the moment the appended pages are dropped); `loadMore` captures it before its request and drops
its answer if it changed, so the next click pages on from the new first page. Reproduced first in a
real browser: the e2e case holds the cursor request with `page.route`, appends two batches through
the API, lets the refresh land, then releases — against the unfixed client the listed batch ids
were missing exactly the two between the new first page and the old cursor; with the fix all 33
are listed in order. The unit case failed with `gaps = [27, 26]`.

---

### B-131 · A failed load shows nothing: Trash and History stay on "Loading…", a query fence on "Running query…"
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, web
reactivity review (F2, F3, F6, F8) · **Tests:** F2 — `e2e/tests/review-reactivity.spec.ts` "a
failed trash load says so and Retry recovers, instead of Loading… forever (B-131)" and "a failed
history load says so…"; `apps/web/src/views/TrashView.test.tsx`, `HistoryView.test.tsx` "shows the
error with Retry instead of Loading…, and Retry recovers". F3 —
`apps/web/src/editor/render/QueryFenceView.test.tsx` 'says "Query failed" with the reason instead
of "Running query…" forever' (unit only: no way found to make the worker's query reject in a real
browser). F6 — `e2e/tests/review-reactivity.spec.ts` "a failed Older changes says so instead of
silently re-enabling the button (B-131)"; `HistoryView.test.tsx` "a failed Older changes says so,
and the button still works afterwards". F8 — `apps/web/src/views/VirtualJournalDay.test.tsx`
"keeps the typed line and says why when the journal template cannot be loaded (B-131)", "keeps the
typed line, drops its caret request, and can try again when the write fails (B-131)" (unit only:
the local worker cannot be made to fail from Playwright)

Four paths where a failure never reaches the screen:

- **Trash / History (F2).** When `trash.list` or `page.history` fails (server unreachable, 401),
  the view stays on "Loading…"; the "Could not load … Retry" line never appears and the error is an
  unhandled rejection. `TrashView` reads `items()` and `usePageHistory` reads `first()` unguarded,
  and reading an errored Solid resource re-throws — the B-10/B-80 lesson, missed in two M7 views.
- **```query fence (F3).** When the evaluation rejects (worker gone, a SQL error) the fence says
  "Running query…" forever; `results.latest` re-throws on error, before `<Show when={results.error}>`
  can render "Query failed".
- **History "Older changes" (F6).** A failed request re-enables the button with no message;
  `loadMore` has no catch and the click handler discards the promise.
- **A new journal day's first line (F8).** `VirtualJournalDay#materialize` swaps the draft
  textarea for the real tree before awaiting the template, the clock and `applyOps`; if any of
  those rejects, the day shows an empty outline for a page that was never written, the typed text
  is gone, and nothing says why.

**Fixed 2026-09-13 — F2 (Trash / History).** Every read of the two resources goes through a guard
that returns `undefined` while the resource is errored: `TrashView`'s `list()`, and
`usePageHistory`'s new `firstPage()` (which `batches`, `hasMore`, `loadMore` and HistoryView's
`when`s read). The error lines render with `describeError`, so a server hint is not lost. The
component tests failed first (stuck on "Loading…", unhandled "could not reach server").

**Fixed 2026-09-13 — F3 (```query fence).** `QueryFenceView` reads `results.latest` through a guard
that returns `undefined` while the resource is errored; "Running query…" shows only while there is
no error, and "Query failed:" renders `describeError(results.error)` (no "Error: " prefix). The
component test ran the real `useQueryResults` over a rejecting `queryAs` and failed first
("Running query…", unhandled "worker gone").

**Fixed 2026-09-13 — F6 (Older changes).** The button calls `HistoryView#loadOlder`, which catches
and shows "Could not load older changes: <reason>" in the view's alert line; the button is
re-enabled and a second click retries. `loadMore` itself still rejects, so any other caller can
tell a failure from "nothing older". The component test failed first (no alert, unhandled
rejection).

**Fixed 2026-09-13 — F8 (new journal day).** `materialize` wraps loading the template, the clock
and `applyOps` in one try; on failure it clears the caret request it made, puts the placeholder back
(`draft()` still holds the text) and shows "Could not start this day: <reason>" under it. The next
blur or Enter tries again. `SyncClient.applyLocal` is one transaction, so a failure there leaves
nothing half-written. The component tests failed first (no alert, textarea gone, unhandled
rejection).

---

### B-130 · After visiting Trash or a page's History, no other view refreshes until a reload
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, web reactivity review (F1) ·
**Tests:** `e2e/tests/review-reactivity.spec.ts` "after visiting Trash, an open page still picks up
a write made elsewhere (B-130)"; `apps/web/src/db/client.test.ts` "two onChange subscribers both
receive a ChangeEvent" (and four more); `apps/web/src/data/history.test.ts` "a store.ts resource
still refetches on a change after Trash has subscribed", "two useSyncStatus() callers (the shell
and the diagnostics panel) both see a status"

Open `/trash` or any page's History once, then go back to a page and edit, or let another device
write: page trees, the journal stream, the sidebar, Tasks, page icons, ```query fences and `((ref))`
text keep showing the old state until the tab reloads. The sync indicator freezes too, and so does
B-83's backlinks refresh after a push lands. Opening the Diagnostics panel freezes the shell's
sync indicator the same way.

The worker keeps exactly one change listener and one sync-status listener
(`db/db.worker.ts` `changeListener = cb`), and `db/client.ts` forwarded every `onChange` /
`onSyncStatus` call straight to it. `data/history.ts` subscribes on first use, replacing
`data/store.ts`'s listener; `store.ts` never re-registers. `useSyncStatus()` registers once per
call, so AppShell and DiagnosticsPanel replace each other.

**Fixed 2026-09-13.** `db/client.ts` registers one Comlink proxy per listener kind with the worker,
on first use, and fans out to a set of subscribers; `onChange`/`onSyncStatus` return an
unsubscribe, a throwing subscriber is logged and does not starve the others, and `useSyncStatus`
unsubscribes on cleanup. The worker keeps its single slot — `client.ts` is now its only caller.
Reproduced first: the e2e case failed at "after trash" against the unfixed client and passes with
the fix; the `history.test.ts` case failed at the refetch-after-Trash assertion (0 refetches).

---

### B-91 · A deduplicated re-upload of an orphaned asset leaves no trace, so asset GC can collect it
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, building orphan-asset GC (ADR 022 §5)
· **Test:** `packages/server/src/gc.test.ts` "a recent audit row for the asset extends its grace"
pins the GC side; the store side: `packages/server/src/ops/asset-upload.http.test.ts` "dedups identical
bytes: a second upload returns the same asset and leaves an audit row"

`storeAssetBytes` (`packages/server/src/assets/store.ts`) returns the existing row when the same
bytes are uploaded again and writes nothing — no `changes` row, no timestamp. If that asset was an
orphan (its last block dropped the link months ago), it is still an orphan the moment the upload
returns; the block op that embeds it again is on the device, not the server, until the next push.
A `nooklet gc` inside that window removes the file, and the push then embeds a link to nothing.
Narrow (identical bytes, previously orphaned, GC run while the device is offline), but it is the
exact case the grace period exists for. Fix: on dedupe, write the same `changes` row a fresh
upload writes — `planAssetGc` already treats a recent audit row as "touched".

**Fixed 2026-09-12.** The dedupe branch of `storeAssetBytes` writes the same kind of `changes` row a
fresh upload writes (before = after = the stored asset's descriptor, so `changes_since` still
reads it as "uploaded"), which `planAssetGc` already counts as "touched within the grace".

A second way asset GC collects an asset something still needs (F10): `referencedAssetIds` scans
current block content and property values only. `batch.undo` — the mechanism `page.history`
tells clients to restore a version with (ADR 022 §3) — rewrites block text from
`changes.before_json`. Remove an image link by editing the block (nothing goes to the trash), run
`nooklet gc` more than 7 days later: the asset row is tombstoned and the file unlinked; undoing
the edit then brings back a link to nothing, recoverable only from the pre-GC backup archive.
Found by reading the code, not probed.

**Fixed 2026-09-13.** `gc.ts#referencedAssetIds` also reads page/block pre- and post-images in
`changes`; an asset mentioned only there is kept and counted as `keptByHistoryOnly` (the CLI line
reports it). Asset rows' own audit entries are excluded. ADR 022 §5 amended with the cost: since
`changes` is never trimmed, an asset any recorded write ever embedded is never collected — the
GC now collects only uploads no write pointed at. That trade (restore fidelity over disk) is the
reviewer's primary suggestion and matches ADR 022's own reasoning, but it narrows what GC does;
the rejected alternatives are recorded there in case the owner prefers the other side. Tests:
`packages/server/src/gc.test.ts` "keeps an asset that only page history still references, so
restoring that version keeps its image" (fails before: the asset was an orphan) and "does not
count an asset's own upload audit row as a reference". The owner's graph copy has no `asset` rows,
so there was nothing real to measure.

---

### B-124 · A query for `[[X]]` misses blocks whose only reference to X is in a property
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, M7 server/sync review (F7) ·
**Test:** `packages/core/src/query-prefilter-refs.test.ts` "keeps blocks whose only reference is an
alias:: item or a link in another property"

The SQL prefilter for a `ref` term (`core/query.ts#termSql`) passes only blocks with `#` or `[[`
in the content, or a `tags` property. `extractRefs` — which `matchQuery` and backlinks use — also
reads `alias::` and every other property value. So `date-saved:: [[Sep 7th, 2026]]` on a block with
plain content shows in the day's backlinks but never in `ref:"2026-09-07"`; the prefilter breaks
its own promise to return a superset. Probe: `related:: [[Foo]]` and `alias:: Foo` blocks match in
JS, prefilter returns neither. The owner's graph has 55 live blocks whose only references are in
properties (`date-saved`, `date-published`).

**Fixed 2026-09-13.** The `ref` fragment's property clause now reads the way `extractRefs` does:
a `tags` or `alias` row, or a `#`/`[[` in any property value. The test checks the prefilter is a
superset of `matchQuery` over content-only, `related:: [[Foo]]`, `alias:: Foo` and
`date-saved:: #Foo` blocks, and still excludes a block with no reference syntax; it fails before
(only the content block passed). On the owner's graph copy the new clause admits exactly the 55
blocks (84 page/tag `ref` rows) the old one dropped, and no live block with a non-`Task` `ref` row
is excluded any more. (`Task`, derived from the marker server-side, is not something `extractRefs`
sees either, so the two still agree there.)

---

### B-86 · `[[Page|label]]` links are indexed under the key `page|label` and never resolve
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, probing the reference rewrite ·
**Test:** `packages/core/src/refs.test.ts` "[[Target|label]] refs the target, not 'target|label'
(B-86)"; `packages/server/src/ref-reindex.test.ts`

Write `[[Target|the target]]` in a block: `Target`'s backlinks do not list it, the link is not a
graph edge, and a rename of `Target` does not rewrite it. `ref.dst_page_key` for that block is
`target|the target` with `dst_page_id = NULL`. `packages/core/src/refs.ts#addPageRef` takes the
whole `[[…]]` interior as the page name; `tokens.ts#tryWikilink` already splits the top-level
pipe (`target` + `alias`), so `extractRefs` is the one reader that does not. The M7 reference
rewrite (`data-api.ts#buildRefRewriteOps`) handles the pipe form when it meets one, but it finds
candidate blocks through `ref`, so a block whose only link to a page is a `[[Page|label]]` is not
rewritten by a rename or a merge until this is fixed.

**Fixed 2026-09-13.** `refs.ts#addPageRef` splits on the top-level pipe with `tokens.ts`'s own
`findTopLevelPipe` (now exported), so both readers agree. Graphs indexed before the fix are
re-indexed once by `ref-reindex.ts#reindexPipeAliasRefs` (blocks with a `|` in `dst_page_key`
only; gated by setting `refs.pipe_alias`), run from the writer commands' migrate step. The owner's
graph had zero such rows.

The one-time migration (`ref-reindex.ts#reindexPipeAliasRefs`) rebuilds `ref` only (F6).
`path_ref`, which backlinks and backlink counts read, keeps `page_key = 'target|label'` with
`page_id = NULL` for the block and its descendants, and the migration's done-flag stops it from
ever running again — so a graph indexed before the fix still omits every old `[[Target|label]]`
from `Target`'s backlinks. Probe: after resetting `ref` and `path_ref` to the pre-fix keys and
running the migration (returns 1), `page.backlinks {target: "Target"}` → `linked: []`. The owner's
graph has 0 such rows; other graphs are affected.

**Fixed 2026-09-13.** The re-index rebuilds each candidate block with `reindexBlockAndSubtree`
(now exported from `apply-ops.ts`) — `ref` for the block, `path_ref` for it and every descendant —
and finds candidates through either table (a `|` in `ref.dst_page_key` or `path_ref.page_key`).
Its done-flag is a new key (`refs.pipe_alias.path_ref`), because a graph that already ran the first
version has clean `ref` rows and stale `path_ref` rows, and must run once more. Tests:
`packages/server/src/ref-reindex.test.ts` "rebuilds path_ref too, so the old links show in
backlinks again, children included" (fails on the old code: stale `path_ref` rows remain) and "runs
again on a graph whose first re-index fixed ref but left path_ref stale". The owner's graph copy:
0 rows with `|` in either table.

---

### B-123 · `nooklet verify` reports divergence after a late push loses a page-name collision
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, M7 server/sync review (F5) ·
**Test:** `packages/server/src/verify-rejected.test.ts` "a late un-delete that lost its page name to
a newer page is not a divergence" and "an offline laptop's journal day that lost to an agent's
page_append is not a divergence"

`verifyRebuildParity` replays every logged op, rejected ones included, and core re-sorts by HLC.
Whether a `page.create`, `page.rename` or un-delete is rejected depends on state, so a late push
carrying an older HLC wins the name on replay although the server rejected it. Pull never ships
rejected ops, so no client sees them. Realistic case: a laptop offline since before today's journal
existed creates the day and types into it; an agent `page_append`s to today; the laptop pushes and
its `page.create` and `block.create` are rejected → `verify` reports 4 divergences. (That the
laptop's typed text is rejected at all is a separate sync-protocol question — see sql-schema.md
open issue 2.)

**Fixed 2026-09-13.** `verify.ts#loadOps` replays only ops not logged `rejected`, in `seq` order;
the report counts what it left out (`rejectedSkipped`, "N rejected, not replayed" in the CLI
line). The server has already decided those ops, pull never ships them, and a cycle rejection's
effect is its own logged corrective op, so replaying them can only disagree with the server.
sql-schema.md rule 26 says so. Both tests fail before (3 and 4 divergences); they pin the HLC
order with `hlc.receive` rather than a sleep. Still open, and not this fix: the laptop's typed
block is rejected (`no-such-page`) rather than re-homed onto the surviving day.

---

### B-90 · Core accepts an un-delete whose page name is now taken by a live page
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, building `trash.restore` (ADR 022)
· **Test:** `packages/core/src/sync/apply-ops.test.ts` "rejects an un-delete whose name a live
page has taken meanwhile (B-90)"; `trash.restore`'s own guard: `trash-restore.http.test.ts` "is
conflict when a live page now has the name"

Delete page "Dup", create a new live page "Dup", then apply `page.delete {deletedAt: null}` to the
old one — through `batch_undo` of the deletion, or as an op arriving in a sync push from a device
that undid it locally. `applyPageDelete` in `packages/core/src/sync/apply-ops.ts` clears the
tombstone without re-checking the live-name unique index (`page_key … WHERE deleted_at IS NULL`),
so SQLite raises a constraint error mid-transaction and the whole `serverApplyOps` call — the
entire push, for a sync — fails. `applyPageRename` and `applyPageCreate` both reject with
`page-key-collision`; the un-delete should too, so the client converges (the page stays deleted)
instead of the push dying. `trash.restore` checks first and returns `conflict` with a `new_name`
escape hatch, but that only covers its own door.

**Fixed 2026-09-12.** `applyPageDelete` now runs the same `pageKeyCollision` check as create and
rename when `deletedAt` is `null`, and answers `rejected / page-key-collision` instead of letting
SQLite raise mid-transaction. A device that undid the deletion locally converges (the server's
rejection tells it the page stays deleted) rather than losing every later push; the sanctioned way
out is rename-then-restore, which the test also exercises.

After the B-90 fix, `batch.undo` and `trash.restore` report success when the page un-delete is
rejected (F4). The rejection used to be a thrown constraint error, which rolled the whole batch
back; now only the `page.delete {deletedAt: null}` is rejected while the `block.delete
{deletedAt: null}` ops in the same batch apply, and neither handler looks at rejected results.
`batch.undo` of a page delete after a new page took the name: 200 `restored page "Dup"`, the page
still deleted, its blocks un-deleted onto it. `trash.restore {new_name}` on a journal page: core
coerces the rename back to the ISO date, rename and un-delete are both rejected, blocks
un-deleted, 200. `trash-restore.ts`'s header still says core does not re-check the name.

**Fixed 2026-09-13.** `batch.undo` checks, before minting anything, that every page it would bring
back (or rename back) still has its name free, and answers `conflict` with
`details.live_page_id` otherwise. `trash.restore` refuses `new_name` for a journal day (`invalid`:
its name is its date). Both now apply through `ops/apply-all-or-nothing.ts` (B-122), so anything
core still rejects rolls the whole call back. Header and mcp-tools.md §4.3.17/§4.3.30 updated.
Tests: `packages/server/src/ops/undelete-collision.http.test.ts` "batch.undo of a page delete,
after a new page took the name, is conflict" and "trash.restore refuses new_name for a journal
day, whose name is its date" (both fail before: 200); the savepoint guard:
`packages/server/src/ops/refactor-atomicity.test.ts` "batch.undo writes nothing when core rejects
any op of it" and "trash.restore writes nothing when core rejects any op of it" (fail without it).

---

### B-122 · `block.to_page`, `block.move_to_page` and `page.merge` commit their writes, then answer 400
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, M7 server/sync review (F3) ·
**Test:** `packages/server/src/ops/refactor-atomicity.test.ts` "block.to_page onto an ordinary page
named like a date extends that page", and "… writes nothing when any op of its batch is rejected"
for each of the three ops

`ctx.applyOps` commits immediately; these three handlers look for a rejected result only
afterwards and throw, so the caller gets an error with no `batch_id` while part of the batch has
landed. Trigger: an ordinary page named like an ISO date (`2026-09-07`, e.g. imported from
`pages/2026-09-07.md`). `resolvePageRef` sends a wire date to `pages.journal()`, which does not see
the ordinary page, so `resolveOrMintPage` mints a journal `page.create` whose key collides. The
create is rejected, the continuation-line `block.create` is rejected (no such page), the child
moves are rejected — and the `block.text` replacing the block with `[[2026-09-07]]` is applied.
Block `2026-09-07\nmore text` with a child: `block.to_page` → 400 `rejected: page-key-collision`;
the block now reads `[[2026-09-07]]` and `more text` exists nowhere. `verify` is clean.

**Fixed 2026-09-13.** Both halves. `resolveOrMintPage` (`ops/block-move-to-page.ts`) looks for a
live page under the key the new page would be stored with, whatever its `journal_day`, before
minting a create — the ordinary `2026-09-07` page is the target. And all three handlers apply
their batch through `ops/apply-all-or-nothing.ts`: inside a savepoint, rolled back before the
`invalid` error is thrown, so a rejected op leaves nothing behind. The three rollback tests inject
the rejection with a `beforeWrite` hook that points one move at a missing page, and assert the
`op` and `changes` row counts are unchanged. All four tests fail without the fix. mcp-tools.md
§4.3.25–27 errors updated.

**Still open, found while fixing (same root cause as the trigger):** an ordinary page named like an
ISO date is unreachable by that name over the wire. `resolvePageRef` step 1 routes a wire date to
`DataApi.pages.journal`, which looks for a journal row only: `page.read {page: "2026-09-07"}` → 404,
and `page.append` → **500** `journal: failed to read back created page`, because its journal
`page.create` is rejected as a key collision. Probed with a throwaway test on this branch; not
fixed (the refactor ops now look the page up by stored key, the read/append door is
`ops/resolve.ts` and `DataApi.pages.journal`, shared by many ops). A fix would try the stored key
before minting, as `resolveOrMintPage` now does, and decide whether a date-named ordinary page
should shadow the journal day or be reported as a conflict.

---

### B-121 · A page deleted by a plugin comes back from the trash without its blocks
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, M7 server/sync review (F9) ·
**Test:** `packages/server/src/data-api-delete-instant.test.ts` "a page deleted through ctx.data
comes back from the trash with all its blocks" and "a subtree deleted through ctx.data comes back
whole"

`DataApi.pages.delete` and `DataApi.blocks.delete` (what plugins reach through `ctx.data`) call
`Date.now()` for every op they mint. `trash.restore` brings back a page's blocks — and a block's
descendants — only when their `deleted_at` equals the root's, which is how it recognises one delete
action. A plugin delete that spans a millisecond therefore restores a page with no blocks; the
blocks become separate trash entries. Probe: `Date.now` advancing 1 ms per call,
`api.pages.delete` on a 3-block page, then `trash.restore` → 1 entity restored, page empty.
`ops/page-delete.ts` and `ops/block-delete.ts` already take one `now`.

**Fixed 2026-09-13.** `DataApi.pages.delete` and `DataApi.blocks.delete` (both modes) take one
`now` per call and stamp it on every op. Both tests run the delete with `Date.now` advancing a
millisecond per call and fail before (1 of 4 entities restored; three trash entries instead of
one).

---

### B-120 · A block moved to another page loses its children when a second device reorders it on the old page
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, M7 server/sync review (F1, F2) ·
**Test:** `packages/server/src/subtree-page-repair.test.ts` "a later device reorder on the old page
wins, and the subtree comes back with it" and "a deleted child follows a cross-page move and
restores onto the parent's page, grandchild attached" (plus three more there, and
`packages/core/src/sync/apply-ops.test.ts` "block.place keeps a tombstoned parent it already has
(B-120)")

Device B has page `Src` synced and reorders block `x` on `Src` (offline, or just before its next
pull). Meanwhile an agent or the menu moves `x` to `Dst` with `block.move_to_page`, which moves the
whole subtree (B-85). B's `block.place` for `x` carries the later HLC, so it wins and `x` goes back
to `Src` — but its children stay on `Dst` with `parent_id = x`. Neither page's tree query finds
them, they are not in the trash, and `verify` is clean because the op log is self-consistent.
Probe: `Src '- a / - x / - c1 / - g / - c2'`, move `x` to `Dst` (4 moved), then a later-HLC device
`block.place x {Src, null}`: applied, 0 corrections; `Src` reads `[x, a]`, `Dst` reads `[d]`.

B-85's fix lives in the op layer (`data-api.ts#subtreePlaceOps`) and so covers only moves the
server itself plans; any `block.place` arriving by sync that changes a block's page leaves the
same orphans.

The same walk also skipped **tombstoned descendants** (F2): `subtreePlaceOps` reads children
through `siblingRows`, which filters `deleted_at IS NULL`. Delete `c1` under `p`, move `p` to
`Dst`: `c1` keeps `page_id = Src` with `parent_id = p` (on `Dst`). `trash.list` still offers it
(its page and parent are live); `trash.restore c1` answers 200 `{page: "Src"}`, and `c1` is then on
neither page and no longer in the trash. Same for `block.move`, `block.to_page`, `page.merge`.

**Fixed 2026-09-13.** A second server repair pass in `serverApplyOps`, next to rule 24's cycle
correction (`packages/server/src/subtree-page-repair.ts`): for every block that changed page in
the batch (an applied `block.place` whose page differs from the block's pre-batch page — which
also catches a batch that moves a block away and back), each descendant, tombstoned ones included,
that sits on a different page than its parent gets a server-HLC `block.place` keeping its parent
and order and taking the parent's page, minted parent-first. They apply in the same transaction,
are logged (replay parity holds), recorded in `changes` with the batch (so `batch.undo` of the move
reverses them) and returned as `corrections` (so the pushing device converges). For the tombstoned
half, core's `resolvePlace` now keeps a tombstoned parent when it is the parent the block already
has (research/03-sync.md: "descendants stay attached and hidden"); without that, a deleted
grandchild's repair op fell back to the top level. A move under a *different* deleted parent still
falls back. sql-schema.md rule 24 updated. Every server test named above fails without the pass.
Real graph (copy): 0 rows whose page differs from their parent's (no migration needed); moving the
largest subtree (961 blocks, a 6-block tombstoned child) away and back with device ops leaves 0
mismatches and `verify` clean (`tools/probes/subtree-page-repair-real-graph.ts`); `verify` clean
over the owner's 20,411 ops with the new `resolvePlace`.

---

### B-109 · `--no-mirror` never did anything
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, wiki workstream — served `docs/wiki`
with the flag and found 21 files in `pages/` · **Test:** `packages/server/src/cli.test.ts`
"parseArgs: --no-<flag> sets <flag> to false"

`parseArgs` knew `--flag` and `--flag value`; `--no-mirror` became a key called `no-mirror` that
nothing read, while `config.mirror.enabled` tested `flags.get("mirror") !== false`. Harmless while
`serve` never wrote the mirror; the moment B-95 made it write, the documented way to turn it off
was a no-op. `--no-<x>` now sets `x` to `false`.

**Status:** fixed (a regression of the B-109 fix, fixed again) · **Severity:** low · **Found:**
2026-09-13, server security review (F6) · **Test:** `packages/server/src/cli-args.test.ts`
"parseGcFlags (B-109 follow-up …)", "--flag=value is the flag with that value, split at the first
=", "checkFlags"

Follow-up: B-109's fix (`--no-x` becomes `flags.x = false`) left `nooklet gc` reading
`flags.get("no-backup")`, a key that no longer exists, so the documented `--no-backup` silently did
nothing (fails safe: a backup was always taken). The grammar also never split `--flag=value`, so
`nooklet gc --dry-run=true` became a flag named `dry-run=true`, `dryRun` was false, and gc dropped
ops and unlinked orphan assets — the flag meant to make gc safe ran the destructive action.

**Fixed 2026-09-13.** `cli-args.ts`: `parseArgs` splits `--flag=value` at the first `=`;
`parseGcFlags` maps gc's flags (`noBackup` is `backup === false`) and lives beside the grammar so
the wiring is tested, not buried in `cli.ts`'s module body; `checkFlags` makes `gc` and `restore`
refuse any flag they do not know; `booleanFlag` accepts bare, `--no-x` and `=true|false|yes|no|1|0`
and rejects anything else. Reproduced first on a copy of the owner's graph with the old code:
`nooklet gc --no-backup` wrote `backups/nooklet-backup-….tar.gz`, and `nooklet gc --dry-run=true`
dropped 20,404 of 20,411 ops. With the fix, on a fresh copy: `--dry-run=true` says "would drop" and
the op table keeps 20,411 rows, `--dryrun` stops with `nooklet: unknown flag --dryrun`, and
`--no-backup` takes no backup. `docs/OPERATIONS.md` §5 says so. Tests: `cli-args.test.ts`
"parseGcFlags (B-109 follow-up: gc's flags went through a grammar that changed under them)" (3),
"--flag=value is the flag with that value, split at the first =", "checkFlags".

---

### B-129 · A deeply nested or very long query fence throws out of `parseQuery` or breaks the SQL prefilter
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, server security review (F7) ·
**Test:** `packages/core/src/query.test.ts` "refuses a query nested too deeply or with too many
filters, in words, without throwing (B-129)"; `e2e/tests/query-limits.spec.ts`

`query.ts` promises "never throws", but `Parser.parseUnary` recurses once per `(` and `not` with no
depth cap: 20,000 nested parentheses or 30,000 `not`s overflow the stack, and `parseQuery` re-throws
the `RangeError` instead of returning `{ ok: false }`. `joinSql` emits a flat `a AND b AND …`, so
1,001 `not`s or ~1,000 juxtaposed words produce SQL that SQLite refuses ("Expression tree is too
large (maximum depth 1000)"). Query fences are block content, sync to every device, and any writer
(an MCP agent included) can author one; the client parses them in a `createMemo`
(`QueryFenceView.tsx`).

What it looked like in the app (seen in Chromium against the real server before the fix, via
`e2e/tests/query-limits.spec.ts`): the page itself survived, but both fences — 5,000 nested
parentheses, and 1,000 words — rendered as raw code with no query view and no error, so the
reader was never told why the query did nothing.

**Fixed 2026-09-13.** `query.ts`'s `Parser` counts nesting (`(` and `not`/`-`) and filters, and
refuses past 32 levels or 100 filters with a `ParseError` in words ("query is nested too deeply
(more than 32 levels of parentheses and "not")", "query has too many filters (more than 100)"),
checked before recursing so the stack is never at risk. At those limits the prefilter's SQL stays
far inside SQLite's depth of 1,000. ADR 011 records the limits. Tests: `query.test.ts` "refuses a
query nested too deeply or with too many filters, in words, without throwing (B-129)" (threw
`RangeError` before), "the largest query the parser accepts compiles to SQL that SQLite accepts
(B-129)"; `e2e/tests/query-limits.spec.ts` (2 — both failed before, `.vr-query-error` not found;
pass after, with `query.spec.ts` 9/9 alongside).

---

### B-128 · `graph.replace` regexes are compiled without the `u` flag, so Unicode classes silently match nothing
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, server security review (F8) ·
**Test:** `packages/server/src/ops/graph-replace.test.ts` "regexes run in Unicode mode, so \p{…}
classes and whole-word lookarounds work on Czech (B-128)"; `e2e/tests/replace-unicode.spec.ts`

Flags are `g`/`gi`. Without `u`, `\p{Lu}` is an identity escape for the literal text `p{Lu}`, so
`\p{Lu}\p{Ll}+` previews zero matches on "Schůzka s Alešem: Černá kniha" with no error. `\w` and
`\b` are ASCII-only either way, so `Ale\w+` misses "Alešem" and `\bAleš\b` matches inside it — a
real run would rewrite part of a longer word — and the op description does not say so.
`FindReplaceView`'s highlight matcher uses the same flags.

**Fixed 2026-09-13.** `compileQuery` compiles with `gu`/`giu`, and `FindReplaceView`'s highlight
matcher uses the same flags so the marks agree with the preview. The op description (and
`mcp-tools.md` §4.3.28) now says the regex is in Unicode mode, that `\w`/`\b` are still ASCII-only,
and gives the whole-word form `(?<![\p{L}\p{N}_])word(?![\p{L}\p{N}_])` that `page.link_unlinked`
already uses. A pattern that was only valid without `u` (`\-`, a lone `{`) is now `invalid` with
the engine's message. On the copy of the owner's graph `Č\p{Ll}+` (case-sensitive) matched 0
blocks before and 17 after; a literal `TODO` still matches 437. Tests: `graph-replace.test.ts`
"regexes run in Unicode mode, so \p{…} classes and whole-word lookarounds work on Czech (B-128)"
(0 matches before); `e2e/tests/replace-unicode.spec.ts` (showed "No matches." before; passes after,
with `replace.spec.ts` 3/3).

---

### B-127 · The Logseq importer follows symlinks in `assets/` out of the graph, and one dangling symlink aborts the import
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, server security review (F3) ·
**Test:** `packages/server/src/importer/logseq.test.ts` "does not follow a symlink in assets/ out of
the graph (B-127)", "a dangling symlink in assets/ is a warning, not an aborted import (B-127)",
"does not follow assets/ itself when it is a symlink (B-127)"

`importAssets` checks `statSync(path).isFile()`, which follows symlinks, then reads the target. A
symlink in a graph's `assets/` pointing anywhere (say `~/.ssh/id_ed25519`) is stored as an asset,
served without authentication at `/assets/:id` (unauthenticated by design, `http/assets.ts`) and
synced to every device. A graph received from someone else is where such a link would come from.
Separately, the `statSync` sits outside the `try`, so a broken symlink (common in synced folders)
throws `ENOENT` out of `importLogseqGraph` after some assets were already stored.

**Fixed 2026-09-13.** `importAssets` lists `assets/` with `withFileTypes` (Dirent types come from
lstat) and skips a symbolic link with the warning `assets/<name>: a symbolic link, not followed`,
so a dangling one no longer throws; an `assets/` directory that is itself a link is not followed
either (warning, nothing imported). Pages and journals were already listed by Dirent and so never
followed links. The owner's Logseq graph has no symlinks in `assets/` (180 entries, 0 links):
importing it into a scratch data dir gave 127 pages, 825 journals, 18,628 blocks, 171 assets,
0 dangling asset links, no symlink warnings. Tests: `importer/logseq.test.ts` "does not follow a
symlink in assets/ out of the graph (B-127)", "a dangling symlink in assets/ is a warning, not an
aborted import (B-127)", "does not follow assets/ itself when it is a symlink (B-127)" — the first
and third failed on the old code with an asset row created, the second with `ENOENT … stat`.

---

### B-126 · A page name longer than NAME_MAX stalls the live mirror, leaks a temp file per sweep, and makes `nooklet export` throw
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, server security review (F2) ·
**Test:** `packages/server/src/mirror/export.test.ts` "pages whose file cannot be written as named
(B-126)"; `mirror/live.test.ts` "a page name past NAME_MAX neither stalls later sweeps nor leaves
temp files behind (B-126)"

`pageFilePath` names the file `pageNameToFileName(name) + ".md"` with no byte limit. Page names
may be 512 characters, Czech letters take 2 UTF-8 bytes and unsafe characters become 3-byte
`%XX`, so a name easily exceeds the filesystem's 255-byte limit. `exportPage` writes the temp file,
`renameSync` throws `ENAMETOOLONG`, and the temp file is never removed. The error escapes
`exportAll`'s loop, so every page after it in the loop is not written and the stale-file prune
never runs (deleted pages keep their `.md`). The live mirror (B-95) sweeps after every commit and
the failing page never gets a `mirror_file` row, so each sweep leaves another `.xxxx.tmp` in
`pages/`; `nooklet export` aborts. `block.to_page` names a page after a block's first line, and
921 live blocks on the owner's graph have a first line over 252 bytes.

**Fixed 2026-09-13.** Three changes in `mirror/export.ts`. `pageFilePath` shortens a file-name base
past 200 UTF-8 bytes to a prefix cut on a code-point boundary (never inside a `%XX` escape) plus
`~<8 hex of sha256(name)>`, and `exportPage` then writes the full name into the file as `title::`
(what the Logseq importer reads a page name from), so the mirror stays lossless. `exportAll`
catches per page, reports `failed: [{ pageId, error }]` and still runs the prune; the live mirror
logs failures, `nooklet export` exits 1 when there were any. `exportPage` unlinks its temp file
when the rename throws. The new tests fail on the old code with `ENAMETOOLONG`, `EISDIR` and a
leaked `.tmp`. On a copy of the owner's graph (longest page name 111 bytes) `nooklet export` wrote
all 952 pages with `failed: []` and no shortened names. Tests: `mirror/export.test.ts` "pages whose
file cannot be written as named (B-126)" (3); `mirror/live.test.ts` "a page name past NAME_MAX
neither stalls later sweeps nor leaves temp files behind (B-126)".

---

### B-125 · `graph.replace` does unbounded work on the server's only thread: a backtracking regex freezes it, a long replacement balloons memory
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, server security review (F1, F5) ·
**Test:** `packages/server/src/ops/graph-replace.test.ts` (the four B-125 cases),
`graph-replace.race.test.ts`, `replace-scan.test.ts`

**Time (F1).** `compileQuery` rejects only invalid patterns and patterns that match the empty
string. The handler then runs `matchAll`/`replace` synchronously over every live block (18.6k on
the owner's graph). A pattern with nested quantifiers backtracks exponentially on ordinary text,
and while it does, the one Node process answers nothing: not `/healthz`, `/sync`, the web UI, or
MCP. `(a+)+$` over one block of 24 `a`s and a `!` took 2.3 s and `/healthz` was answered only
after it; `(\w+\s?)+:` against a copy of the real graph was killed after 60 s (`\w` is ASCII-only,
so every Czech letter is a backtracking point). `FindReplaceView` sends a `dry_run` 250 ms after
typing stops, so a half-typed pattern is enough; `dry_run` runs the same scan.

**Memory (F5).** The handler builds the replaced text of EVERY matching block before comparing the
count with `max_blocks`. A one-letter query with a 2,000-char replacement on the real graph built
about 1 GB of strings (rss 1,074 MB) to answer 413 `too_large`, even with `dry_run`. When
`max_blocks` is raised and the call goes through, the rewritten text is written with no size
check (`block.update` caps content at 100,000 chars; `graph.replace` checked nothing).

**Fixed 2026-09-13 (time).** The scan — literal and regex alike — runs in a `worker_threads`
Worker (`ops/replace-scan.ts`) that is terminated after 2 s; a regex timeout is 400 `invalid`
("the pattern took too long to run"). The worker body is an eval'd JavaScript string: tsx injects
`__name` helpers into a TS function's `toString()`, and a worker file would not survive the
desktop sidecar's single-file bundle. Awaiting the worker opened a gap between the SELECT and
`applyOps` in which a `/sync/push` (which does not take `writeLock`) could edit a matched block, so
the real run re-reads the matched blocks just before writing and answers 409 `conflict` if any
changed. Before the fix the new test, at 25 `a`s, saw `/healthz` answered after 5,010 ms; after,
the 40-`a` case is refused in ~2 s with `/healthz` answered at once. On a copy of the owner's graph
`(\w+\s?)+:`, `(\S+\s*)+\?` and `^(.*?,)*x$` (each killed after 60 s before) return `invalid` in
2.1–2.3 s. Cost: a `TODO` dry run went from ~75 ms to ~120–250 ms with the machine at load 24
(~20 ms of worker overhead idle). Tests: `graph-replace.test.ts` "a backtracking pattern is refused
within the time budget, and the server answers meanwhile (B-125)"; `graph-replace.race.test.ts`
(fails with 200 instead of 409 when the re-check is disabled).

**Fixed 2026-09-13 (memory).** The worker (`ops/replace-scan.ts`) now takes limits: past
`max_blocks` it stops holding replaced text but keeps counting (the error's `blocks_matched` stays
exact); it stops outright past 20 M characters of held text; it refuses a block the replacement
grows past 100,000 characters — `block.update`'s cap — while still allowing an edit that does not
grow an already longer block (the owner's graph has a 120,016-character block); and its heap was
capped at 256 MB (wrongly — see the correction below). All of it applies to
`dry_run` as well. On a copy of the owner's graph (`scratchpad/.../p10-replace-memory.mts`), a
query `e` with a 2,000-character replacement peaked at 1,091 MB rss before and 209 MB after; with
`max_blocks: 20000` it used to succeed at 2,001 MB and would have written blocks of up to 250,949
characters, and is now 413. Tests: `graph-replace.test.ts` "refuses a replacement that would grow
a block past the content cap, even in a dry run (B-125)" (200 before), "still edits a block that is
already past the cap, as long as the edit does not grow it", "a replacement too large to even
build is too_large, and the server carries on (B-125)" (200 before); `replace-scan.test.ts` (4).

**Corrected 2026-09-13 — the heap cap in that fix aborted the process.** Found while checking which
limit the last test above actually hit (`scratchpad/.../p12-explode-path.mts`): it was the
per-block cap, after a 200 M-character string had been built in 39 ms. One block of 199,000
characters (page.create allows 200,000) times a 2,000-character replacement is ~398 M characters,
and at `resourceLimits.maxOldGenerationSizeMb: 256` V8 did not end the worker with
`ERR_WORKER_OUT_OF_MEMORY` — it aborted the whole process ("FATAL ERROR: Reached heap limit",
SIGABRT, exit 134), over plain HTTP. `tools/probes/worker-heap-cap-abort.mjs one` reproduces it
(many small allocations, `many`, do end only the worker; the replace alone, without the scan's
preceding `matchAll`, survives — whether it aborts depends on what else is on the heap). The heap cap is gone (it would also have aborted the server
on a graph whose text alone outgrew 256 MB). Instead the worker computes each block's replaced
length from its matches before building it — `replacement.length − match` for literal text, and
ECMA-262 GetSubstitution lengths (`` $$ $& $` $' $n $nn $<name> ``) for templates — refuses an
oversized block unbuilt, and throws if a built string ever disagrees with the computed length.
With it, 199,000 and 280,000-character blocks (398 M and 560 M characters) are `block_too_long` in
~25 ms, and the owner's-graph probes are unchanged (peak rss 225–271 MB). Tests: `graph-replace.test.ts`
"a block the replacement would blow up to hundreds of megabytes is refused unbuilt, and the process
lives (B-125)" (aborted the vitest worker with SIGABRT before), `replace-scan.test.ts` "computes
every block's replaced length before building it, exactly, for every $-template form" (fails with
"computed 70 characters but built 72" when the two-digit `$nn` rule is removed).

---

### B-256 · Restoring a merged page from the trash took its name back from the merge target's alias
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, exploratory QA on the real graph
(finding Q6) · **Test:** `packages/server/src/ops/trash-restore-alias.http.test.ts`,
`e2e/tests/trash-conflict.spec.ts`

Merge `Alex` into `@Alex` (19 links rewritten, `alias:: Alex` on `@Alex`), then Restore the `Alex`
row in `/trash`: "Restored "Alex"." `page.read Alex` now returns the empty restored page while
`@Alex` still lists `Alex` as an alias, and since a page's own key wins over an alias, every
`[[Alex]]` link goes to the empty page instead of `@Alex`.

Cause: `trash.restore` checked the restored name against live pages' keys only
(`livePageWithKey`), not against `page_alias`.

**Fixed 2026-09-13.** A name that a live page (other than the one being restored) uses as an
alias is a `conflict` too, for the page's own name and for `new_name`: "a live page, "@Alex", uses
"Alex" as an alias", with a hint to restore under another name or remove the alias. The Trash
view's rename form (B-255) shows it like any other name conflict.
`trash-restore-alias.http.test.ts` failed before (200, restored as "Alex"); the e2e alias case in
`trash-conflict.spec.ts` covers the form. Real graph copy: after merging Alex into @Alex, restoring
Alex answers 409 with that message, `page.read Alex` still gives @Alex, and `new_name: "Alex
(restored)"` succeeds; verify OK (20,434 ops).

Not changed, for the owner: `page.create` does not check aliases either — creating a page named
like another page's alias silently takes that name's links over. Same shape, but a deliberate
create is arguably what the user asked for; left as it is.

---

### B-255 · Restoring a trashed page whose name is taken was a dead end in the Trash view
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, exploratory QA on the real graph
(finding Q5) · **Test:** `e2e/tests/trash-conflict.spec.ts`

Delete `@Sam Example` (4 blocks) through the API, create a new `@Sam Example`, open `/trash`
and click Restore on the deleted row: "Could not restore: a live page is already named
"@Sam Example"" and nothing else — no way to restore under another name, although
`trash.restore` takes `new_name` and its 409 hint says to pass it. The row stayed; the only way
out was to leave, rename or delete the other page, and come back.

**Fixed 2026-09-13.** A `conflict` on a page restore opens a small form on that row: the server's
message, a name field prefilled with "<name> (restored)", Restore under this name (which passes
`new_name`), and Cancel. A second conflict (the new name is taken too) says so in the same form.
`restoreFromTrash` takes the name. The name lives in the view, and unchanged trash rows keep
their objects across refetches: the first version of the fix kept the name in the form, and the
test caught a refetch (from a page created meanwhile) rebuilding the row and restoring under the
suggestion instead of the typed name. `e2e/tests/trash-conflict.spec.ts` — failed before: no form.
Real graph copy: `@Sam Example` (4 blocks) restored as `@Sam Example (restored)` from the
form, content identical, the new live page untouched.
Not changed: two trash rows with the same title are still told apart by block count and deletion
time only.

---

### B-254 · Turn into page kept heading markers and link brackets in the new page's name
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, exploratory QA on the real graph
(finding Q4) · **Test:** `packages/server/src/ops/block-to-page-name.test.ts`

On Megapage, Turn into page on `## Plánování zahradních úprav` (3 children) created a new
page named `## Plánování zahradních úprav` and left the block as
`[[## Plánování zahradních úprav]]` — although a page `Plánování zahradních úprav` already
existed and should have received the children. `[[Alex]] by chtěl něco jako:` likewise made a
page with that literal name and the block `[[[[Alex]] by chtěl něco jako:]]`.

Cause: `block.to_page` named the page after the raw trimmed first line; only a line that was
exactly one `[[link]]` was special-cased.

**Fixed 2026-09-13.** The name is the first line's text: a leading `#`–`######` heading marker is
dropped (and stays on the block, so `## [[Plánování zahradních úprav]]` is still a heading in
the page's outline), and inline `[[Page]]` / `[[Page|label]]` links are reduced to the text they
show. The existing sole-link rule is applied after the heading marker comes off.
`packages/server/src/ops/block-to-page-name.test.ts` — failed before with the page named
`## Plánování zahradních úprav`.

---

### B-253 · The references panel showed the first 200 linked and 50 unlinked references as if that were all
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, exploratory QA on the real graph
(finding Q3) · **Test:** `e2e/tests/references-cap.spec.ts`,
`packages/server/src/ops/page-backlinks-totals.http.test.ts`

On `/page/CAMP` the linked heading said 200 (`page.backlinks` paged to the end: 836; "task" 1074,
"@Alex" 816) and the unlinked heading said 50, yet Link all reported "Linked 187 mention(s); left 2
alone". The filter's options and counts came from the first 200 rows only, so a filter could say
"No references match" while matches sat further down. No truncation indicator, no load-more.

Cause: the client asked `page.backlinks` for `limit: 200` and never followed `cursor`; the server
capped unlinked mentions at 50 with nothing in the response saying so, while `mentions.link`
works on up to 500.

**Fixed 2026-09-13.** The client follows the cursor (500 per request, up to 5,000 linked
references, with the heading saying "5000+" beyond that). `page.backlinks` takes
`unlinked_limit` (default 50, so agents' payloads are unchanged; the panel asks for 500, the same
ceiling `mentions.link` rewrites) and reports `unlinked_truncated` and `linked_total`. Counts and
filters cover everything fetched; the panel renders 200 rows at a time with a "Show more" button,
since every row re-renders when the graph changes. `e2e/tests/references-cap.spec.ts` — failed
before on the heading (200, expected 205); `packages/server/src/ops/page-backlinks-totals.http.test.ts`.
Real graph copy: CAMP heading 836 (API paged: 836), unlinked 189 = the 187 Link all would link +
2 it skips; @Alex 756 / 465; 200 rows rendered with "Show 200 more"; no console errors.

---

### B-251 · History's Restore this version (and Undo) overwrote later edits, on other pages too
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, exploratory QA on the real graph
(finding Q2) · **Test:** `e2e/tests/history-later-edits.spec.ts`,
`packages/server/src/ops/batch-undo-later-edits.http.test.ts`

Pages A `- word <tag>` and B `- other <tag>`; a `graph.replace` of `<tag>` (one batch over both)
and its undo; then A's block edited to "A: important later edit". On `/history/B`, Restore this
version on the "page created" batch: A's block went back to `word <tag>` — the later edit was gone,
and the only warning was "A change that also touched another page is undone there too." On the
real graph the same walk re-applied old before-images to all 835 blocks a graph-wide replace had
touched, undoing a page merge's 19 `[[Alex]]` → `[[@Alex]]` rewrites and a Turn-into-page link,
and orphaning the page Turn into page had made. Undo of one old batch did the same to its own
blocks. `nooklet verify` stayed OK: the op log was consistent, the loss semantic.

Cause: `batch.undo` writes every before-image last-writer-wins by design (ADR 013), and the
History view's walk calls it once per newer batch, so each step overwrote whatever any other batch
had written to those blocks since.

**Fixed 2026-09-13.** `batch.undo` gains `keep_later_edits` (default false, so the agent-facing
behaviour ADR 013 chose is unchanged) and `ignore_batches`. With `keep_later_edits`, a field that
another batch changed after the one being undone is left as it is now — per field, so a later
collapse does not block restoring the text — and a block the batch created is not deleted if
another batch edited it since; what was left alone comes back in `kept` with its page. A walk
passes its own batches and the undo batches it has made so far as `ignore_batches`, so its own
steps do not count as "later edits". The History view uses both for Undo and for Restore, says in
the confirm that later edits on other pages are kept, and lists what was kept (and where) in the
status line. Tests: `e2e/tests/history-later-edits.spec.ts` (both failed before: A read back
`word zqxhistlater`; Undo reported plain "Undone.") and
`packages/server/src/ops/batch-undo-later-edits.http.test.ts`.

---

### B-250 · Replace all wrote the replacement from before the last 250 ms of typing
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, exploratory QA on the real graph
(finding Q1) · **Test:** `e2e/tests/replace-stale.spec.ts`

On `/replace`, type a query and wait for the preview, then type a replacement and click Replace all
straight away. The outcome line says "Replaced 19 occurrences in 19 blocks." and the field shows
"Hloubětín (Praha 9)", but every block got the match replaced with the empty string — the
replacement from before the last keystrokes. `líbí se jí Hloubětín, líbilo by…` became
`líbí se jí , líbilo by…`. Undo restored it. Replace all also stayed enabled while the preview for
a new query was still loading.

**Fixed 2026-09-13.** Replace all is built from the live fields, and is enabled only when the
preview on screen was computed for exactly those fields and is not reloading. The debounced preview
remembers which input it answers. `e2e/tests/replace-stale.spec.ts` — both tests failed before
(the first read back `líbí se jí , líbilo by`; the second found the button enabled mid-typing).

---

### B-268 · Markdown links render `javascript:` URLs as clickable hrefs
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, exploratory QA (Q9) · **Test:**
`e2e/tests/link-scheme.spec.ts` "a javascript: link renders without an href; web and mail links
keep theirs", `apps/web/src/editor/render/safe-href.test.ts` (3 tests),
`apps/web/src/app/follow-link.test.ts` "opens web links and refuses javascript: ones"

`click [me](javascript:document.title='PWNED') here` renders
`<a class="vr-link" target="_blank" rel="noopener" href="javascript:…">`. In headless Chromium the
click opened `about:blank` and did not run in the app origin, so it was not exploitable there;
WKWebView (the Tauri app) was not tested. Content arrives from sync and from MCP agents, so the
renderer should not hand an arbitrary scheme to the browser.

**Fixed 2026-09-13.** `render/tokens.tsx`'s `link` case passed the URL through `assetUrl` and
straight into `href`; the "follow link at caret" command (`app/hosts.ts#followLink`) likewise gave
any `url` link to `window.open`. Both now go through `editor/render/safe-href.ts`: a blocked scheme
leaves the `<a>` with no `href` (the label stays, inert) and the command does nothing. Blocked:
`javascript`, `vbscript`, `data`, `blob`, `filesystem`, read the way the URL standard reads a
scheme (edge C0/space stripped, tabs and newlines removed, case folded), so `" JaVa\tscript:"` is
caught too. A denylist rather than the http/https/mailto allowlist QA suggested: every other scheme
only hands off to the OS, and note-takers link to apps (`zotero://`, `obsidian://`); an allowlist
would break those silently. The owner's graph uses only `https` (2,114), `http` (338), `mailto` (12)
and `tel` (5), all still live. Autolinks were already safe — the tokenizer only makes them from
`http://`/`https://`. Images were left alone (`javascript:` in `img src` does not run). The e2e
test failed before the fix (`href="javascript:document.title='PWNED'"`). WKWebView still not tested.

---

### B-267 · `page_merge` with `dry_run: true` says "merged" in the past tense
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, exploratory QA (Q8) · **Test:**
`packages/server/src/mcp/server.test.ts` "says a dry run wrote nothing, for every write tool, in the
text itself"

MCP `tools/call page_merge {source: "Alex", target: "@Alex", dry_run: true}` answers
`merged Alex into @Alex: 0 block(s) moved, 19 reference(s) rewritten`. Nothing was written (op log
did not advance, "Alex" still live); only `structuredContent.dry_run` says so. An agent reading the
text can believe the merge happened.

**Fixed 2026-09-13.** Not only `page_merge`: every dry-runnable op's `render` is written in the past
tense (`deleted N block(s)`, `created …`, `moved …`) and a dry run executes the same handler inside a
rolled-back savepoint, so all of them read like a real write. `mcp/server.ts` now builds the text
through `ops/dry-run.ts#renderToolText`, which prefixes `dry run, nothing written: ` whenever the
output's `dry_run` is true — one place, so an op added later cannot forget. HTTP returns the JSON
body (with `dry_run`) and was not changed. `mcp-tools.md` §3.1 rule 3 amended.

---

### B-266 · `SCHEDULED: <2023-2-17 Fri>` (no zero padding) is not recognised
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, exploratory QA (Q7) · **Test:**
`packages/core/src/outline.test.ts` "reads org timestamps without zero padding, and stores them
padded", `packages/server/src/importer/logseq.test.ts` "imports SCHEDULED/DEADLINE dates and hours
written without zero padding"

**Superseded by B-143's implementation**, which also rejects impossible dates and times; both tests were kept.

20 live blocks on the real graph (19 DONE, 1 unmarked) keep a literal `SCHEDULED: <2023-2-17 Fri>`
line in their content with `scheduled_day` NULL, so `scheduled:any` returns 4 blocks instead of
24. The parser and spec OUT-23 both require `YYYY-MM-DD`; the owner's Logseq data has single-digit
months and days.

**Fixed 2026-09-13.** `outline.ts`'s `TIMESTAMP_INNER_RE` took `\d{4}-\d{2}-\d{2}`. mldoc, which
Logseq writes and reads these with, parses the date with `Scanf.sscanf s "%d-%d-%d"`
(https://raw.githubusercontent.com/logseq/mldoc/master/lib/syntax/timestamp.ml, `parse_date`,
read 2026-09-13; its call site was not located), so one-digit parts are valid Logseq. The regex now
takes them and the branch stores the value zero-padded. Found while fixing: the regex already
allowed a one-digit HOUR (`9:05`), consumed the line, and handed the reducer `2026-09-14 9:05`,
which `SCHEDULED_RE` refuses — and an invalid key in a `block.create` bag is dropped silently, so
the schedule vanished with no trace in content (probe: `deadline_day` NULL, line gone). Padding
covers that too. OUT-23 amended. Real data: all 20 live blocks on the owner's graph that still hold
a literal `SCHEDULED:` line now parse to a schedule when re-read through `parseOutline`.
**Not done — needs the owner:** those 20 blocks in the already-imported database keep the literal
line until the graph is re-imported or a one-off repair re-parses them; nothing here rewrites
existing data.

---

### B-265 · Inserting a collapsed template gives a collapsed copy with its content hidden
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, exploratory QA (Q6) · **Test:**
`e2e/tests/template-collapsed.spec.ts` "a folded template inserts unfolded, keeping folds below its
top", `packages/core/src/templates.test.ts` "hands back the inserted nodes expanded, and leaves folds
below them alone"

On the real graph, `/template` → "Meeting" inserts one empty bullet. Stored: the root (content
`""`, properties `participants`, `projects`, `type`) with `collapsed: true` and the three children
(Objectives / Agenda / Notes) hidden under it. The template's root is `collapsed:: true` in the
library — collapsed there to keep the library tidy — and the copy inherits it. Not verified:
whether Logseq itself clears `collapsed` on insert.

**Fixed 2026-09-13.** Every node was copied with `collapsed: node.collapsed`. The fold is now
dropped from the nodes an insertion places at the top (`core/templates.ts#templateRoots`, which the
caret insert, the insert-into-empty-bullet path, and both journal-day paths all go through); folds
further down stay, since they are part of the template's shape. The existing unit test that asserted
`collapsed: true` on the copy now asserts `false`. Real graph (fresh copy, this build): `/template`
→ "Meeting" shows `Objectives (What is to goal?):`, `Agenda:`, `Notes / Discussion:` under the new
bullet, stored `collapsed: false`. Still not verified: what Logseq does.

---

### B-264 · Display math `$$…$$` renders as inline math wrapped in literal dollar signs
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, exploratory QA (Q5) · **Test:**
`e2e/tests/math-display.spec.ts` (2 tests), `packages/core/src/tokens.test.ts` "tokenizeLine:
display math $$…$$" (4 tests)

`Display math $$\int_0^1 x^2\,dx = \frac{1}{3}$$ end` shows `$`, an inline KaTeX span, and `$`;
no `.katex-display` element exists. `$$…$$` is Logseq's display-math syntax and the owner's graph
uses it (`$$CO_2$$` on "Projects/Science presentation for kids with dry ice"). The grammar spec
("Inline math": a `$` opens math only if the next character is not another `$`) never mentions the
display form, so the second `$` opens inline math and the fourth is left over.

**Fixed 2026-09-13.** The tokenizer had no `$$` form, as the spec said. `core/tokens.ts` now tries
display math at a `$$` before the inline rule — closer on the same line, non-blank tex, the inline
rule's no-digit-after-closer guard — and emits `math` with `display: true`; the rendered view
(`render/tokens.tsx#MathView`) and the editor widget (`livePreview.ts#MathWidget`) pass it to
KaTeX's `displayMode`. Spec updated (`markdown-grammar.md`, "Display math"). Real graph: the
`$$CO_2$$` block renders one `.katex-display`, centred on its own line, with no dollar signs
(screenshot checked). Not done: a `$$` block spanning several lines — the tokenizer works per line.

---

### B-263 · Query `tag:task` / `#task` finds nothing, and `not #task` matches every task
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, exploratory QA (Q4) · **Test:**
`e2e/tests/query-task-tag.spec.ts` (2 tests), `packages/core/src/query.test.ts` "a task marker is a
reference to Task, with no #Task in the text" and the prefilter soundness cases `"tag:task"`,
`"#task and (NOW or WAITING)"`, `"marker:open not #task"`, `"not [[Task]]"`

On the real graph a ```` ```query ```` fence with `tag:task` (or `#task and (NOW or WAITING)`)
says "0 blocks", while `page.backlinks {target: "Task"}` lists the 686 task-marked blocks — the
server's `ref` table carries a derived `Task` tag for every block with a marker ("a tag query
finds them", says the comment that adds it). `marker:open not #task` returns every open task.

**Fixed 2026-09-13.** The `Task` tag is derived from `block.marker` on the server
(`apply-ops.ts#rebuildRefRows`), but the client has no `ref` table and the query language read
references from the block text alone (`query.ts#refKeys`), where the tag never is. The name is now
defined once in core (`refs.ts#TASK_TAG`), the server imports it, `refKeys` adds `task` for any
marked block, and the SQL prefilter for a `task` ref also admits `b.marker IS NOT NULL` — without
that the prefilter dropped marked rows with no `#` or `[[` before the exact check ran (the
soundness case `"tag:task"` fails if that half is removed; checked). Real graph (fresh copy, this
build): `tag:task` → 686 blocks (the `ref` table says 686), `#task and (NOW or WAITING)` → 8,
`marker:open not #task` → 0. `nooklet verify` OK (20,417 ops).

---

### B-262 · `nooklet export` skips pages whose `.md` file is missing
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, exploratory QA (Q3) · **Test:**
`packages/server/src/mirror/export.test.ts` "rewrites a page whose file is gone even though
mirror_file says it is up to date", `packages/server/src/mirror/live.test.ts` "recreates, on
start, a file deleted while the server was down"

Copy a served `graph.sqlite` into an empty directory and run `nooklet export --data <dir>`: it
reports `"exported": 6, "skipped": 966` and `pages/` holds 5 files. After `DELETE FROM
mirror_file` the same command writes all 972. The bookkeeping rows travel with the database, so
export — the walk-away-with-it command — trusts them over the disk. The same holds for the live
mirror: a mirror file deleted by hand, or a data directory restored without `pages/`, is never
recreated.

**Fixed 2026-09-13.** `exportPage` skipped the write when the `mirror_file` row's path and hash
matched the render, without asking whether the file was still there. It now also requires
`existsSync`. Real graph: a `.backup` copy of a served database (952 `mirror_file` rows, no
`pages/`) now exports 952 pages into 127 `pages/` + 825 `journals/` files. The live mirror gets the
same repair on start, because its first sweep renders every page (B-260); a file deleted by hand
while the server runs comes back on that page's next change, not immediately — there is no watcher
(ADR 002's watcher is still unbuilt). Only existence is checked, not the file's hash, so a file
edited by hand is not overwritten until its page changes.

---

### B-261 · Renaming a page from its title in the web UI breaks every link to it
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, exploratory QA (Q2) · **Test:**
`e2e/tests/page-rename.spec.ts` "renaming from the title rewrites every link and tag, and keeps the
old name as an alias", "a title rename onto an existing page's name is refused and the title goes
back"

Set a page's title input to a new name and press Enter: backlinks to the new name go from 1 to 0,
the linking block still says `[[Old Name]]` and `#[[Old Name]]`, `page.read` on the old name is a
404 and no alias is created, so clicking the old link opens the "Create" view of a missing page.
The same rename through the API (`page.update new_name`) rewrites every link (`refs_rewritten: 1`)
and keeps the old name as an alias, as its description promises. On the owner's graph (many
`@person` pages, Czech and English) one title edit silently orphans every reference to the page.

**Fixed 2026-09-13.** `PageView.tsx` applied a bare local `page.rename`; the link rewrite and the
`alias::` op exist only in the server's `page.update`, because the rewrite needs the `ref` index
the client does not have. The title now calls `page.update` through `data/page-rename.ts` —
push, call, pull, then navigate, the bracket the M7 refactors use (ADR 020 §1). A rename onto a
name another page has used to leave the input showing the rejected name; it now alerts and puts
the real name back. Two `pages.spec.ts` assertions said the old name must be "missing" after a
rename — they encoded the bug and now check that it resolves to the renamed page. Both new tests
failed before the fix (linker text unchanged; title kept the clashing name). Not done: an
offline rename is refused rather than queued, since a local rename cannot rewrite links.
Real graph (fresh copy, this build): renaming `Alex/Notes` (11 backlinks) from its title kept all
11 under the new name, `page.read "Alex/Notes"` resolves to `Alex/Notes QA`, and the mirror file
moved. That run also showed the "doesn't exist yet" view for one ~100 ms sample right after the
navigation: the guard was reset in a `finally` before the new name's lookup had started. It is now
cleared when the page resolves; a rerun sampled no flash (timing-based, one run — no test pins it).

---

### B-260 · The live mirror never picks up renames, moves, marker, indent or property changes
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, exploratory QA (Q1) · **Test:**
`e2e/tests/mirror-live.spec.ts` (3 tests), `packages/server/src/mirror/live.test.ts` "follows a
rename…", "follows page and block properties, markers and indentation", "follows a block moved to
another page…", `packages/server/src/mirror/export.test.ts` "exportAll with sinceSeq (B-260)"

While `nooklet serve` runs, only block text edits, creates and deletes reach `pages/`. Rename a
page (title input or `page.update new_name`) and the old file stays while no new file appears
(polled 8 s). Set a page property (`qaprop:: hello`) or a block property (`status:: x`), choose a
journal template in Settings (`journal-template:: true`), indent a block with Tab or cycle its
marker with Cmd/Ctrl+Enter: none of it shows up in the file. The stored page read
`- one\n  - two\n- three`; the mirror still had `- one\n- two\n- LATER three`. A full
`nooklet export` of a copy of the same DB wrote the right files and `nooklet verify` passed, so
the data is right and only the live mirror is stale. B-95's fix note says the sweep "moves renamed
ones" — true of `exportPage`, but the sweep never offers it the page.

**Fixed 2026-09-13.** The sweep chose pages whose `page.updated_at` or newest `block.updated_at`
was later than `mirror_file.written_at`, and in `core/sync/apply-ops.ts` only `block.text` moves
`updated_at` — rename, `page.prop`, `block.prop` (marker, priority, collapsed, reserved columns)
and `block.place` never did, and a block moved off a page leaves nothing on that page to compare.
Bumping `updated_at` in the reducer was rejected: it would change `if_version` and "recently
updated" semantics for every client and still miss the page a block left. The mirror now follows
the `changes` table instead (`mirror/export.ts#pagesTouchedSince`): a page row written after the
cursor, or any page a written block was on before or after. The cursor is a `changes.seq`, not a
clock, so a commit in the same millisecond as the previous sweep cannot be lost. The first sweep
after `serve` starts renders every live page (952 pages on the real graph: ~200 ms cold, ~85 ms
warm with nothing to write), which catches up writes made while the server was down and repairs a
mirror an older build left stale. Real graph: renaming `Alex/Ideas` with a property reached
`pages/Alex___Ideas QA.md` in 588 ms and removed the old file. The three e2e tests failed on the
unfixed server (new file never appeared, `qaprop:: hello` missing, `  - two` never indented).
Coordinator: B-95's fix note in BUGS.md ("moves renamed ones", `onlyChanged`) describes the
replaced mechanism.

---

### B-244 · `[[` "New page" on a client still pulling its first sync writes `]]` to the database but not the editor
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, exploratory QA (Q5) · **Tests:**
`e2e/tests/autocomplete-busy-replica.spec.ts` "New page links at once and keeps what is typed next,
even while the replica is busy (B-244)"; `apps/web/src/commands/autocomplete/AutocompletePopup.test.tsx`
"New page links and dismisses at once, without waiting for the page to be created (B-244)"

Fresh browser profile on the real graph, within the first seconds after load: type ` [[new/page`
and accept the "New page" row (Enter, Tab or click). The page is created and the server briefly
stores `x [[new/page]]`, but the editor still shows `x [[new/page` and the popup stays open. The
next keystroke commits the editor's buffer over it: stored `...testing [[new/pages/child after`,
an unclosed link. Accepting an existing page works; a warm client works (0/4). The owner's B-42
report was exactly `testing [[new/page`, so this may be what they hit.

**Fixed 2026-09-13.** Reproduced on a copy of the real graph with QA's `t2.mjs` against this
branch's build: EnterNew and ClickNew left `x [[qa-new/…/a` with the popup open. A timeline probe
showed why: `selectRow` awaited `pages.createPage()` before inserting the link, and that call is a
round trip to the replica worker, which answered after ~3.3 s while busy (a cold bootstrap, and
the popup's own per-keystroke block search over 18.6k blocks); after the worker went idle the same
accept took one frame. Nothing about the link needs the page to exist first (refs are keyed by
page name, `ref.dst_page_key`), so the popup now inserts `[[title]]` and dismisses synchronously
and creates the page in the background (failure is logged; a link to a missing page is an
ordinary state). The e2e test keeps the worker busy for 3 s with a synchronous loop evaluated in
it (`worker.evaluate`), presses Enter, and requires the link within 1.5 s: it failed before
("x [[busy-replica/…" after 1.5 s) and passes 3/3 after. Rerun of `t2.mjs` on the real graph after
the fix: EnterNew, TabNew, ClickNew, EnterExisting all show `x [[…]]` with the popup closed. The
same rerun is what exposed B-247 below. Whether this is what the owner saw as B-42 (focus loss) is
not established: focus stayed in the editor in every run here.

---

### B-242 · Undoing Alt+Up/Down drops editor focus; the next keystrokes are lost
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, exploratory QA (Q3) · **Test:**
`e2e/tests/undo-redo.spec.ts` "typing right after undoing or redoing Alt+ArrowDown lands in the
moved block (B-242)" (and the Alt+ArrowUp variant)

Editing `one` on `one, two, three`: Alt+Down moves it (focus kept, B-68), Cmd+Z moves it back and
the row still shows the editor, but `document.activeElement` is `<body>`. Typing `X` goes nowhere.
Undoing a Tab indent keeps focus.

**Fixed 2026-09-13.** Undo and redo of a move reorder the edited row exactly like the move itself:
the keyed `<For>` moves the row's DOM node, which blurs it. B-68's deferred refocus lived only in
`doMoveStep`; when undo/redo target the block already being edited, `doUndo`/`doRedo` just placed
the caret. The refocus is now `BlockTree.tsx#refocusAfterReorder`, called from all three. Undo of
an indent kept focus because a depth change updates the row in place. Both e2e variants fail
without the change (the X is never stored) and pass with it.

**Second cause, fixed the same day.** The Alt+ArrowUp variant then failed 2 of 2 inside a loaded
15-spec run. A focus/MutationObserver trace around the undo showed the rest of it: 10-50 ms after
the undo, a page-tree refetch that had read before the undo resolved and put the old order back,
and the next refetch restored the new one. Two more DOM moves, a `focusout` each, no `focusin`
(5 of 6 traced runs). A keystroke in that window was lost; under load the window is where the
next keystroke lands. The refetch effect now refocuses the edited block after it replaces the
rows, when the editor had focus going in (`refocusAfterReorder` again, so a real click-away is
never fought). The test now also waits 400 ms after the undo and after the redo, checks focus
synchronously, and types again: without this change Alt+ArrowUp fails there ("activeElement is
body"), with it the spec passed 6/6 in three separate runs. The flicker itself (rows jumping for
a frame) is still there; only its focus loss is fixed.

---

### B-241 · Cmd+Z does nothing after deleting a block selection; the undo fires later instead
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, exploratory QA (Q2) · **Tests:**
`e2e/tests/undo-redo.spec.ts` "Cmd/Ctrl+Z right after Delete on a block selection brings the blocks
back (B-241)" (and the Backspace variant), "Cmd/Ctrl+Z after clicking away still undoes the last
edit on the page (B-241)"; `apps/web/src/app/editor-host.test.ts` "undo/redo after the editing
session ends (B-241)"

Select two blocks (Escape, Shift+Down), press Delete or Backspace: both go. Cmd+Z does nothing,
and focus is on `<body>` or the outliner. Much later, Cmd+Z while editing a different block brings
the deleted blocks back, which is the wrong moment. A user who deletes a selection by mistake sees
undo do nothing. Same cause, found while writing the test: type into a block, click away (which
ends editing since B-74), Cmd+Z: nothing.

**Fixed 2026-09-13.** `edit.undo` reaches the tree through the active `EditorHost`, and a tree
withdraws as the active host as soon as nothing in it is edited or selected, which is exactly what
deleting a selection, clicking away, or an undo that leaves nothing focused do. The keystroke went
to the inert no-op host while the tree's history kept the step. Undo and redo now fall back to the
tree whose session ended most recently (`editor-host.ts#historyEditorHost`), cleared when that
tree unmounts (`releaseEditorHost`, which also stops an unmounting tree from nulling another tree's
active registration). The fallback does not take Cmd+Z typed into an `<input>`/`<textarea>`
outside the outliner. The tree runs `edit.undo`/`edit.redo` arriving with neither an edit nor a
selection. The e2e tests fail without the change (3/3) and pass with it.

---

### B-240 · Redo of an undone new block shows it on screen, but the server never gets it
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, exploratory QA (Q1) · **Tests:**
`e2e/tests/undo-redo.spec.ts` "redo of an undone Enter puts the block back on the server, not just
on screen (B-240)"; `apps/web/src/editor/history.test.ts` "create -> undo -> redo leaves the block
alive in a real database, every time (B-240)"

On `- one` / `- two`: Enter after `one`, type `mid`, Cmd+Z twice (the text, then the split: the
block goes), Cmd+Shift+Z twice. The screen shows `one, mid, two`; `page.read` returns `one, two`;
a reload shows `one, two`, so `mid` is lost. No console error. The op log for the block: create,
text, text, delete (the undo), then the redo's `block.create` logged as **noop**, then its text
applied to a block that is still a tombstone.

**Fixed 2026-09-13.** Redo re-minted the transaction's forward ops verbatim, so it re-sent the
original `block.create` for an id that already existed as the undo's tombstone; `applyOps` inserts
with `INSERT OR IGNORE`, so server and local replica did nothing while `optimistic.ts` put the row
back on screen. Redo now sends a create in its undelete form (`block.delete` with `deletedAt:
null`, `invert.ts#redoRecipe`), the op that actually reverses the undo. The existing unit test
asserted the redo was a `block.create`, i.e. it pinned the bug; it now asserts the undelete, and a
new one round-trips create/undo/redo twice through core `applyOps` on real SQLite. The e2e test
checks the server and a reload, which is what would have caught it.

---

### B-239 · The Search view cannot filter by task marker, journals, or pages vs blocks
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit §1.1 (`search`:
"`scope`, `properties` (e.g. `marker`), `pages`, `journals_only` have no UI") and §2 #11 ·
**Test:** `e2e/tests/search-filters.spec.ts`, `apps/web/src/views/searchFilters.test.ts`,
`apps/web/src/views/SearchView.test.tsx` ("SearchView filters")

"Search operators / filters for the search box" has 83 votes and "Filters for note body" 140
(research/13 §3.1). The op had the filters; the view's Filters panel offered tag, namespace and
dates only.

**Fixed 2026-09-13.** Three controls in the Filters panel: Task (any, or one of the seven markers →
`properties: {marker}`, and blocks only, since page hits ignore the marker filter), Show (blocks
and pages / blocks only / pages only → `scope`; "pages only" is disabled while a marker is chosen)
and Journals only (→ `journals_only`). Mapping in `views/searchFilters.ts`; `properties` added to
the client's `SearchInput` (`data/api-client.ts`); styles in `views/search-filters.css`. The `pages`
filter (restrict to named pages) is still not exposed — the audit's list for #11 did not ask for
it. Depends on the B-238 server fix: before it, the marker filter would have shown "0 results".
Tests named above.

**Verification follow-up, 2026-09-13 (second agent).** *Fixed:* with Show on "Pages only", choosing a
Task marker searched task blocks (right) but Show kept reading "Pages only" — the option disabled
yet still selected — over a list of blocks. Choosing a marker now moves a pages-only Show to
"Blocks only" (`views/searchFilters.ts#withMarker`). Tests: `e2e/tests/search-filters.spec.ts`
"choosing a task marker from pages only shows blocks only, not a pages-only label over tasks"
(failed before: value "pages") and `views/searchFilters.test.ts` "withMarker".

---

### B-238 · `search` with `properties: {"marker": "TODO"}` never matches anything
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, impl-small (wiring the Search view's
marker filter, audit §2 #11) · **Test:** `packages/server/src/ops/search-filters.test.ts`

The `search` op's description (and so its MCP tool) offers `properties` as "exact key=value
filters, e.g. `{"marker":"TODO"}`", but the filter only looks in `block_prop`, and a task marker is
stored in the `block.marker` column (ADR 011's reserved keys) — never as a `block_prop` row. In a
copy of the owner's graph `block_prop` has no `marker`, `priority`, `scheduled`, `deadline`,
`repeat` or `done` rows at all, while 686 blocks carry a marker. So every marker or priority filter
silently returns zero hits. Reproduced by the new test before the fix (2 of 3 failing with `[]`).

**Fixed 2026-09-13.** `packages/server/src/ops/search.ts` maps `marker`, `priority` and `repeat` in
`properties` to the `block` columns; other keys still match `block_prop`. `scheduled`, `deadline`
and `done` (day number / time / epoch ms in their columns) are NOT mapped and still match nothing
through `properties` — written into `docs/spec/mcp-tools.md` beside the op, not fixed. Tests that
would have caught it: `packages/server/src/ops/search-filters.test.ts` (failed 2 of 3 before) and
`e2e/tests/search-filters.spec.ts` (its marker test fails with "0 results" when the mapping is
removed — checked). On a fresh copy of the owner's graph served by `nooklet serve`: keyword "a",
blocks, `properties: {marker: "LATER"}` → 8 hits; with `journals_only` → 5.

**Verification follow-up, 2026-09-13 (second agent).**
- *Fixed:* `properties: {"constructor": "x"}` → 500 `near "Object": syntax error`. `constructor`
  passes the key schema (`^[a-z][a-z0-9-]*$`) and `TEXT_COLUMN_PROPS[k]` returned
  `Object.prototype.constructor`, which was spliced into the SQL as a column name. Now
  `Object.hasOwn`. Test: `packages/server/src/ops/search-filters.test.ts` "a key that names an
  Object.prototype member is a property filter, not a column" (failed before with the 500).
- *Open, pre-existing (not this branch):* the same mistake in `packages/core/src/outline.ts`
  `normalizePropertyKey` (`PROPERTY_KEY_REMAP[lower] ?? …`): a block property `constructor:: Stavby`
  is stored and mirrored as `function Object() { [native code] }:: Stavby` (seen through
  `page.create` + `page.read` in a server-test probe); `__proto__::` presumably becomes
  `[object Object]::`, not checked. An imported Logseq graph with such a key would be rewritten.
  Likely fix: `Object.hasOwn(PROPERTY_KEY_REMAP, lower)`, plus a core parser test.

---

### B-237 · No way to land on a random page
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit §2 #18 · **Test:**
`e2e/tests/random-page.spec.ts`, `apps/web/src/commands/registrations/random-page.test.ts`

Rediscovering old notes by jumping to a random page is a common outliner habit; nooklet has no
command for it. The audit records no vote evidence (research/13) and ranks it "only if it is free".

**Fixed 2026-09-13.** `nav.randomPage` ("Open a random page", palette only, no default key; spec
R44b) opens a random live page that is not a journal day and has at least one live block, never
the page on screen. Journals and empty pages are skipped on purpose: in a copy of the owner's graph
825 of 952 pages are journal days and 41 of the other 127 are empty. Files:
`commands/registrations/random-page.ts` (+test), `data/random-page.ts` (+test against the real
client schema through `WorkerDb`; removing either the journal or the has-a-block condition fails
it — checked); two-line hookups in `registrations/index.ts` and `CommandLayer.tsx`. Tests that
would have caught it: `e2e/tests/random-page.spec.ts` (2 tests),
`apps/web/src/commands/registrations/random-page.test.ts`, `apps/web/src/data/random-page.test.ts`.

---

### B-234 · A page cannot be locked against accidental edits
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit §2 #17 · **Test:**
`e2e/tests/read-only.spec.ts`, `apps/web/src/editor/readOnly.test.ts`

"Lock a page as read-only" has 69 votes on the Logseq forum (research/13 §3.1). A reference page
(a checklist template, an imported article) is one stray click and keystroke away from being
changed. `BlockTree` has had a `readOnly` prop since M1, but nothing sets it and it does not cover
the marker click, block selection, or commands that write through the store.

**Fixed 2026-09-13.** `read-only:: true` on a page (only the value `true`) locks it in every
`BlockTree` that shows it — the page view and the journal stream alike, because the tree reads the
page's property itself: no edit mode (click, Enter, focus requests), no block selection, and the
task-marker click, drag and swipe refuse with a toast ("This page is read-only. Remove
read-only:: true from its properties to edit it."). The title input goes `readonly` and a
"Read-only" badge sits in the title row. Collapsing, mouse text selection (the rendered view no
longer cancels the drag on a locked page) and the properties panel stay usable. Locking while a
block is being edited ends the edit and keeps what was typed; unlocking takes effect on the open
page. UI-only by design, written into `docs/spec/markdown-grammar.md` OUT-21a: the API still writes
(a test proves it). Blocking selection is load-bearing: with that one guard removed, a Cmd/Ctrl+
click selection let Tab indent, Backspace delete and Cmd/Ctrl+Enter cycle the marker through the
store (probe run 2026-09-13). Files: `editor/readOnly.ts` (+test), `editor/ReadOnlyNotice.tsx`,
`editor/read-only.css`; hookups in `BlockTree.tsx` (the unused `readOnly` prop now also follows the
property), `BlockRowView.tsx`, `PageView.tsx`. Tests that would have caught it:
`e2e/tests/read-only.spec.ts` (6 tests), `apps/web/src/editor/readOnly.test.ts`. Not covered by a
test: the drag (long-press) and swipe refusals — touch gestures, guarded in the same functions as
the keyboard moves but not driven in a browser.

**Verification follow-up, 2026-09-13 (second agent).** *Fixed:* in the journal stream, a block
selection standing in an unlocked day survived a right-click on a locked day's block (a locked
block takes no caret, so the command context stayed with the other tree), and the menu over the
locked block listed Zoom in, Cycle task state, Move, Duplicate, Delete, Turn into page and Move to
page — all aimed at the other day's selected block. A right-click on a locked block now releases
every tree's editing/selection (`requestEditingEnd`) before the menu opens, so it shows only the
timestamps. Test: `read-only.spec.ts` "right-clicking a locked block offers no command aimed at a
selection in another day" (failed before: 9 items).

---

### B-232 · There is no way to search within the page you are on
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit §2 #16 · **Test:**
`e2e/tests/page-find.spec.ts`, `apps/web/src/editor/pageFilter.test.ts`

Cmd/Ctrl+F on a page does only what the browser's find does, which cannot see blocks under a
collapsed parent (they are not in the DOM) and matches the rendered text, not what was typed.
"Search inside … page with Ctrl+F" has 78 votes on the Logseq forum (research/13 §3.1) and is done
in Logseq.

**Fixed 2026-09-13.** Cmd/Ctrl+F on a page (`search.findInPage`, `when: pageView` — a new
`WhenContext` key, spec R7 and R44a) opens a find bar above the outline. A non-blank query shows
only matching blocks plus their ancestors, under collapsed parents too, without writing any op;
matches are counted ("1 of 3") and highlighted in the rendered text through the CSS Custom
Highlight API; Enter/Shift+Enter step and scroll; Escape closes and returns the caret to where it
was. Opening the bar ends editing first: without that, Enter typed into the bar split the block
the caret had left ("alpha beta" became "alpha" / " beta" — reproduced by removing the call and
running the e2e test below). On every other view no binding matches, so the browser's find still
opens. Files: `app/page-find.ts`, `views/PageFindBar.tsx` + `page-find.css`,
`editor/pageFilter.ts`, `commands/registrations/page-find.ts`, `requestEditingEnd` and a caret on
`requestBlockFocus` in `editor/focus-request.ts`; hookups in `BlockTree.tsx` (`filter` /
`onFilterMatches` props, a focus request for a row that is not rendered is dropped instead of
editing an invisible row), `BlockRowView.tsx` (match/context classes), `PageView.tsx`,
`CommandLayer.tsx`, `editor-host.ts`, `commands/types.ts`, `registrations/index.ts`.
Tests that would have caught it: `e2e/tests/page-find.spec.ts` (6 tests; with `when: "true"` the
"left to the browser" test fails, and without `requestEditingEnd` the two editing tests fail —
both checked), `apps/web/src/editor/pageFilter.test.ts`, `apps/web/src/app/page-find.test.ts`.
Measured on the owner's biggest page (`OmnivoreSync`: 961 blocks, 1.69 MB, graph copy of
2026-09-13) with `tools/probes/page-find-perf.ts`: the first version folded text per character
and took 21-51 ms per `filterVisible` call and 670-890 ms for the highlight pass's `findRanges` —
per keystroke. After caching folded text per block object and folding only non-ASCII runs per
character: 0.2-1.5 ms and 12-17 ms. Highlights are capped at 2,000 occurrences ("r" matches 78,604
times there; spreading that many ranges into `new Highlight(...)` would overflow the argument
limit); every matching block is still shown and counted. In Chromium against `nooklet serve` on
the same graph copy (production build): typing "r", "e", "k", "a" into the bar on OmnivoreSync took
249/67/132/33 ms per keystroke to count and paint (917 rows rendered for "r"), Escape restored the
57 rows the page shows collapsed.

**Verification follow-up, 2026-09-13 (second agent, adversarial pass).** Numbers B-230..B-239 are
all taken, so what the pass found in this feature is recorded here rather than under new numbers.
- *Fixed:* with the filter on, Backspace at the start of a match merged it into the previous row ON
  SCREEN, which can be many hidden blocks away — "keep me" / "hidden one" / "hidden two" / "keep
  too" became "keep mekeep too" / "hidden one" / "hidden two" (text moved above blocks it never
  touched); Delete at the end did the same forwards. Merges now use the unfiltered reading order
  (`BlockTree.tsx#outlineOrder`). Test: `page-find.spec.ts` "under a filter, Backspace and Delete
  join a block with its neighbour on the page, not the next match" (failed before the fix with the
  merged text above the hidden blocks).
- *Fixed:* clicking the bar's close button while typing in a match (not the block the bar was
  opened from) sent the caret back to the opening block. Two causes: the click-away handler (B-74)
  ended the edit on a press on the bar's buttons, and close always restored the opening caret. The
  buttons are now exempt from click-away (they already keep focus with a mousedown guard) and close
  restores only when the keyboard is in the bar. Test: `page-find.spec.ts` "closing the bar with
  its button leaves the caret in the block being edited" (failed before: caret in row 0, not 2).
- *Open:* Cmd/Ctrl+F while the palette is open over a page opens the bar behind the palette and
  moves focus into the bar's input; the palette stays on screen. `when: pageView` has no way to say
  "no modal open" (there is no palette when-key). Probe only, no test.
- *Open:* select-all (Cmd/Ctrl+A in selection mode) under a filter selects the context ancestors
  too; deleting the selection then deletes those ancestors' hidden, non-matching children — the
  same subtree semantics as deleting a collapsed parent, but nothing on screen shows them. Undo
  restores. Probe only: page "parent ctx / match kid / hidden kid / other hidden / match two",
  filter "match", select all, Backspace → only "other hidden" left.
- *Open:* Cmd/Ctrl+F while the page title input holds an uncommitted rename commits it on blur,
  the route follows the new name, and the name change closes the bar it just opened — Cmd+F seems
  to do nothing (probe: title "X" appended, Cmd+F → URL `…%20X`, no bar, focus on body).

---

### B-230 · A block's created/edited time is stored but shown nowhere
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit §1.1 ("Block
timestamps … not rendered anywhere") and §2 #15 · **Test:** `e2e/tests/block-timestamps.spec.ts`,
`apps/web/src/app/block-times.test.ts`

Every block row carries `created_at` and `updated_at` in both the server and the client replica
(`BlockRow.createdAt/updatedAt`), but no surface renders them: right-clicking a bullet lists
commands only, and there is no tooltip. "Block Timestamps" has 46 votes on the Logseq forum
(research/13 §3.1).

**Fixed 2026-09-13.** The block context menu ends in a muted, non-clickable line — "Created today
14:03", plus "· Edited 5 minutes ago" once the text changed after creation — with the exact local
times as its tooltip (`app/BlockTimestamps.tsx`, `app/block-times.ts`, `data/block-times.ts`;
one-line hookup in `app/BlockContextMenu.tsx`). Wording reuses `views/historyText.ts#formatWhen`.
Caveats written into `block-times.ts`: an imported block's "Created" is its markdown file's mtime
at import, and "Edited" moves only on a text change (`block.text`), not on marker/collapse/move.
Tests that would have caught it: `e2e/tests/block-timestamps.spec.ts` (both tests; the second
fails with `activeElement is body` when the footer's mousedown guard is removed — checked) and
`apps/web/src/app/block-times.test.ts`.

---

### B-154 · `/template` in an empty block that has properties inserts the template after it
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, same verification · **Test:**
`apps/web/src/commands/registrations/templates.test.ts` "an empty block with properties still takes
the template into itself (B-154)"

`templates.ts` decides "apply into this block" by `content.trim() === ""` on the editing text. An
empty numbered item's buffer is `\nlist:: number`, so it counted as non-empty and the template's
blocks went in after it, leaving an empty numbered bullet behind (browser: rows `1. first`, `2.`,
`Standup`, …).

**Fixed 2026-09-13.** The emptiness check reads the content part of the editing text
(`splitBlockText`), and the template's text replaces that content through `onContent` (B-153), so
the block keeps its own properties and the caret ends after the text. The unit test was red before
the fix; in the browser the scratch check now gives rows `1. first`, `2. Standup`, `yesterday`,
`today`.

---

### B-153 · `/code`, `/query` and `/h1`–`/h3` treat a block's property lines as its text
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, adversarial verification of
`m8/impl-render` · **Test:** `e2e/tests/block-properties.spec.ts` "/code, /query and /h1 change the
text and leave the properties alone (B-153)"

Since B-101 the editor host's `getSelection().content` is the block's editing text, property lines
included, and three commands transform that whole string (`insert-logic.ts`). Seen in the browser
before the fix: `/code` on a numbered item stored `` ```\nnpm install \nlist:: number\n``` `` with
no properties (the numbering was gone, its line was code); `/query` on a block with `owner:: Dan`
stored `` ```query\nowner:: Dan\n``` ``; `/h1` on a numbered item left the caret at the end of the
buffer — the end of the `list:: number` line — so the next word typed was stored as
`list:: numbermore` and the item stopped being numbered.

**Fixed 2026-09-13.** `commands/registrations/insert-logic.ts#onContent` splits the editing text,
runs the command's transform on the content alone, writes the property lines back in their
canonical place (`joinBlockText` — after the fence for a fenced block) and maps the caret from
content into the result; `insert.ts` wraps the three commands in it. A text without property lines
passes straight through. The e2e test was red before the fix (`list:: number` inside the fence, no
properties); unit: `insert-logic.test.ts` "onContent (B-153)".

---

### B-152 · Editing a block whose property value has a line break moves the value's tail into the text
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, adversarial verification of
`m8/impl-render` · **Test:** `e2e/tests/block-properties.spec.ts` "a property value the buffer
cannot show as one line survives editing the block (B-152)"

Since B-101 the editor's buffer writes every generic property as a `key:: value` line and splits the
buffer back with the parser's line rules on flush. A value that does not survive that trip as the
same property is corrupted by the first keystroke. `block.update` accepts any string as a value
(`schemas.ts#PropertiesPatch`), so an agent can set `summary:: line1\nline2`; the buffer then reads
`title\nsummary:: line1\nline2`, the split takes `line2` as content, and typing one character wrote
`block.text "title!\nline2"`. Seen in a real browser before the fix: `page.read` after one `!`
returned `content: "title!\nline2"`. (The `summary` value itself was not rewritten only because a
refetch had already folded the truncated value into the local tree, so the diff saw no change.)
A value with leading/trailing whitespace is silently trimmed the same way, and a key the line regex
cannot read back (an imported `_foo`, normalized to `-foo`) is moved into the text and deleted.

**Fixed 2026-09-13.** `core/block-text.ts#showsInEditText(key, value)`: a property goes into the
buffer only if its `key:: value` line reads back as exactly that key and value. The others are
treated like `heading` — left out of `joinBlockText`, carried over untouched by
`editText.ts#withEditText`, and never deleted by `blockTextPayloads`. Typing a `summary:: x` line
still overrides one. The e2e test was red before the fix (the buffer read
`title\nsummary:: line1\nline2`); unit: `block-text.test.ts` "properties whose line would not read
back as themselves (B-152)", `editText.test.ts` "keeps a multi-line value out of the buffer".

---

### B-150 · Image paste uploads without a credential, so it cannot work in the served app
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, reading `editor/paste.ts` while
wiring `/image` (B-99) · **Test:** `e2e/tests/image-insert.spec.ts` "pasting an image uploads it
with the client's credential and inserts it (B-150)"

`editor/paste.ts#uploadImageAsset` calls `fetch("/api/v1/asset.upload")` with no `authorization`
header. Every `/api/v1/*` route sits behind `bearerAuth` (`packages/server/src/http/app.ts`), so
the served app gets a 401 and the paste is silently dropped (the catch only logs to the console).
Nothing covered it: no e2e test pastes an image, and `assets.spec.ts` uploads through its own
authenticated helper. Same class of defect as the "client has no API credential" bug the e2e suite
was created for.

Confirmed at runtime before the fix: a synthetic image paste in the served app produced
`asset.upload -> 401` with no `authorization` header, and the block kept only its text.

**Fixed 2026-09-13.** `uploadImageAsset` goes through `data/api-client.ts#callOp`, which sends this
device's token and turns failures into `ApiError`. The e2e test pastes a PNG through a real
`ClipboardEvent` and reads the stored markdown back through `page.read`; it was red before the fix.

---

### B-99 · `/image` does nothing
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md`, defect D5)

`block.insertImage` is registered and delegated to the editor host, but `BlockTree.tsx` has no
case for it — no file chooser, text unchanged. The paste path (`editor/paste.ts#uploadImageAsset`)
already uploads; the slash item should open a file picker and reuse it.

`/image` does nothing. **Test:** `e2e/tests/image-insert.spec.ts` "/image opens a file chooser and
inserts the uploaded image at the caret (B-99)"; `apps/web/src/editor/imagePicker.test.ts`

**Fixed 2026-09-13.** `block.insertImage` is now handled where it is delegated
(`BlockTree.tsx`'s editor host `runStructural`): `editor/imagePicker.ts#pickImageFile` opens the
platform's own chooser through a hidden, connected `<input type="file" accept="image/*">` (no
Tauri/Capacitor-specific host needed), and the picked file goes through the paste path's
`uploadImageAsset` and the new `insertUploadedImage`, which inserts at the live caret — or, if the
editor moved to another block while the upload ran, into the original block at the caret it had
(paste used to drop the image into whichever block was being edited when the upload landed).
The e2e test was red before the fix (`page.waitForEvent("filechooser")` timed out). Not done:
drag-and-drop of an image file onto a block (the audit's "can follow").

---

### B-101 · Block properties are invisible in the UI, and `/property` writes literal text
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md`, defect D7)

A block with `foo:: bar` renders only its first line; the editor buffer has no property; and
`/property` inserts `key:: bar` into the CONTENT, which never becomes a property (`page.read`
shows it inside `content`, `properties` empty). Two halves: render property chips on the row and
make the editor's flush route `key:: value` lines through the outline parser's property handling.

Block properties are invisible in the UI, and `/property` writes literal text. **Test:**
`e2e/tests/block-properties.spec.ts` "show as chips under the block, and as key:: value lines while
it is edited", "a typed key:: value line is stored as a property, not as text", "/property inserts a
line that becomes a real property (the audit's D7 repro)", "editing a value and deleting a line
change and remove properties; undo restores"; unit `packages/core/src/block-text.test.ts`,
`apps/web/src/editor/editText.test.ts`, `commands/registrations/insert-logic.test.ts`

**Fixed 2026-09-13.** Both halves, on the seam B-100 opened (`EditableBlock.properties`):
- *Seeing them.* `editor/BlockProperties.tsx` renders a block's properties as compact muted
  `key: value` chips under its rendered content (values through `InlineContent`, so `[[links]]`
  navigate; clicking elsewhere on the chips enters edit mode). Hidden: `list` (the ordinal says it)
  and the keys Logseq's own `hidden-built-in-properties` hides (`hl-*`, `ls-type`, `query-*`,
  timestamps). Chips sit under the *whole* content, not between line 1 and line 2 as in Logseq —
  the rendered view's click-to-caret mapping needs one view over the whole content.
- *Editing them.* While a block is edited its buffer is its editing text — content plus
  `key:: value` lines (new `markdown-grammar.md` OUT-22a, `packages/core/src/block-text.ts`). On
  flush the buffer is split back with the outline parser's own line rules and written as a
  `block.text` if the text moved plus one `block.prop` per property added, changed or removed,
  diffed against the block as the edit began (so a property set elsewhere meanwhile survives).
  `BlockTree.tsx` maps carets between buffer and content at the surface boundary (split at the
  caret, history carets, attach). Undo works on properties: `invert.ts` reads the prior value from
  `properties` (it inverted generic keys to `null`), `optimistic.ts` models generic `block.prop`,
  and `history.ts` merges coalesced transactions per field (replacing wholesale lost a property
  written earlier in the same typing burst).
- `/property` inserts `:: ` under line 1 and the existing property lines with the caret before it
  (type the key, End, the value); a `key` placeholder would itself be written as a property.
Reserved keys (`scheduled::` etc.) and `heading::` typed in the buffer stay text, as before (B-96/
B-102 own dates). Literal `key:: value` lines already sitting in some block's content (the old
`/property` output) become real properties the first time that block is edited — which is what the
same text in a file means. Also: Enter in a numbered item continues the list, and duplicate copies
generic properties (`commands.test.ts`).

---

### B-100 · Numbered lists never render
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md`, defect D6)

`list:: number` is parsed and stored, but `BlockTree.tsx` hard-codes `listNumber: false` and the
client `BlockRow` carries no generic properties, so `numbering.ts` always has nothing to number.
Fix: project the property through the client row shape.

Numbered lists never render. **Test:** `e2e/tests/block-properties.spec.ts` "list:: number
siblings render 1, 2 and restart after a plain bullet"; `apps/web/src/db/worker-core.test.ts`
"carries each block's generic properties, not tombstones or reserved keys (B-100)"

**Fixed 2026-09-13.** The worker's page tree (`db/worker-core.ts#pageBlockTree`) now reads every
live block's non-null `block_prop` rows for the page in one query and hangs them on
`BlockTreeNode.properties`; `EditableBlock.listNumber` (always `false`) became
`EditableBlock.properties`, and `numbering.ts#isNumbered` reads `properties.list === "number"`.
Core's `BlockRow` is unchanged — the server shares it and reads properties its own way. The e2e
test would have caught it: before the fix a page seeded with `list:: number` blocks rendered zero
`.vr-list-number` (the audit's runtime check, D6). Side effect: Cmd+C on selected blocks now copies
their properties too (it wrote `properties: {}`).

Real graph (copy of the owner's, 952 pages): `tools/probes/real-graph-properties.mjs` opened the six
pages with the most numbered blocks plus three property-heavy ones in a real browser against
`nooklet serve`, and compared every rendered row with the database — ordinals recomputed from
`block_prop` and sibling order independently of the client, chips counted per block. 177 visible
numbered rows (Claude code queue 55, zahradni-domek 43, 2026-01-11 31, 2025-04-06 21, Megapage
21, a PDF-highlights page 6) and 70 rows with chips: 0 wrong. (OmnivoreSync's 357 numbered
blocks sit under collapsed parents, so none were visible.) A property typed into a real block
through the UI wrote exactly one
`block.prop` op; `nooklet verify` afterwards: OK, 20,412 ops.

Creating one in the UI: Enter in a numbered item continues the list (`commands.ts#splitBlock`), and
a "Numbered list" command (slash item and palette, `commands/registrations/numbered-list.ts`)
toggles `list:: number` — **Test:** `block-properties.spec.ts` "Enter at the end of a numbered
item makes the next item numbered too", "the Numbered list slash item numbers a block, and a second
use stops it"; `numbered-list.test.ts`. Not done: Enter on an *empty* numbered item does not end
the list (Logseq does); `popups.spec.ts`'s slash order gained the item.

---

### B-202 · An open tag page's "Pages tagged X" does not follow a `tags::` change made elsewhere
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, verifying B-111 on a copy of the real
graph · **Test:** `e2e/tests/tagged-pages.spec.ts` "an open tag page follows another device
untagging and re-tagging a page (B-202)"

With `VerifyTag`'s page open, an agent's `page.update {page: "Remote Tagger", properties: {tags:
null}}` left "Remote Tagger" listed under "Pages tagged VerifyTag" for the 15 s the probe waited
(and indefinitely: nothing else on the page changed), while a `page.create` carrying the same tag
appeared in ~25 ms. Cause: the panel's `page.backlinks` resource (`data/store.ts#
useLinkedReferences`) is stamped on the `block` and `page` tables plus the local-push signal, and a
pulled `page.prop` op only bumps `page_prop` (`db/worker-core.ts#notifyFromOps`). Until B-111 the
panel showed nothing a page property could change except linked references through an `alias::`
edit, which had the same gap unnoticed.

**Fixed 2026-09-13.** `useLinkedReferences` is also stamped on `page_prop`, so a pulled `tags::` or
`alias::` change refetches the panel like a block edit does. Costs one `page.backlinks` call (8–14 ms
on the real graph for `journal`) per page-property write while a page is open. The e2e test failed
before the change (the untagged page stayed listed) and passes after; the references, link-unlinked,
page-icons, pages, tagged-pages, page-identity and page-title-draft specs pass with it (38).

---

### B-201 · A half-typed page title reverts when any other page changes
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, reviewing B-104's change to what
`usePageByName` listens to · **Test:** `e2e/tests/page-title-draft.spec.ts` "a half-typed page
title survives other pages being created and edited (B-201)"

Click a page's title, type " renamed" without leaving the field, and let anything create or rename
a page anywhere (sync, an agent, another tab): the input snaps back to the stored name and the
typing is gone. Measured with the e2e test before any fix: with the lookup listening to `page` only
(as on `da85cfb`), a `page.create` of an unrelated page reverted it; with B-104's lookup — which
also listens to `page_prop`, so an alias added elsewhere resolves — setting an icon on an unrelated
page reverted it too. So the bug predates this branch, and B-104 widened it. Cause: `PageView`'s
`createEffect(() => setTitleDraft(page()?.name …))` re-runs whenever the resource value changes, and
`usePageByName` returned a freshly built row object on every refetch, so every refetch looked like a
change.

**Fixed 2026-09-13.** `data/store.ts#usePageByName` hands back the previous row object when every
field of the refetched row is equal (`samePageRow`), so Solid's value signal does not notify and
nothing downstream re-runs; the lookup itself moved into `findPageRowByName`, unchanged. Fixed in the
store rather than in `PageView`'s effect so every reader (the shelf too) stops re-rendering on
unrelated writes, and so the fix does not touch the lines `m8/qafix-render-sync` edits. The e2e test
fails with the reuse disabled (checked) and passes with it. Believed still open, narrower (from
reading the code, not tested): a remote change to THIS page's row (e.g. its `updated_at`) while its
title is being typed would still reset the draft — guarding the effect on `page()?.name` in
`PageView` would close that.

---

### B-111 · ADR 017's `tagged_pages` group was never built
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, wiki workstream (doc-vs-code drift) ·
**Test:** none yet

ADR 017 says `page.backlinks` gains a `tagged_pages` group so that `Person` or `Journal` lists the
pages carrying that tag. Neither the op nor the References panel does; the `page_tag` index exists
and `page.list({tag})` reads it, so the gap is the op output and one panel section.

**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, wiki workstream (doc-vs-code
drift) · **Tests:** `e2e/tests/tagged-pages.spec.ts` "a tag's page lists the pages tagged with it,
above linked references (B-111)", "a page with tagged pages but no linked references still shows
the panel (B-111)", "a page tagged later, by a property update, appears on the tag's page (B-111)";
`packages/server/src/ops/page-backlinks-tagged.http.test.ts` (7: property tags by name, `Journal`
intrinsic newest-first after named pages, alias-written tags and self-exclusion, shared
limit/cursor, tag removal and block targets, MCP description + `tools/call`, and — added by the
verification pass — "follows the tagged page through delete and undo, and answers the same for an
alias target");
`apps/web/src/views/TaggedPages.test.tsx`

**Fixed 2026-09-13.** Server: `page-tags.ts#pagesTaggedWith` reads `page_tag` for the target's own
key plus alias keys (the set linked references already match), one row per page (`intrinsic` wins),
never the target itself, named pages by key then journal days newest first. `page.backlinks` returns
`tagged_pages: [{id, page, source}]` and `tagged_total`; `limit`/`cursor` window `linked` and
`tagged_pages` together (the cursor stays while either has more). A target with no page of its own
(`Journal` on most graphs) still answers from the index. The MCP description names the group, the
render line adds "N page(s) tagged X", `docs/spec/mcp-tools.md` §4.3.6 has the schema and example,
ADR 017's "not built" note and the three wiki pages that said so are updated. Client:
`views/TaggedPages.tsx` (own CSS file) renders "Pages tagged X" with the total as its count, a
wrapped list of page names, collapsible, and "Showing N of M." when the panel's 200-row request
returned fewer than exist; hooked into `ReferencesPanel` above linked references, which now also
shows when tagged pages are all there is. All three e2e tests fail against `da85cfb`'s
`ReferencesPanel.tsx`/`page-backlinks.ts` (checked). Not built: ADR 017's "a `property` tag is
removable, an `intrinsic` one is not" control — the list marks `data-source` but offers no remove.

Real graph (`tools/probes/refs-real-graph.mjs`): the owner's lowercase `journal` page shows "Pages
tagged journal" with count 825, 200 names shown newest first in the reader's format ("Mon,
07.09.2026", …), "Showing 200 of 825.", then Linked and Unlinked references, ~110–220 ms from
`goto`. `page.backlinks {target: "journal", limit: 500}`: `tagged_total` 825, 500 rows, cursor
present, 8–14 ms. `{target: "book"}` (no `book` page exists): the one highlights page carrying
`tags:: book, design`, source `property` — which the UI cannot show, see B-200.

---

### B-104 · `/page/<alias>` says the page does not exist
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md`, defect D10)

`alias::` is indexed server-side since B-55, but `usePageByName` resolves by `page.key` only, so
a route naming an alias 404s in the UI while `page_read` resolves it. Fix: fall back to
`page_alias` in the client lookup (the table exists in the replica).

**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md`, defect D10) · **Tests:** `e2e/tests/page-identity.spec.ts`
(all seven: "/page/<alias> opens the page and replaces the URL with its own name", "a [[wrapped]]
alias with a comma resolves, and a zoomed block stays zoomed", "following [[alias]] lands on the
page, and links onward from it do not bounce back", "an alias added while its URL is open turns
'does not exist' into the page", "a page renamed over the API still opens from its old URL"; and two
added by the verification pass: "renaming a page from its title after an alias redirect stays on
it, and the alias still finds it", "an alias two pages claim moves to the survivor when its page is
deleted, without bouncing the open view");
`apps/web/src/data/page-alias.test.ts`; `apps/web/src/views/canonicalPageRoute.test.ts`;
`packages/core/src/page-alias.test.ts`

The client replica has no `page_alias` table (sql-schema.md rule 1: derived tables are
server-only), contrary to the BUGS.md entry's "the table exists in the replica"; the fallback has to
read `page_prop` `alias` rows and parse them the way `packages/server/src/page-aliases.ts` does.
It also bit every page renamed through `page.update` (which keeps the old name as an alias): its
old URL and bookmarks said the page did not exist.

**Fixed 2026-09-13.** Three parts. (1) The `alias::` parser (`aliasKeysOf`, with `[[…]]`/`#`
unwrapping and journal-date canonicalisation) moved from `server/src/page-aliases.ts` to
`packages/core/src/page-alias.ts`, so the client reads a value exactly as the server's index does;
the server module re-exports it. (2) `apps/web/src/data/page-alias.ts#findPageByAlias` scans live
pages' `alias` rows in the replica; `store.ts#usePageByName` tries it last (after the key and the
journal day, so an alias never shadows a real name) and is now also stamped on `page_prop`, so an
alias added while its URL is open resolves without a reload. (3) `views/canonicalPageRoute.ts`
(one hook call in `PageView`) replaces an alias URL with the page's own name, keeping `?block=`.
Journal days are not redirected (they have always been addressable by any title format). The
redirect waits for the resource to finish loading: while a new route loads, a Solid resource still
returns the previous page, and comparing that with the new name bounced every link-follow back —
the "links onward" e2e test fails with the guard removed (checked). All five e2e tests fail against
`da85cfb`'s `store.ts`/`PageView.tsx` (checked). Known limit, unchanged: when two pages claim the
same alias the client picks the older page, the server (`resolvePageIdForKey`) whichever row SQLite
returns first.

Real graph (`tools/probes/refs-real-graph.mjs`, a copy of the owner's graph served on 6406):
`/page/daně` → `/page/Taxes`, `/page/zahrada` → `/page/Garden`, and the `[[…]]`-wrapped alias with
commas → the `hls__The_Logic_of_Experimental_Tests…` page, each in ~230–275 ms from `goto`;
`/page/GARDEN` resolves by its own key without a redirect. `pnpm nooklet verify` on the copy
afterwards: 20,411 ops, OK.

---

### B-89 · `marker`/`priority`/`collapsed` in a `block.create` properties bag are silently dropped
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, seeding a server test for ADR 019 ·
**Test:** none yet (a `packages/core/src/sync/apply-ops.test.ts` case creating a block with
`properties: { marker: "TODO" }` and reading `marker` back would catch it)

`data.blocks.insert({ content: "x", properties: { marker: "TODO" } })` creates the block with
`marker = NULL`; the same bag with `scheduled` or `repeat` works. `applyBlockCreate` INSERTs the
row with `marker_hlc = op.hlc`, then routes each bag entry through `writeBlockField`, whose
`lwwSetColumns` refuses a write whose HLC is not newer than the column's — a tie with the very
op that created the row. The columns the INSERT leaves `NULL` (`scheduled_hlc`, `deadline_hlc`,
`repeat_hlc`, `done_hlc`) accept the write; the three it stamps do not. The top-level
`marker`/`priority`/`collapsed` fields of `block.create` are the working path and every core
caller uses them, so this only bites an API/plugin caller who puts a reserved key in the bag.
Fix: in `applyBlockCreate`, fold bag values for those three keys into the INSERT itself (or
stamp their `_hlc` columns `NULL` on insert and let `writeBlockField` set them).

**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, seeding a server test for ADR 019 ·
**Tests:** `packages/core/src/sync/apply-ops.test.ts` "marker/priority/collapsed in the properties
bag land in their columns (B-89)", "a set top-level field wins over the bag; an unset one takes the
bag's value (B-89)", "an invalid reserved value in the bag is dropped, the block is still created
(B-89)"; `packages/server/src/block-create-bag.test.ts` "writes marker, priority and collapsed, and
the block becomes a Task"

Reproduced as described in BUGS.md before fixing: the first core test and the server test both
failed against `da85cfb`'s reducer (`expected null to be 'TODO'`). The owner's op log (a copy taken
2026-09-13, 20,411 ops) has no `block.create` carrying a reserved key in its bag — 870 creates carry
a bag, 0 of them `marker`/`priority`/`collapsed` — so changing what such an op replays to changes
nothing `nooklet verify` compares on that graph.

**Fixed 2026-09-13.** `packages/core/src/sync/apply-ops.ts#applyBlockCreate` folds bag
`marker`/`priority`/`collapsed` into the row INSERT and skips those three keys in the bag loop. A
set top-level field wins; an unset one (`null`, or `collapsed: false` — the model cannot tell false
from unset, and core producers such as `templates.ts` always send both defaults next to a bag) takes
the bag's value; an invalid bag value is dropped without failing the create, like any other invalid
inline property (a top-level invalid marker/priority still rejects). `docs/spec/sql-schema.md` rule
24's `block.create` paragraph says so. The server test checks the derived `#Task` ref too, since a
dropped marker also meant the block was not a task. `pnpm nooklet verify` on the real-graph copy
afterwards: 20,411 ops replayed, OK.

---

### B-186 · A client half that fails to bundle is re-bundled on every unauthenticated request
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, verification of impl-plugins ·
**Test:** `packages/server/src/plugins/bundler.test.ts` "is bundled once per activation, however
often its unauthenticated URL is requested"

Since client halves are bundled on first request (`PluginHost.clientBundle`, B-103 work), a failed
bundle reset the cached promise so "a later request retries". The route that asks,
`GET /plugins/:id/:file`, is mounted before the auth gate, so anyone who could reach the server
could make it run esbuild once per request for any plugin whose client half does not build (3
requests → 3 esbuild runs and 3 error logs in the test before the fix), and the 500 body echoed
esbuild's message, absolute paths included.

**Fixed 2026-09-13.** The rejection stays cached until the plugin is reloaded (a reload activates a
fresh entry, which bundles again); the 500 body says to see the server log.

---

### B-185 · `/mermaid` leaves the caret after the closing fence
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, verification of impl-plugins ·
**Test:** `e2e/tests/plugins.spec.ts` "/mermaid is in the slash menu and inserts a diagram that
renders" (types " --> C" straight after inserting); `apps/web/src/plugins/host.test.ts` "/mermaid
inserts the starter diagram at the caret through the editor host" (asserts the caret)

The starter was inserted with the caret after "```", so the next keystroke produced "```X" — no
longer a closing fence — and the diagram became a parse error. Core "Code block" puts the caret
inside its fence.

**Fixed 2026-09-13.** The slash command passes `insertText(STARTER, { cursor })` to land at the end
of "  A --> B". `EditorApi.insertText`'s `cursor` is now documented as an offset into the inserted
text, which is what the host already implemented.

---

### B-184 · A mermaid fence that fails to parse leaves a "Syntax error" drawing under <body>
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, verification of impl-plugins ·
**Test:** `e2e/tests/plugins.spec.ts` "a broken mermaid fence says why instead of rendering nothing"
(now also asserts no `body > [id^="dnooklet-mermaid-"]`)

`mermaid.render` appends a temp `div#d<id>` to `document.body`; on a parse error it draws its
"Syntax error in text" bomb there and throws without removing it (mermaid 12.0.0
`renderDiagram`: `removeTempElements()` runs on that path only with `suppressErrorRendering`).
Three broken fences left three such divs; with B-183 every edit to the page added more. Hidden by
`body { overflow: hidden }` but in the DOM and the accessibility tree.

**Fixed 2026-09-13.** `plugins/mermaid/src/client.ts` initialises mermaid with
`suppressErrorRendering: true`; the error still reaches the plugin's catch and is shown in the fence.

---

### B-183 · Diagrams drop back to their source and re-draw on every edit anywhere on their page
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, verification of impl-plugins ·
**Test:** `e2e/tests/plugins.spec.ts` "a diagram stays drawn while another block on its page is
edited (B-183)"; `apps/web/src/editor/render/PluginFence.test.tsx` "a fence re-created for the same
source shows the last drawing at once, not its source (B-183)"

Every write to a page (one coalesced op per typing pause in any block, a sync pull) re-creates the
rendered content of every row on it — rows survive, their `.vr-block-view` children do not
(pre-existing; probed by marking a paragraph, a code `<pre>` and the diagram in untouched rows,
typing in a fourth: all three were new nodes). For synchronous content that is invisible. For a
plugin fence it is not: `PluginFence` starts from the `<pre>` source and mermaid draws
asynchronously, so each write flashed every diagram on the page back to its source. Measured with
a `requestAnimationFrame` sampler: 4 flashes of 14–52 ms, 328 px → 95 px → 328 px, typing three
words in a sibling row; on the owner's graph copy (journal 2022-12-15) 9 frames without the
diagram, 452 px → 134 px, everything below it jumping.

**Fixed 2026-09-13.** `PluginFence` remembers the last thing each renderer drew per language +
source (`WeakMap` per renderer, 64 entries) and puts it into a re-created fence synchronously,
before the renderer runs again, so no frame paints the source. The rows re-creating their content
is not changed. Without the fix the e2e test saw 8 frames without the diagram.

---

### B-181 · Every server start leaks a temp directory per plugin client half
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, impl-plugins · **Test:**
`packages/server/src/plugins/bundler.test.ts` "writes into the plugin's own .nooklet-build,
content-addressed, never a temp dir per call"

`packages/server/src/plugins/bundler.ts#bundleClientEntry` bundles into a fresh
`mkdtemp(tmpdir(), "nooklet-plugin-client-")` on every activation and nothing ever removes it. On
this machine `$TMPDIR` held **2,063** `nooklet-plugin-client-*` directories (counted 2026-09-13 with
`readdirSync(os.tmpdir())`) — every `nooklet serve`, every e2e run and every server unit test that
loads plugins adds two. Harmless at ~2 KB each; not once mermaid is bundled rather than fetched
from a CDN (B-103), which makes each one 12 MB.

**Fixed 2026-09-13.** The client bundle is built in memory (`write: false`), hashed, and written
once to `<pluginDir>/.nooklet-build/client.<hash>.js` (already gitignored, where the server half's
bundle lives) through a per-process temp name and a rename, so concurrent servers on one checkout
write identical bytes safely and a restart with unchanged source writes nothing. The directories
already in `$TMPDIR` are not cleaned up by this. The test that would have caught it:
`bundler.test.ts` "writes into the plugin's own .nooklet-build, content-addressed, never a temp dir
per call" (bundles twice, asserts one file inside the plugin dir).

---

### B-103 · Client plugin halves never load
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md`, defect D9)

`apps/web` has no plugin host: the browser makes zero requests to `/plugins/*` or
`/api/v1/plugins`, so the client halves of the built-in plugins (Mermaid, Word count) are
unreachable even though the server lists them with a `client_url`. research/13 §4.1 marks both as
"have"; they are not. Fix: build the host (a day) or move mermaid rendering into core (an hour).

Found independently the same day by the templates workstream while deciding plugin-vs-core (ADR 019
§"Core, not plugin"): `/mermaid` and every `registerSlashCommand` are dead on arrival because
nothing in `apps/web` implements `ClientPluginContext` and `SlashMenu` ranks a static list. Its
duplicate entry (briefly numbered B-87, colliding with the refactors workstream's B-87) was folded
in here.

**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, exposure audit · **Test:**
`e2e/tests/plugins.spec.ts` (all six), `apps/web/src/plugins/host.test.ts`,
`apps/web/src/editor/render/PluginFence.test.tsx`, `apps/web/src/commands/slash/SlashMenu.test.tsx`
"shows a row contributed while it is open…"

Client plugin halves never load: nothing in `apps/web` implements `ClientPluginContext`, so
`/mermaid`, the mermaid fence renderer and word-count's status item are unreachable.

**Fixed 2026-09-13.** A client plugin host (ADR 023): the built-in client halves are compiled into
the web build (`apps/web/src/plugins/builtins.ts`) and activated at startup inside the command
layer. `registerSlashCommand` registers a registry command and contributes a slash row — the menu
now ranks a signal (`commands/slash/contributed.ts`), not the module constant that made any
runtime row impossible; `registerCodeBlockRenderer` feeds a registry `tokens.tsx`'s fence case
consults (`editor/render/PluginFence.tsx`); `registerStatusItem` mounts into a top-bar strip.
Unimplemented context members throw with their name. mermaid is now the plugin's own dependency,
lazily loaded, instead of a jsdelivr fetch; word-count listens to a new client-only
`page.changed`. Compiling word-count's client half with the app found a type error esbuild had
been stripping since M4 (`CountResult` as an `interface` is not `Json`), fixed in the same commit.
The tests that would have caught it: `plugins.spec.ts` "/mermaid is in the slash menu and
inserts a diagram that renders", "a mermaid fence renders as a diagram, not as code", "word count
shows the open page's words and follows edits (audit item 14)"; `host.test.ts` "activate and
register /mermaid, the mermaid fence renderer and the word-count status item".

---

### B-178 · `journal-stream-editing.spec.ts` types into another spec's block when the whole suite runs
**Status:** fixed · **Severity:** low (test only) · **Found:** 2026-09-13, verifying impl-journal
(full chromium e2e run on port 6403) · **Test:** the spec itself

The B-174 spec wrote to the journal day nine days back, "a past day no other spec writes to" — but
`graph.spec.ts` appends `journal mentions [[Graph Leaf]]` to that same day, and sorts first. In a
full run the spec clicked the section's FIRST block (graph's), typed there, and failed waiting for
`["earlier day baseabc"]` (got `["journal mentions [[Graph Leaf]]abc", "earlier day base"]`). It
passed whenever it ran without `graph.spec.ts`, which is how it was verified. **Fixed 2026-09-13:**
an unused day (-8), a click on the spec's own block by its text, and a `toContain` on the stored
blocks. Still fails on `da85cfb`'s `JournalStreamView.tsx` (editor focus lost), so it still guards
B-174.

---

### B-177 · After midnight, a day pinned from the calendar can be Today too, rendered twice
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, verifying impl-journal (B-170's
rollover with Playwright's fake clock) · **Test:** `apps/web/src/views/JournalStreamView.test.tsx`
"drops a calendar pin once midnight makes the pinned day Today, so the day is not rendered twice
(B-177)"

At 23:59 pin tomorrow from the stream's calendar (allowed: it is not today). At 00:00 B-170 moves
Today to that day, and the pinned section stays — the same journal page is rendered by two
editable `BlockTree`s one above the other (seen: Today and "Back to stream" sections both listing
block `1m2cv41ffra8gm`). Before B-170 "today" never changed while the view was mounted, so a pin
could never equal it.

**Fixed 2026-09-13.** `JournalStreamView` clears the pin when Today becomes the pinned day — the
pin's whole meaning was "a day that is not Today". The test fails without the fix (the "Jumped-to
day" region is still there after the fake clock moves to the pinned day).

---

### B-176 · Any write rebuilds every "Scheduled and deadline" row, dropping keyboard focus on one
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, verifying impl-journal · **Test:**
`apps/web/src/views/JournalAgenda.test.tsx` "keeps every row across a refetch, updating a changed
one in place (B-176)"

Reproduced in real Chromium on a copy of the owner's graph: Tab-focus an agenda row on today's
journal, then let any write land (here `page.append` to an unrelated page through the API — a sync
pull or an agent does the same) — `document.activeElement` becomes `<body>`. Marking the rows'
DOM nodes and typing one character anywhere in the stream replaced 5 of 5 rows; on a stress copy
(686 dated open tasks) 587 of 587 on every debounced write (~800 DOM mutations each; no frame over
50 ms on this machine, so it is a focus/selection defect rather than a speed one). Cause: the agenda
resource refetches on every `block` write and `agendaForDay` builds new group and entry objects;
`<For>` is keyed by reference, so each row is torn down and rebuilt — the B-174 pattern, one level
down.

**Fixed 2026-09-13.** `JournalAgenda` iterates page ids and, per group, task ids (string-array memos
with an element-wise `equals`), reading each group and entry from a map; a row lives as long as its
task is listed and updates in place when the task changes. The test fails without the fix (new row
elements after a refetch of equal data, focus lost).

---

### B-175 · A web link inside a "Scheduled and deadline" row opens the task instead of the link
**Status:** fixed (agenda) / open (query fence, unverified) · **Severity:** low · **Found:**
2026-09-13, verifying impl-journal (real Chromium against `nooklet serve` on a copy of the owner's
graph plus seeded dated tasks) · **Test:** `apps/web/src/views/JournalAgenda.test.tsx` "a web link
inside a task opens the link, not the task (B-175)"

A task `TODO zavolat [[@Robin]] kvůli dárku https://example.com/darek` scheduled for today: in
today's agenda, clicking the `https://…` link opened no tab; the app navigated to
`/page/Úkoly — Čeština?block=…` instead. The `[[@Robin]]` link in the same row works (its handler
stops the event). Cause (read): `JournalAgenda.tsx`'s row `onClick` calls `preventDefault()` on
every click that bubbles up to it, and plain web links (`link`/`autolink` tokens in
`render/tokens.tsx`) have no handler of their own, so the browser's "open in new tab" is cancelled
and the row navigates. `QueryFenceView.tsx`'s hit rows have the same shape (`stop(e)` on the row)
and so very likely the same defect — not reproduced, not touched here.

**Fixed 2026-09-13 (agenda only).** The row's click/Enter handler returns early when the event came
from an `a[href]` inside the row, so the browser follows the link. The test fails without the fix
(`dispatchEvent` answers false: the click was cancelled).

---

### B-174 · Typing in an earlier day of the journal stream drops out of editing after the first write
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, impl-journal (the real-graph
performance probe's typing step kept "losing" its editor) · **Test:**
`e2e/tests/journal-stream-editing.spec.ts`, `apps/web/src/views/JournalStreamView.test.tsx`

On `/journals`, click a block on any day below Today and type: about half a second later (the
editor's debounced write) the caret is gone — focus drops to `<body>`, and further keys go nowhere.
Today's own section is not affected. Reproduced on a clean `git archive da85cfb` build against a
copy of the owner's graph: marking every `.journal-day` element, typing one character into the
first earlier day, and waiting 1.5 s left 1 of 29 sections as the same DOM element (Today's);
the other 28 had been replaced, and `.cm-content` no longer existed
(`scratchpad` probe `debug-remount.mjs`; the kept probe is `tools/probes/journal-agenda-perf.mjs`,
whose typing step failed the same way). Cause: `JournalStreamView` renders earlier and upcoming
days with `<For each={earlierDays()}>` over `JournalDayEntry` objects; every write refetches
`useJournalStream`, which builds new entry objects, and `<For>` is keyed by reference — so every
section, with its `BlockTree` and the editor inside it, is torn down and rebuilt on each write.
Today's section is a non-keyed `<Show>`, which is why it survives.

**Fixed 2026-09-13.** `JournalStreamView` iterates day NUMBERS (`laterDays`/`earlierDays` are
`number[]` memos with an element-wise `equals`) and reads each day's entry from an `entryByDay`
map inside the section, through a non-keyed `<Show>`. Numbers compare by value, so a section — and
the `BlockTree` and editor in it — lives as long as its day is in the stream. Tests that would have
caught it: `journal-stream-editing.spec.ts` "typing in an earlier day keeps editing across the
write, and every key lands (B-174)" (fails on a clean `da85cfb` build: the editor is gone after the
first write), and `JournalStreamView.test.tsx` "keeps every day's outline mounted when a write
refetches the stream (B-174)" (old view: 13 `BlockTree` mounts after three refetches instead of 4).

---

### B-170 · The journal stream keeps yesterday as "Today" after midnight
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, impl-journal (reading
`views/JournalStreamView.tsx` while adding the "Scheduled and deadline" section) ·
**Test:** `apps/web/src/views/streamToday.test.ts`, `apps/web/src/views/JournalStreamView.test.tsx`

`JournalStreamView` reads `todayJournalDay()` once, when it mounts. A tab left open overnight —
the normal state of a desktop outliner — still shows yesterday under "Today" the next morning, with
no virtual row for the real today; typing lands on yesterday's page. Only navigating away and back
fixes it. Same root cause as B-94 (no signal for "the local day changed"); it matters more once the
day carries a "Scheduled and deadline" list, which would show yesterday's agenda as today's.

**Fixed 2026-09-13.** `views/streamToday.ts#createStreamToday` gives the stream a "Today" that
follows `data/day-clock.ts#currentDay()` (midnight timer, visibility, focus — see B-94). It holds
back only while input in the stream is less than two seconds old: moving "Today" unmounts the
`BlockTree` showing yesterday's page, and a typed edit still inside that tree's 500 ms debounce is
not flushed on unmount, so switching mid-sentence at 00:00 could drop keystrokes. An idle caret
does not hold the day back. Tests that would have caught it: `JournalStreamView.test.tsx` "moves
Today to the new day when the local day changes (B-170)" (fails on the old view: the virtual row
stays on the old day); `streamToday.test.ts` — midnight, visible-after-sleep, "waits for typing in
the stream to pause before moving, then moves", "does not wait on an idle caret". Not covered by
e2e: Playwright's clock could fake it, but the stream would need a page open across a fake
midnight; the unit tests drive the same signal. **Update (verification pass):** now covered —
`e2e/tests/journal-midnight.spec.ts` opens `/journals` at a fake 23:59:45 and fast-forwards past
midnight (Today's agenda moves to the new day), and does the same for a `deadline:today` query
fence (B-94). Both fail when `day-clock.ts#check` stops moving the day.

---

### B-94 · A ```query fence keeps yesterday's "today" after midnight until something else changes
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12 while building the fence (ADR 011
amendment, "Deferred") · **Test:** none — a real clock would have to cross midnight

Leave a page with `scheduled:<=today` open across midnight: the results still reflect the
previous day, because the fence re-runs only when `block`/`block_prop`/`page` change
(`data/queries.ts`, stamped on the change bus) and `today` is read at evaluation time. Any edit,
pull, or navigation fixes it. A timer that bumps the version at local midnight (and on
`visibilitychange`, for a phone that slept through it) is the fix; it belongs next to
`stampedFor` in `data/store.ts` so the Tasks view's "today" grouping benefits too.

**Status:** fixed · **Severity:** low · **Found:** 2026-09-12 while building the fence ·
**Test:** `apps/web/src/data/queries.today.test.ts`, `apps/web/src/data/day-clock.test.ts`

Unchanged from `docs/BUGS.md`: `useQueryResults` (`data/queries.ts`) re-runs only when
`block`/`block_prop`/`page` change, and `today` is read at evaluation time, so a page with
`scheduled:<=today` left open across midnight lists the previous day's results.

**Fixed 2026-09-13.** New `apps/web/src/data/day-clock.ts`: the local day as a Solid signal
(`currentDay()`), kept by a timer aimed just past local midnight (capped at five minutes, because
browser timers stop while a machine sleeps), `visibilitychange` to visible, and window `focus`.
`useQueryResults` puts `{ query, today: currentDay() }` in the resource source and passes that
`today` to `runQuery`, so a rollover re-evaluates with no table change. Put in its own module
rather than next to `stampedFor` in `store.ts` (as the entry suggested) so the journal views can
use it too without widening the store seam. Tests that would have caught it:
`queries.today.test.ts` — "re-evaluates `today` at local midnight without any table changing" and
"re-evaluates when the page becomes visible after sleeping through midnight" (both fail on the old
`queries.ts`: `expected [ 20260912 ] to deeply equal [ 20260912, 20260913 ]`); the clock itself in
`day-clock.test.ts` (midnight, visibility, focus, a sleep-paused timer, DST-safe midnight, one
notification per rollover).

---

### B-229 · Double-clicking the favourite star leaves the page favourited
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, adversarial verification of
`m8/impl-export` · **Test:** `e2e/tests/page-export.spec.ts` "double-clicking the star toggles twice
and leaves the page as it was"

Two toggles in quick succession should cancel out; they do not. `app/page-actions.ts#togglePageFavorite`
reads the stored `favorite` value, then writes its opposite through the worker. The second click's
read runs before the first click's write has landed, so both read "not a favourite" and both write
`true`. Measured (Chromium, production build): `dblclick()` on `.page-favorite-button` ends with
`aria-pressed="true"` and `page.read` reporting `favorite: "true"`.

**Fixed 2026-09-13.** `togglePageFavorite` queues behind the toggle in flight (one module-level
promise chain; a rejected toggle does not block later ones), so the second read sees the first
write. The named test failed before the change (the star still pressed after `dblclick()`) and
passes after. The All Pages star (`views/AllPagesView.tsx`) toggles from its rendered state instead
and was not changed or measured here.

---

### B-228 · An agent with live UI control can overwrite the person's clipboard, start downloads and open the print dialog
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, adversarial verification of
`m8/impl-export` · **Test:** `apps/web/src/commands/registrations/page-actions.test.ts` "copy, export
and print refuse ui_run; toggling a favourite does not"

`app.copyPageMarkdown`, `app.exportPageMarkdown` and `app.printPage` are ordinary registered
commands with no `remoteInvocable` flag, so `ui_run` (ADR 015 §2.4, `live/command-runner.ts`) runs
them in the person's window: `runRemoteCommand(deps, "app.copyPageMarkdown", { page })` returns
`ran` and calls the host. Chromium lets a focused document write the clipboard without a gesture,
so an agent silently replaces whatever the person had copied; `window.print()` puts a modal dialog
over their window (and in Chromium blocks the page's script until it is dismissed, so the remote
call hangs with it); Export drops a file into their Downloads. `Command.remoteInvocable`'s own doc
(`commands/types.ts`) reserves `false` for exactly this — commands "that act outside the document
model entirely" — and an agent that wants a page's text already has `page.read`.

**Fixed 2026-09-13.** The three commands carry `remoteInvocable: false`, so `runRemoteCommand`
answers `not_permitted` without calling the host. `app.toggleFavorite` is unchanged — a synced page
property, which an agent may set like any other. The named test runs the real registrations through
the real `runRemoteCommand` and failed before the flags (`app.copyPageMarkdown: expected
{ when_result: 'ran' }`). R52a in `docs/spec/commands-and-keymap.md` says so.

---

### B-227 · A printed page's title is cut off after one line
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, adversarial verification of
`m8/impl-export` (PDF of a long-titled page) · **Test:** `e2e/tests/page-export.spec.ts` "a page
title too long for one printed line prints whole"

An ordinary page's title is an `<input class="page-title-input">` (`views/PageView.tsx`), and an
input cannot wrap. B-221's print stylesheet puts the page on paper but leaves the title in that
input, so a name longer than one printed line is clipped at the sheet's edge with nothing to say
so: `page.pdf({ format: "A4" })` of "Projekty/Velmi dlouhý název stránky, který se na papír nevejde
celý do jednoho řádku" printed "…nevejde cel" and stopped (input 794px wide, `scrollWidth` 1030).
Journals are unaffected — their title is already an `<h1>`. The owner's graph copy has 8 page names
over 45 characters (the `hls__…` and `hypothesis__/…` pages), which is about where an A4 line of
the title font runs out.

**Fixed 2026-09-13.** `PageView.tsx` renders the title a second time as `<h1 class="page-title-print">`
(from the same draft signal the input shows); `styles/print.css` keeps it `display: none` on screen
and, in print, hides `input.page-title-input` and shows the heading with the input's type and
`overflow-wrap: anywhere` (the `hls__…` names have no spaces to break at). The named test failed
before the change (the input was still visible in print media) and passes after; a PDF of the
owner's longest name, `hls__The_Logic_of_Experimental_Tests,_…_1670184390828_0`, now prints on two
lines.

---

### B-223 · The mirror orders siblings with the same order key by insertion order, not by id
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, reading `mirror/export.ts` while
sharing its renderer with the client (B-220) · **Test:** `packages/core/src/sync/page-outline.test.ts`
"orders siblings with the same order key by id, whatever order they were inserted in"

`renderPageToOutline` sorted blocks `ORDER BY order_key` alone. Two devices inserting at the same
spot mint the same fractional key and nothing on the server rewrites a collision, so a tie is
reachable; SQLite then returns the tied rows in rowid (insertion) order. That order is different
on the server and on every replica, and different from what the editor shows, which breaks ties
by id (`apps/web/src/editor/tree.ts#sortSiblings`; core's `listChildren` does `ORDER BY order_key,
id` too). Consequence: the mirror file can list two siblings in the opposite order from the page
on screen, and a page exported from the browser would not match its mirror file.

**Fixed 2026-09-13.** The renderer moved to `packages/core/src/sync/page-outline.ts` (shared with
the web export, B-220) and sorts `ORDER BY order_key, id`. The named test fails with the old
`ORDER BY order_key` (checked by reverting the clause: 1 failed / 5 passed) and passes with the
fix. The owner's graph (copy of 2026-09-13: 952 pages, 18,628 live blocks) has zero tied
`(page_id, parent_id, order_key)` groups, so no mirror file there changes.

**Note (adversarial verification, 2026-09-13):** the mirror and the browser export now agree with
the editor, but `page.read` does not: `packages/server/src/data-api.ts` (the two child queries near
line 162) still sorts `ORDER BY order_key` alone, and so do `embeddings/units.ts` and
`ops/graph-overview.ts`. On a tie an agent reading the page sees the siblings in insertion order.
Not changed here (outside this branch's files); no number left in B-220..B-229 to log it under.

---

### B-222 · Favourites can only be set from /pages; the sidebar's recent list is labelled "Pages"
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, exposure audit §1.7 and §2 #13 ·
**Tests:** `e2e/tests/page-export.spec.ts` "the star in the title row favourites and unfavourites
the page, and the sidebar follows", "Toggle favourite from the palette stars the routed page; the
sidebar's recent list reads Recent"; `apps/web/src/data/page-export.test.ts` `isFavoriteValue`

The only favourite control is the star column in `views/AllPagesView.tsx`. The page itself and
the palette have none, so on a fresh graph the sidebar's Favourites section never appears and
nothing hints that it could. The sidebar section under it is titled "Pages" but lists the twelve
most recently edited pages — a second "Pages" right under the nav link of the same name that
opens the full list.

**Fixed 2026-09-13.** A star in the page title row (always visible, filled when favourited) and a
"Toggle favourite" palette command (`app.toggleFavorite`), both writing the synced `favorite`
page property through the existing `setPageFavorite`. The star's state uses `isFavoriteValue`,
the sidebar query's exact test (`value NOT IN ('', 'false')`), so the two cannot disagree. The
sidebar's recent section is headed "Recent"; `pages.spec.ts` and `page-icons.spec.ts` located it
by the text "Pages" and now locate it by its heading.

---

### B-221 · Printing a page prints the app chrome and silently drops collapsed children
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, exposure audit §2 #10 · **Tests:**
`e2e/tests/page-export.spec.ts` "printing a long page prints all of it — without the chrome,
collapsed children expanded, in light ink", "Print page from the palette closes the palette and
opens the print dialog"; `apps/web/src/editor/tree.test.ts` "expandAll (print, B-221)…"

There is no print stylesheet and no print command. Cmd/Ctrl+P prints the top bar, the sidebar,
the shelf and the help button around the page, and a collapsed block's children are not in the
DOM at all (`editor/tree.ts#flattenVisible` skips them), so a printed or PDF'd page loses content
with no mark that anything is missing.

Worse than the audit said: **everything below the first screen is cut off.** The shell is
`position: fixed` over a `height: 100%; overflow: hidden` body, with `.page-scroll` as the only
scroller, so print layout sees one viewport. Measured at `da85cfb` (Playwright, Chromium, print
media, `page.pdf()`): a 120-block page produced a **1-page** PDF with `.app-topbar` visible and the
collapsed block's child absent. The same run showed `page.pdf()` fires `beforeprint`/`afterprint`,
which is what lets a test observe the print-time DOM.

**Fixed 2026-09-13.** `apps/web/src/styles/print.css` (`@media print`): the shell back to normal
flow, chrome/page controls/references hidden, the light palette forced (a dark-theme screen printed
light-grey ink), `print-color-adjust: exact` on the outline (a first PDF had no bullets or guides —
they are backgrounds), `content-visibility` off for rows. `apps/web/src/app/print.ts` flips a signal
on `beforeprint`/`afterprint` that `BlockTree`'s rows memo passes to `flattenVisible` as
`expandAll`, so collapsed children are in the DOM for exactly the print and nothing is written.
"Print page" (`app.printPage`) in the palette and the title-row menu calls `window.print()`. The
named e2e test asserts ≥3 PDF sheets for the same 120-block page, the hidden child and the last
line in the print-time DOM, chrome hidden, light ink, exact colour, and the page still collapsed
afterwards (also in `page.read`). Not checked: Safari/WKWebView print, page breaks inside very long
blocks.

---

### B-220 · A page cannot be copied or exported as markdown from the app
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, exposure audit §2 #9 · **Tests:**
`e2e/tests/page-export.spec.ts` "Export as markdown downloads exactly the file the mirror wrote for
the page", "Copy as markdown puts the page on the clipboard without ids, including a just-typed
edit", "Export from the palette acts on the page the route shows"

Portability is the #1 reason people leave Logseq (research/13 §3.5) and the markdown mirror is
nooklet's answer — but inside the app there is no way to get a page's text out. `block.copySelection`
copies selected blocks only; `nooklet export` and the mirror directory are server-side and
invisible to a person in the browser or on a phone. No palette command, no control on the page.

**Fixed 2026-09-13.** Palette commands "Copy page as markdown" (`app.copyPageMarkdown`) and
"Export page as markdown" (`app.exportPageMarkdown`), and the same two in a new "…" menu in the
page title row (`views/PageActions.tsx`), which runs the registered commands with the page in
`args`. The text is rendered in the browser from the local replica by the mirror's own renderer,
moved to `packages/core/src/sync/page-outline.ts` for this (SQL + a pure row -> tree build; the
server's `mirror/export.ts` now calls it too), so it works offline and includes unpushed edits.
Export = the mirror file byte for byte, `^id`s included, under the mirror's file name; Copy = the
same render with ids off. The first named test compares the download with the file the real
server's mirror wrote to disk. Copy starts `navigator.clipboard.write` with a promised
`ClipboardItem` inside the click/key, which is what WebKit requires — verified on Chromium only.

---

### B-216 · A web link inside an embedded row does not open; the click goes to the block instead
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, adversarial verification of
`m8/impl-embeds` on a copy of the owner's graph · **Test:** `e2e/tests/embeds.spec.ts` "a web link
inside an embedded row opens the link, not the block (B-216)" and `apps/web/src/editor/render/embed.test.tsx` "a web link in a row keeps its own default…"

The owner's 2024-09-29 embed carries a row that is just a Mattermost URL. Clicking that link on its
own page (2024-09-26, zoomed to the block) opens it in a new tab; clicking the same link inside the
embed opened no tab and navigated the app to `/page/2024-09-26?block=…` (probe
`tools/probes/embeds-external-link.mjs`, external requests fulfilled locally). `EmbedRow`'s row
handler calls `preventDefault()` on every click that bubbles up to it, which cancels an `<a
href target=_blank>`'s own navigation; only `[[page]]` links survived, because `NavLink` stops the
click first. Enter on a focused link inside a row had the same fate through the row's `keydown`.
The query fence's result rows (`QueryFenceView.tsx#HitView`) have the identical handler, so their
links are presumably dead too — not reproduced, not fixed here.

**Fixed 2026-09-13.** `EmbedRow#go` returns early for a click or Enter whose target is inside an
`a[href]`, stopping propagation (so the host does not enter edit mode) without `preventDefault`. Both
tests failed before the change (the e2e test timed out waiting for the tab; the component test's
`fireEvent.click` returned `false`) and pass after.

---

### B-215 · Shift+click on an embedded row shelves a card that says "This block is gone."
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, adversarial verification of
`m8/impl-embeds` (reading `BlockTree.tsx#onShelfOpen`, then reproduced in Chromium) · **Test:**
`e2e/tests/embeds.spec.ts` "Shift+click on an embedded row shelves that block, from its own page
(B-215)"

B-210's summary promises "Shift+click puts it on the shelf". `EmbedRow` calls
`ctx.onShelfOpen({ kind: "block", id })`, and the only provider, `BlockTree.tsx#onShelfOpen`, fills
in the page id as `props.pageId` — the page the tree is showing, which for an embedded row is the
HOST page, not the page the block lives on. `Shelf.tsx#BlockCard` then reads the host page's tree,
does not find the block, and the card is titled with the host page and reads "This block is gone."
(seen in the e2e test: `" Embed Host Shelf RowThis block is gone."`). The component test only
checked the call's `{ kind, id }` against a mock, so it passed.

**Fixed 2026-09-13.** `render/tokens.tsx#NavigateTarget`'s block kind takes an optional `pageId`;
`EmbedRow` passes the embedded page's id (`EmbedData.page.id`) and `BlockTree#onShelfOpen` uses it
before falling back to its own `props.pageId`. The e2e test failed before (card text above) and
passes after; `embed.test.tsx`'s Shift+click case now asserts the page id too.

---

### B-214 · Typing anywhere on a page collapses its embeds to the placeholder and back, and resets their expand toggles
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, adversarial verification of
`m8/impl-embeds` on a copy of the owner's graph · **Test:** `e2e/tests/embeds.spec.ts` "typing
elsewhere on the page leaves an embed in place, unfolded rows included (B-214)"

On the owner's 2024-09-29 journal (an embed of 27 rows), one keystroke in the day's first block
made the embed's host row measure 775 → 51 → 775 → 51 → 775 px (a `ResizeObserver` on the row):
the embed is torn down and rebuilt twice per keystroke, and each rebuild shows the one-line
"Embed: ((id))" Suspense fallback until the new resource's first read lands. Typing in a block
*below* an embed (a page with `{{embed [[2024-09-29]]}}` above it) moved the editor on screen
between y=309, 875 and 1233 while typing six characters. A row unfolded with the embed's own toggle
folds again on the next keystroke anywhere on the page. Probes:
`tools/probes/embeds-typing-remount.mjs`, `embeds-typing-flash.mjs`,
`embeds-toggle-survives-typing.mjs`.

Cause (verified by tagging DOM nodes): `BlockTree` hands every row a new `block` object whenever the
page tree re-reads (every write), and `BlockRowView`'s `content` memo and its `ctx.source` both read
`props.block.content` — so the row's `.vr-block-view` survives but everything rendered inside it is
rebuilt, including a fresh `EmbedView` whose `useEmbed` resource starts unresolved and suspends. The
same rebuild is what makes a ```` ```query ```` block flicker 78 → 45 → 78 px (pre-existing, same
cause); for plain text it was invisible.

**Fixed 2026-09-13.** `BlockRowView` memoizes `props.block.content` as a string and both the
classification and `ctx.source` read that memo, so the rendered view is rebuilt only when the row's
text changes. The e2e test (an unfolded embedded row, a tag on the outline element, the host row's
minimum height) failed before the change — "about the car" folded away — and passes after. Re-run
on the graph copy: the embed row's height stays 775 / 942 px through typing, the editor stays at one
y, the unfolded row stays open, and the query block's 78 → 45 px flicker is gone with it.

---

### B-212 · A finished task inside a query result strikes through the whole query block
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, rendering the owner's embeds on a
copy of the real graph · **Test:** `e2e/tests/embeds.spec.ts` "a finished task inside an embed or a
query result does not strike through its host (B-212)"

A ```` ```query ```` block whose results include a DONE or CANCELED task renders struck through
and dimmed from its first line to its last — the query text, the count, every open result. The
same happened to the new embeds on the owner's 2024-09-29 journal: one checked item in the
embedded list struck through the source line and every open item around it. The rule is
`editor/editor.css` `.vr-row:has(.vr-marker-DONE) .vr-block-view`: `:has()` with a descendant
combinator matches a marker anywhere inside the row, including the rendered results and embedded
rows nested in its content, not just the row's own marker pill. `shell/shelf.css`
`.shelf-block:has(.vr-marker-DONE) .shelf-block-text` has the same shape (a shelved block holding
an embed or a query).

**Fixed 2026-09-13.** Both rules now look only at the block's own marker through child combinators:
`.vr-row:has(> .vr-row-main > .vr-marker-DONE) .vr-block-view` and
`.shelf-block:has(> .shelf-marker.vr-marker-DONE) .shelf-block-text` (CANCELED likewise). The test
reads computed `text-decoration-line` on the host row of an embed, the host row of a query, and a
shelf card holding the embed; before the fix each of the three read `line-through` (checked one at a
time by reordering/reverting), after it `none`, while the finished item itself is still struck.
`tasks.spec.ts`'s own-marker strike test still passes.

---

### B-210 · `{{embed [[Page]]}}` and `{{embed ((id))}}` show a box with the target's name, never its content
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md` §1.9 and §2 item 8) · **Tests:** `e2e/tests/embeds.spec.ts`
(nine tests, from "a block embed shows the block and its children, read-only, root unfolded" to
"an embed of a block that does not exist says so", including "on the shelf, a self-embedding block
shows the notice rather than a copy of its page"); `apps/web/src/editor/render/embed.test.tsx`;
`apps/web/src/editor/render/embedRows.test.ts`; `apps/web/src/data/embeds.test.ts`

Write `{{embed ((id))}}` in a block (or pick "Embed block" from the slash menu): the rendered
block is a dashed box reading `Embed: ((1m287mdbkcaggj))` — the id, not the embedded block or its
children. `{{embed [[Page]]}}` likewise reads `Embed: [[Page]]`. The owner's graph has six embeds,
each a journal day carrying forward an earlier day's task list (6–60 blocks); every one of them
reads as an opaque id. `editor/render/tokens.tsx#EmbedView` is a placeholder with no data seam
behind it (its header lists it under "Known gaps"), and `docs/spec/markdown-grammar.md` §4 promises
the target's blocks.

**Fixed 2026-09-13.** Read-only, as the audit proposed; editable transclusion is not built.
`data/embeds.ts#loadEmbed` reads the target through the worker's `getPageTree` (a block embed finds
its node in its page's tree; a page resolves by key, then by journal day), `useEmbed` re-reads on any
page/block/block_prop change and never rejects. `editor/render/EmbedView.tsx`, lazy behind its own
Suspense in `tokens.tsx`, renders an outline: a row click navigates to the block (Shift shelves it),
the source line opens the page, a click on the frame still edits the host. The embedded root always
shows its children (two of the owner's five working embeds point at a block collapsed on its own
day); deeper collapsed blocks stay folded with a view-local toggle; 250 rows at most. Termination:
`MAX_REF_DEPTH` (2, shared with block refs) and `RenderCtx.embedPath` — `BlockRowView` passes the row's
id (so does the shelf's `ShelfOutline`, whose card otherwise painted the page inside itself once —
seen failing with 2 rows before that line), each embedded row adds its own, and an embed whose
target tree contains one of them shows a notice (`embedRows.ts#embedReachesPath`). Rows carry `data-embed-block-id`, not `data-block-id`
(see B-211). On a copy of the owner's graph (`tools/probes/embeds-real-graph.mjs`) all five
well-formed embeds render (6, 12, 27, 27 and 31 rows, no page errors); the sixth, written
`{{embed ((id))}` with one closing brace, is not an embed to the tokenizer and still renders as text
plus a block reference. The e2e tests would have caught it: on `da85cfb` there is no `.vr-embed-item`.

---

### B-190 · Redo of an undone Enter, paste or duplicate shows the block but never writes it
**Status:** duplicate · **Severity:** medium · **Found:** 2026-09-13, writing the redo half of
B-108's test · **Test:** `e2e/tests/redo.spec.ts` "redo after undoing Enter brings the new block
back in the database, not only on screen"; `apps/web/src/editor/history.test.ts` "undoing a split
(block.create) deletes the new block; redoing revives it"

**Duplicate of B-240** (the QA fixer and the editor workstream fixed it in parallel). B-240's fix is what landed — the redo re-sends a revive instead of the create, with a round trip against real SQLite; this entry's create-plus-revive variant was not merged.

Press Enter in a block (a new bullet), Cmd/Ctrl+Z (it goes), Cmd/Ctrl+Shift+Z: the bullet is
back on screen, but `page_read` does not list it, and a reload loses it along with anything typed
into it since. Same for any undone structural command that created blocks — split, multi-line
paste, duplicate, and now `/template`. `EditHistory.redo` re-mints the transaction's forward ops,
so the redo of a create is another `block.create` for the same id; the reducer's
`applyBlockCreate` is `INSERT OR IGNORE`, and the row the undo tombstoned is still there, so the
redo is a no-op in the database. The optimistic tree does not know that and shows the block.

Verified before the fix: the e2e failed on the API read (`["first"]`), and with that assertion
taken out, on the reload (`["first"]` again) — so the loss is real, not a slow sync. The unit test
of the same name existed and passed: it asserted only that the redo re-emitted a `block.create`.

**Fixed 2026-09-13.** `editor/history.ts#redoRecipes`: a redo follows each forward `block.create`
with a revive (`block.delete`, `deletedAt: null`) for the same id, minted after the undo's
tombstone so the reducer does not call it stale. Editor-side on purpose: making `block.create`
revive a tombstoned row in `@nooklet/core` would change what replaying the op log means, for every
device and `nooklet verify`. The unit test now asserts the revive and its ordering; the e2e above
would have caught it (it failed before the fix, passes after).

---

### B-88 · The row being edited stays on screen after its block leaves the page
**Status:** fixed · **Severity:** low · **Found:**
2026-09-12, `e2e/tests/refactor.spec.ts` "Move to page… asks for a page and moves the subtree to
its end" · **Test:** none for the editor itself; the spec covers the workaround

Right-click a block, *Move to page…*, pick a page: its children vanish from the source page at
once (the pull lands and the tree refetches), but the block itself — the row holding the
editor — stays, showing its old text, until you click elsewhere. Then it is gone. Same shape for
a block another device moves or deletes while you have the caret in it. `BlockTree` renders rows
from the tree but keeps the `editingId` row mounted regardless of whether that id is still in
the tree. A first diagnosis blamed the worker's change event (`notifyFromOps` naming only the new
page); a probe that read the rows after a click-away disproved it — `usePageTree` stamps on the
`block` table and did refetch.

Workaround in `commands/registrations/refactor.ts`: "Turn into page" and "Move to page…" end
editing (`block.selectBlock`) before the server op, so the row re-renders from the tree. The
proper fix is in `editor/BlockTree.tsx` (drop `editingId` when the tree no longer contains it),
which belongs to another owner this session.

**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, `e2e/tests/refactor.spec.ts` ·
**Test:** `e2e/tests/editing-row-leaves.spec.ts` "a block deleted elsewhere while the caret is in it
leaves the page", "a block moved to another page while the caret is in it leaves, and what was
typed goes with it", "Move to page… on the row being edited takes the row away and the text typed
just before" and "a block brought back by undo keeps its row while typing straight away" (the last
two added by the verification pass, below); `apps/web/src/editor/unseen-creations.test.ts`

Unchanged from `docs/BUGS.md`: the row holding the editor stays on screen, showing the old text,
after its block is moved to another page or deleted elsewhere. Before the fix both e2e tests
failed the same way: the pull landed (the block's child row went) and the edited row was still
there, editor and all, ten seconds later.

**Fixed 2026-09-13.** The cause was the `else` branch of `BlockTree`'s tree effect: any refetch
without the block being edited was taken for an optimistic creation not yet committed, and the
local row was kept. The tree now remembers which blocks it created or revived that no refetch has
returned yet (`editor/unseen-creations.ts`, fed from `commit`, `doUndo`, `doRedo`); only those keep
their row. A block the database had, missing from a later refetch, has left: the tree flushes
pending keystrokes (written to the block by id, wherever it went — the move test checks
`"goes typed"` arrives on the destination page), detaches the editor and ends editing. The "Move
to page…" workaround in `commands/registrations/refactor.ts` is gone. "Turn into page" still ends
editing before its op, for a different reason found while removing it: the block is rewritten,
not moved, and the editor keeps a stale buffer over an external rewrite — logged as B-192.

Not covered: a block created in this tab and removed elsewhere before any refetch has returned it
keeps its row until editing ends (a window one refetch long). Also not covered, found by the
verification pass (probe, 2026-09-13): another writer moving the edited block under a COLLAPSED
parent on the same page. The block stays on the page, so this path does not run; its row stops
rendering, the editor goes with it and focus drops to `<body>` — the same screen B-88's fix gives,
and the text typed before the move is saved (`"edited one"`), but `editingId` still names the
hidden block.

---

### B-108 · A template inserted with `/template` cannot be undone with Cmd/Ctrl+Z
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, building it (ADR 019) · **Test:**
none yet (an `e2e/tests/templates.spec.ts` case pressing Cmd/Ctrl+Z after an insertion would
catch it)

Insert a template, press Cmd/Ctrl+Z: the blocks stay. The editor's undo history is
`BlockTree`'s `commit` (`EditHistory.record`), which only sees ops that go through the tree's own
`runStructural`; `block.insertTemplate` writes its `block.create` ops through `data/store.ts`
directly, because a command outside the tree has no way to hand ops to its history. Fix is a
structural delegate (`EditorHost.runStructuralCommand("block.insertOps", …)` or similar) that
lets a command commit a batch through the tree — `BlockTree.tsx` is another agent's this
session. The API side is unaffected: `batch_undo` reverses an API-created template as usual.

**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, building it (ADR 019) · **Test:**
`e2e/tests/template-undo.spec.ts` "Cmd/Ctrl+Z takes back a template inserted into an empty bullet,
and redo restores it" and "Cmd/Ctrl+Z takes back a template inserted after a bullet with text,
caret back where it was", and "undo and redo of a nested template with a marker and a property on
the bullet" (added by the verification pass); `apps/web/src/editor/external-batch.test.ts`;
`apps/web/src/commands/registrations/templates.test.ts`

Unchanged from `docs/BUGS.md`: a template inserted with `/template` stays after Cmd/Ctrl+Z.
Before the fix both e2e tests failed at the undo: into an empty bullet, the text went back but the
template's children stayed (the text was the only part that went through the editor); after a
bullet with text, nothing changed at all.

**Fixed 2026-09-13.** A new `EditorHost.commitOps(batch)` seam (`commands/hosts/editor-host.ts`,
bridged in `app/editor-host.ts`) lets a command hand the tree ops it built itself; `BlockTree`
validates and re-mints them (`editor/external-batch.ts#prepareExternalBatch`) and commits them
through `runStructural`, the path a split takes — one history transaction. `data/templates.ts`
now builds the ops without applying them (`templateAfterOps`, `templateIntoBlockOps`, the latter
with the first line's text as a `block.text` op instead of an `EditorHost.replaceRange`), and the
command falls back to `applyOps` only when no mounted tree shows the block. `runStructural` now
places the caret when the focus stays on the block being edited (it used to call
`attachEditing` with the same id, which re-renders nothing). ADR 019 amended. The redo half of the
test also exposed B-190, fixed separately.

One gotcha for whoever touches the e2e: every spec shares one server, and a template left in the
graph changes `templates.spec.ts`'s Settings list; `template-undo.spec.ts` deletes its library
after each test for that reason.

---

### B-145 · The date picker stores a garbage date for `+10000y` and throws on every keystroke of `+99999999d`
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, adversarial verification of
`m8/impl-dates` (a real browser against the production build) · **Tests:**
`apps/web/src/commands/date-picker/parse.test.ts` "an offset that leaves the calendar is not a date
— never a garbage or NaN day (B-145)" and "refuses to format a day that is not on the calendar…",
`DatePicker.test.tsx` "a typed offset past the calendar's end is an error line, not a crash or a
write (B-145)", `e2e/tests/dates.spec.ts` "while the picker is open, the structural keys never
reach the tree, and a date past the calendar is refused without an error (B-145)" (fails against
the pre-fix parser: Enter closed the picker having written nothing)

Offsets were the one input with no size limit. `/scheduled`, `+10000y`, Enter: the preview said
"Sun, Sep 13, 12026", and the server then held `scheduled:: 1202-60-91` — `formatStoredDate`
sliced the nine-digit day `120260913` into four-two-two, and the reducer's `SCHEDULED_RE` checks
only the digit pattern, so `scheduled_day` became `12026091`: no chip (the chip parser rejects
it), but a due date in the year 1202 for the Tasks view and every `scheduled:<today` query.
`+99999999d` goes past what `Date` holds: `addDays` returned NaN, `formatJournalTitle` threw
`RangeError: Invalid time value` from the preview (two uncaught page errors while typing, the
preview frozen on the last good value), and Enter closed the picker having silently written
nothing. `-3000y` gave a negative day. Seen in e2e probe output: `C: props
[{"scheduled":"1202-60-91"}]`, `B: errors ["RangeError: Invalid time value", …]`.

**Fixed 2026-09-13.** `parse.ts` checks an offset's result with `isValidJournalDay` and says
`"+10000y" is too far away` otherwise (`+7973y` still reaches 9999); `formatStoredDate` throws a
`RangeError` rather than format a day that is not on the calendar, so no caller can store one;
the picker's arrows/PageUp/PageDown stop at the calendar's ends. All three tests failed before the
fix (the component test also with two unhandled `RangeError`s).

---

### B-143 · Import keeps `SCHEDULED: <2023-2-17 Fri>` as text and loses the date when Logseq wrote a one-digit month or day
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, impl-dates (checking chips
against a copy of the owner's graph)

In a copy of `~/.nooklet/default/graph.sqlite` only 4 blocks have `scheduled_day`, and 20 more
still carry a literal `SCHEDULED: <2023-2-17 Fri>` line in their content — so they show no chip,
sort nowhere in the Tasks view, and read as text. The Logseq source graph
(`~/notes-graph`) has exactly 24 `SCHEDULED:` lines: 4 zero-padded
(`<2023-01-06 Fri>`) and 20 not (`<2023-2-17 Fri>` ×19, `<2022-12-8 Thu>` ×1) — the 20 lost ones.
(Survey: `grep -rhoE "(SCHEDULED|DEADLINE): <[^>]*>" journals pages`, digits folded.) Cause:
`packages/core/src/outline.ts` `TIMESTAMP_INNER_RE` takes the date as `\d{4}-\d{2}-\d{2}` only,
and a non-matching timestamp falls through to content "so no data is lost". The same regex
takes the time as `\d{1,2}:\d{2}` and stores it unpadded, while the reducer
(`sync/apply-ops.ts#SCHEDULED_RE`) only accepts `HH:MM` — a `<2026-09-14 Mon 9:30>` would be
parsed into a value the reducer rejects (no such line exists in the owner's graph).

**Fixed 2026-09-13.** `outline.ts#orgTimestamp` accepts one-digit month, day and hour, zero-pads
them, and rejects an impossible date or time (kept as text, as before). Grammar spec OUT-23 rule
5 says so. Checked on real data: a fresh `pnpm nooklet import ~/notes-graph
--data <scratch>` now has 24 blocks with `scheduled_day` (was 4) and 0 blocks with
`SCHEDULED:`/`DEADLINE:` text (was 20); `pnpm nooklet verify` on it: 19,580 ops replayed, OK.
**The owner's live graph is not repaired by this** — the 20 blocks keep their text until the
graph is re-imported (or someone runs a one-off fix; none written).
**Test:** `packages/core/src/outline-org-dates.test.ts` (4 tests, all failed before the fix) and
`packages/server/src/importer/logseq.test.ts` "imports SCHEDULED/DEADLINE written with one-digit
month, day and hour (B-143)" (fails against the old parser — checked by restoring it).

**Repair written 2026-09-13; not yet run on the owner's graph.** The "Not done — needs the owner"
half: `nooklet repair org-dates [--apply]` (`packages/server/src/repair-org-dates.ts`) finds the
org timestamp lines an import before the fix left in block text, using the parser's own rule
(`core/outline.ts#orgDateLine`/`findOrgDateLines`, now shared with `parseOutline`), and writes the
real `scheduled`/`deadline`/`repeat` plus the text without the line — one `serverApplyOps` batch,
all or nothing, undoable with `batch_undo`. Dry run by default. Refuses (lists, leaves alone) a
block whose text disagrees with a date it already has or names two dates of one kind.
On a `.backup` copy of `~/.nooklet/default` taken 2026-09-13 17:28: the dry run listed exactly the
20 blocks (19 DONE + 1 unmarked; 19 on `2023-02-17`, 1 on `2022-12-16` with `<2022-12-8 Thu>`),
0 left alone; `--apply` wrote 40 ops in one batch; `verify` OK (20,482 ops); 0 blocks with
`SCHEDULED:` text left, 24 with `scheduled_day` (the same as a fresh re-import);
`tools/probes/date-chips-real-graph.mjs` on `/page/2023-02-17`: 19 chips (18 closed, 1 past), no
console errors. `batch.undo` over HTTP with the printed `batch_id` restored every block
byte-identical to the pre-repair copy (`verify` OK), and a second `--apply` repaired them again
(`verify` OK, 20,666 ops); a third run: "nothing to repair".
**Tests:** `packages/server/src/repair-org-dates.test.ts` (6: dry run writes nothing; one batch
that `verify` replays; `batch.undo` restores; the refusals; wins over a field HLC 30 s ahead —
fails if the clock is not seeded from the fields first, checked; all or nothing on a throw),
`packages/server/src/cli-args.test.ts` › "parseRepairFlags" (2),
`packages/core/src/outline-org-dates.test.ts` › "findOrgDateLines" (4).
**Still for the coordinator:** run it on `~/.nooklet/default` with the app quit (dry run first).
Checked since (verification, `tools/probes/repair-org-dates-open-window.mjs` on a fresh copy): with
`serve` running and a window open, `--apply` succeeds (no busy error), but the open window shows
nothing for 15 s — the server never learns of another process's write, so it pokes no client — and
shows the chips only after a reload; `batch.undo` over HTTP then reaches open windows live (~0.5 s).
So "quit the app first" is required, not a precaution.

---

### B-141 · The date picker's error line names only the first letter typed
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, impl-dates (screenshot review of
this branch's own picker; never on main) · **Test:** `apps/web/src/commands/date-picker/DatePicker.test.tsx`
"Enter on text that is not a date does nothing but say so; Backspace edits the text"

Type `bananas` into the picker and press Enter: the red line says `"b" is not a date — …`. The
line was `<Match when={invalidMessage()}>{(message) => message()}</Match>`. Solid's `Switch`
calls a Match's render function once, inside `untrack`; a function that returns the accessor's
value as a bare string (rather than JSX that reads it) captures the first message and never
updates while the condition stays truthy. No other `{(x) => x()}` render callback exists in
`apps/web/src` (grep, 2026-09-13).

**Fixed 2026-09-13.** The Match renders `{invalidMessage()}` as JSX, which Solid tracks. The test
named above now asserts the whole `"banana" is not a date`; run against the old line it failed
with `Received: ""b" is not a date — try tomorrow, fri, +3d or 2026-09-20"`.

---

### B-140 · A row-rendering module that imports the `lucide-solid` barrel stalls anything that renders a row under vitest
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, impl-dates (while adding chips) ·
**Test:** `apps/web/src/editor/render/render-seams.test.tsx` (the three ```` ```query ```` fence
tests time out when it regresses)

Seen while building B-102, never shipped: the first cut of `editor/DateChips.tsx` imported
`{ CalendarClock, Flag, Repeat } from "lucide-solid"`. `BlockRowView` imports it, and
`QueryFenceView`/`Shelf` import `BlockRowView` (for `MARKER_GLYPH`), so the query fence's lazy
view took longer than five seconds to load under vitest — the barrel re-exports 1,821 icon
modules and vitest, unbundled, evaluates each — and three `render-seams.test.tsx` tests timed
out waiting for it. Evidence: a one-off probe test that `import()`ed `QueryFenceView.js` hit
vitest's 5 s timeout with the barrel import, and passed once the three icons were imported by
path; moving the chip's static `app/date-picker.ts` import to click time first, on its own, did
not make the failing tests pass. Recorded because the trap is still set: the shell
(`Sidebar.tsx`, `AppShell.tsx`, `Shelf.tsx`, `HelpMenu.tsx`, `ReferencesPanel.tsx`) imports the
barrel, which is harmless only as long as no unit test renders those. In the production build
Vite tree-shakes the barrel, so this is a test-time cost, not a bundle one (not measured).

**Fixed 2026-09-13.** `DateChips.tsx` imports one file per icon
(`lucide-solid/icons/calendar-clock` …). It also loads `app/date-picker.ts` (and with it the data
layer) on click rather than at module load — not needed for the timeout, but a row renderer that
the shelf and the query fence share should not drag the replica client in.

---

### B-102 · A task's scheduled/deadline date is not shown on its row
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md`, defect D8)

`scheduled`/`deadline` are on `EditableBlock` and shown in the Tasks view, but `BlockRowView`
never renders them — a `TODO call mom` with `scheduled:: 2026-09-20` is just "☐ call mom" on the
page. Fix: a small date chip after the marker (a cheap win the audit ranks #2).

A task's scheduled/deadline date is not shown on its row.

**Fixed 2026-09-13.** `editor/DateChips.tsx` (one hookup line in `BlockRowView.tsx`) renders a
chip per date at the end of the row — relative label (Today, Tomorrow, Fri, Sep 20, Sep 20 2027,
with the time), `vr-date-overdue` on an open task whose date is before today, `vr-date-today`,
muted on DONE/CANCELED, plain `past` on a non-task. "Today" is a signal re-armed at local
midnight and on tab re-show, so a page left open overnight turns overdue without a refetch.
Clicking a chip opens the picker on that date, anchored under the chip, without entering edit
mode; the picker's Remove button clears it.
**Test:** `e2e/tests/dates.spec.ts` "chips: overdue on an open task, muted on a closed one, plain
on a note or a future date (B-102)" and "clicking a chip opens the picker on that date without
entering edit mode; a new date rewrites it; Remove clears it"; unit: `editor/date-chips.test.ts`.

---

### B-96 · `/scheduled`, `/deadline` and the date commands do nothing
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md`, defect D2)

`app/CommandLayer.tsx` passes `createFakeDatePickerHost()` — a test double — to the real command
set, so the trigger text is removed and nothing else happens; no picker element exists. Fix: a real
popover writing `setBlockProp` for `scheduled`/`deadline`.

`/scheduled`, `/deadline` and the date commands do nothing.

**Fixed 2026-09-13.** `app/CommandLayer.tsx` now hands the command set the real host
(`app/date-picker.ts` → `commands/date-picker/host.ts`) instead of `createFakeDatePickerHost()`.
`task.setScheduled`/`task.setDeadline` open a keyboard-first picker
(`commands/date-picker/DatePicker.tsx`, spec R38): type a date — `tomorrow`, `fri`, `+3d`,
`2026-09-20 14:00`, `20.9.`, `every week`, `none` (`commands/date-picker/parse.ts`) — or move the
highlight with the arrows (±1/±7 days, PageUp/PageDown a month), Enter sets, Escape cancels.
The editor keeps DOM focus throughout, so the caret is where it was when the picker closes. Keys
are taken in the window's capture phase and the popup keys are claimed through
`claimPopupKeys`; a document-level listener (as `TemplatePicker` uses) was tried and loses to the
global keymap in block selection: Backspace deleted the selected block (verified by swapping the
listener and re-running the e2e test below, which then failed with the block gone). A pick is one
`setBlockProps` batch (`scheduled`/`deadline` in ADR 011's `YYYY-MM-DD[ HH:MM]`, plus `repeat`
when one was typed). With an argument (an agent through `ui_run`) the commands write directly
with no picker.
**Test:** `e2e/tests/dates.spec.ts` "/scheduled, type tomorrow, Enter: scheduled:: is stored, the
chip appears, the caret never left (B-96)" (would have caught it: no `.date-picker` ever
appeared), plus "/deadline with a typed ISO date and time, then arrows…", "Escape cancels…",
"from block selection, the palette's Set deadline date opens the picker and Backspace edits the
date, not the selection"; unit: `commands/date-picker/{parse,host}.test.ts`,
`DatePicker.test.tsx`.

---

### B-160 · The shelf is reachable only by Shift+click
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md` §1.4, §1.10 #15, §2 item 6) · **Tests:**
`e2e/tests/commands.spec.ts` "the bullet context menu's Open on shelf puts that block on the shelf
(B-160)", "Open on shelf and Open this page on shelf run from the palette (B-160)", "Shift+Enter on
a page in the palette shelves it without leaving the current page (B-160)";
`apps/web/src/commands/registrations/shelf.test.ts`; `CommandPalette.test.tsx` "Shift+Enter on a
page row shelves it instead of opening it, and says so"

Nothing in the palette, the bullet context menu or the page switcher puts a block or a page on the
shelf; the only way in is a Shift+click on a bullet or a `[[link]]`, which nothing on screen
mentions. A keyboard user cannot shelve anything at all.

**Fixed 2026-09-13.** Two commands (`commands/registrations/shelf.ts`, host `app/shelf-host.ts`,
both landing in `app/shelf.ts#openOnShelf` like a Shift+click): `block.openOnShelf` "Open on shelf"
(`editorFocused || blockSelected`; the focused block or the first selected) and
`nav.openPageOnShelf` "Open this page on shelf" (the page on the current route; `nav.` because
`page.` is not an R2 area and would blank the app, B-87). "Open on shelf" is in the bullet context
menu under "Zoom in" (`context-menu.spec.ts`'s pinned label list updated). In the palette,
Shift+Enter — or Shift+click — on a page row shelves the page instead of opening it, and a hint line
under the list says so whenever a page row is highlighted. Limitation, same as `edit.mergePage`:
"Open this page on shelf" is listed off a page route too (journals, search) and does nothing there,
because `WhenContext` cannot see the route.

---

### B-106 · Comment and spec drift around commands
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md`, defect D12)

`DiagnosticsPanel.tsx` refers to an `app.diagnostics` command that does not exist;
`docs/spec/commands-and-keymap.md`'s table lacks the nine `format.*` and four `task.setMarker*`
commands and does not list `nav.openPage`/`nav.revealBlock`. Fix: regenerate the table from the
registrations (the wiki's shortcuts page already does this) and delete the stale comment.

**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit · **Test:**
`apps/web/src/commands/registrations/spec-tables.test.ts` (spec §E tables vs the registered
commands: ids, section/category, title, keys, `when`; spec R54's slash table vs `SLASH_ITEMS`)

What was still true at `da85cfb`: the nine `format.*` and the `task.setMarker*` rows had already
been added (the audit read an older spec), but eight registered commands had no row —
`nav.openPage`, `nav.revealBlock`, `block.insertQueryFence`, `block.insertTemplate`,
`block.turnIntoPage`, `block.moveToPage`, `edit.mergePage`, `search.findReplace` — and R54's slash
table lacked the Template and Query items while still saying templates are "not a core slash item",
which ADR 019 reversed. `DiagnosticsPanel.tsx` still named a nonexistent `app.diagnostics` command.
Every title, key and `when` of the rows that did exist matched the code.

**Fixed 2026-09-13.** Rows and short rules added for all eight (R32b, R43b, R49a, R52), plus this
branch's own `block.openOnShelf` / `nav.openPageOnShelf` (R32a, R43a) and `requiresArgs` (R1a);
R54 gains Template and Query and cites ADR 019. The DiagnosticsPanel comment now names the two real
ways in (the top bar's sync indicator, Settings → About). `spec-tables.test.ts` fails against
`da85cfb`'s spec (2 of 4 tests: the eight missing ids, and the slash table) and will fail the next
time a command is added without its row — which is the intent; the fix is a spec row. Also: the
wiki generator (`docs/wiki/tools/generate-shortcuts.mjs`) now passes the optional refactor and shelf
hosts (their commands were missing from the wiki page) and lists `requiresArgs` commands apart from
the palette-reachable ones; `docs/wiki/pages/Keyboard shortcuts.md` regenerated (90 commands).

---

### B-105 · Argument-only commands show as palette rows that do nothing
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md`, defect D11)

`nav.openPage` and `nav.revealBlock` take arguments (they are agent primitives for the live UI
channel) but appear in the palette as "Open page" / "Reveal block" and do nothing when chosen. Fix:
a `hidden`/`argsOnly` flag the palette respects.

**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit · **Tests:**
`apps/web/src/commands/palette/CommandPalette.test.tsx` "never lists a command that requires
arguments, even when the query matches it"; `apps/web/src/commands/registrations/palette-rows.test.ts`
(every command the palette lists with nothing focused, run with no args, must reach a host)

**Fixed 2026-09-13.** `Command.requiresArgs` (spec R1a): a command whose `run` does nothing without
`ctx.args` declares it, and `CommandPalette` filters those out. `nav.openPage` and
`nav.revealBlock` set it; `ctx.exec(id, args)`, the live-UI channel (`live/command-runner.ts`) and
a `keybindings.json` row with `args` still run them. Both tests fail with the flag removed.
`palette-rows.test.ts` is the general guard: it runs each of the ~20 commands the palette lists with
nothing focused, as a palette row does (no args), against the fake hosts, and fails for any that
reaches none — it would have flagged these two at registration time. It cannot see a real host
that ignores a delegate (B-97's shape); `e2e/tests/commands.spec.ts` covers that.

---

### B-98 · "Open plugin manager" leads to a blank page
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md`, defect D4)

`app/hosts.ts` navigates to `/settings/plugins`, which is not a route; the main area is empty.
Fix: open the settings panel's plugins section, or drop the command until one exists.

**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit · **Test:**
`e2e/tests/commands.spec.ts` "Open plugin manager opens Settings at the list of running plugins,
not a blank page (B-98)"

**Fixed 2026-09-13.** Not a manager — there is nothing to manage from the client: the server
exposes `GET /api/v1/plugins` (active plugins only) and no op to enable, disable or reload one
(`nooklet plugin …` is the only switch, and it takes effect when `nooklet serve` restarts). So
Settings gained a read-only Plugins section
(`views/PluginsSection.tsx`, data in `data/plugins.ts`) listing name, id, version and which halves
each plugin has, with a note naming the CLI commands, saying a restart of `nooklet serve` applies
them (added in verification — the note first read as if the change were immediate), and saying
disabled plugins are not shown.
`app.openPluginManager` now opens Settings scrolled to that section (`AppDeps.openPluginManager`,
wired in `CommandLayer.tsx`) and no longer navigates anywhere. The test compares the section's rows
with what the server's endpoint returns (the e2e server loads the repo's `plugins/`); against the
old code it fails on the URL changing to `/settings/plugins`. Spec R52 updated.

---

### B-97 · "Collapse all" and "Expand all" do nothing
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md`, defect D3)

Registered with `when` clauses and shown in the palette, but `BlockTree.tsx` has no `case` for
either id. Audit: on a 3-level page, Collapse all left 5 rows at 5. Fix: the two cases, over every
block with children (or the visible subtree when zoomed).

**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, exposure audit · **Tests:**
`e2e/tests/commands.spec.ts` "Collapse all and Expand all fold the whole page with nothing focused,
and it persists (B-97)", "zoomed into a block, Collapse all and Expand all act on that subtree only
(B-97)", "Collapse all while editing a block it hides ends editing, and the page stays editable
(B-97)", "a selected block that Collapse all folds away is deselected, so Backspace deletes nothing
hidden (B-97)", "Collapse all is one undo step: Cmd/Ctrl+Z in the page opens everything it folded
(B-97)"; `apps/web/src/editor/collapse-all.test.ts`; `apps/web/src/editor/outline-registry.test.ts`

Two causes, not one. The audit's reading was right that `BlockTree`'s `runCommand` and selection
switch had no case for either id. But even with the cases, the palette row the audit tried — with
nothing focused — could never reach a tree: structural commands go through
`app/editor-host.ts#activeEditorHost()`, which is the inert no-op host unless a block is being
edited or selected.

**Fixed 2026-09-13.** `editor/collapse-all.ts#setAllCollapsedOps` builds one `block.prop
collapsed` op per block with children whose flag changes — over the whole page, or, zoomed, over
the zoom root's subtree (Collapse all leaves the root itself open, Expand all opens it). `BlockTree`
commits them as one undoable batch through `commit`, the same path as Cmd+Up, so they sync and
mirror like any collapse. If the row being edited (or part of a selection) folds away, editing ends
— a surface left attached to an unmounted row swallows keystrokes. For the nothing-focused case,
every editable `BlockTree` registers in `editor/outline-registry.ts` and the no-op host hands the
two page-scoped ids (and only those) to all of them: on a page view that is the page; on the journal
stream, every loaded day. All three e2e tests fail against `da85cfb`'s `BlockTree.tsx` /
`editor-host.ts` (rows stay 6/4/2). Not covered by e2e: the journal stream fan-out (seeding journal
days in a shared-server spec disturbs `journals.spec.ts`; the fan-out is unit-tested).

Real graph (`tools/probes/collapse-all-real-graph.mjs`, a copy of the owner's graph served on 6402,
page "OmnivoreSync": 961 blocks, 150 parents, 110 collapsed): Expand all → 961 rows on screen in
467 ms, server shows 0 collapsed ~11 s later; Collapse all → 1 row (the page has one top-level
block) in 136 ms, server shows 150/150 collapsed ~11 s later, and a reload still shows 1 row. No
flag was written on a leaf. `pnpm nooklet verify` on the copy afterwards: 20,671 ops replayed, OK.
The ~11 s is the time for the batch to reach the server, not the UI — not investigated further.

Verification (second agent, 2026-09-13): the selection guard is load-bearing — with the
`setSelection(null)` line removed, the "deselected" test fails because Backspace deletes the hidden
`a1` on the server. Journal stream probed in a browser against a scratch server (3 seeded days):
nothing focused folds all three, a focused block folds only its day; `nooklet verify` OK. R26's
prose still said "every block" and "the page's overflow menu" (which does not exist); rewritten to
what the code does.

---

### B-85 · Moving a block to another page makes its children vanish from both pages
**Status:** fixed · **Severity:** high · **Found:** 2026-09-12, probing for `block.move_to_page` ·
**Tests:** `packages/server/src/ops/block-move-to-page.test.ts` "moves the whole subtree, not
just the root",
`packages/server/src/ops/page-merge.test.ts` "nested blocks survive the move"

`block_move {id: <a block with children>, page: "Other"}`: the block appears on `Other`, its
children appear nowhere. `page_read` of either page lists only what was already there, plus the
moved block with `children: []`. In the database the children still say `page_id = <old page>`
with `parent_id = <the moved block>`, so neither page's tree query finds them.

Cause: `@nooklet/core`'s `applyBlockPlace` updates one row — the block the op names — and a
`block.place` op that changes `pageId` carries nothing about descendants. The reducer is right to
be one-op-one-row (that is what makes it replayable), so the fix is at the op layer: every
cross-page move emits a `block.place` for each descendant too, keeping its parent and order and
changing only the page (`data-api.ts#subtreePlaceOps`). The M7 ops (`block.to_page`,
`block.move_to_page`, `page.merge`) and `DataApi.blocks.move` do this. **`ops/block-move.ts` does
not yet** — its `page:` form needs the same two-line change; owned by another agent this session.

**Fixed 2026-09-13.** `block.move` now goes through `data-api.ts#subtreePlaceOps` like the M7 ops: one
`block.place` per block, root first, only when the page changes. `updated` lists every moved id.
Test: `packages/server/src/ops/ops.http.test.ts` "moves the whole subtree when the target is another
page (B-85)" (rebuild parity asserted).

Big batches stall the server (F8, plus one found in passing while measuring B-120):

- **`recordChanges` looked each op's result up with `results.find`**, once per op — quadratic in
  the batch. `graph.replace` allows 20,000 blocks in one `applyOps`; a big `page.merge` or sync
  push is one batch too. The skeptic measured the `find` alone at about 0.25 s at 8k ops and 1.1 s
  at 20k.
- **A cross-page move of a large subtree was slow** on the code as it stood before this branch. Moving the owner's largest subtree (961 blocks) with `subtreePlaceOps`
  through `serverApplyOps` took 23 s at `da85cfb` (load average ~24 on a shared machine).
  `reindexTouchedEntities` calls `reindexBlockAndSubtree` for every placed block, which walks that
  block's whole subtree with `SELECT id FROM block WHERE parent_id = ?` — no `deleted_at` filter,
  so the partial `block_children` index cannot serve it and every step is a full scan — and
  rebuilds `path_ref` for each descendant: roughly subtree² full scans. Fix direction: collect the
  union of touched subtrees once per batch (live children via the index, tombstoned ones from one
  scan, as `subtree-page-repair.ts#childLookup` does), then rebuild each block's `path_ref` once.

**`recordChanges` fixed 2026-09-13 (F8).** One `Map` from op id to result, built once. No unit
test — a timing assertion is not a signal on a machine shared by a dozen agents, so this is
believed fixed and measured instead: `tools/probes/apply-ops-batch-scaling.ts` times the lookup
shapes side by side — at 16,000 ops, 1,364 ms of `find` against 2 ms of `Map` — and one
`serverApplyOps` of N `block.text` ops (2k / 8k / 16k: 266 / 2,419 / 8,243 ms before, 239 / 2,256 /
7,687 ms after, load average 5–13). The batch was still quadratic after that; the remaining cost
was the reindex walk in the second bullet (every `block.text` reindexed its block's subtree through
the unindexed `parent_id = ?` query — a full scan per block).

**Reindex walk fixed 2026-09-13.** `packages/server/src/block-children.ts#childLookup` reads live
children through `block_children` and tombstoned ones from one scan per pass;
`reindexTouchedEntities` rebuilds `ref` for every touched block first and then `path_ref` once for
the union of their subtrees (it rebuilt each touched block's whole subtree, per block). The subtree
page repair (B-120) and the B-86 re-index share the lookup. Test:
`packages/server/src/block-children.test.ts` "reads live children through the block_children index,
never a table scan per parent" (an `EXPLAIN QUERY PLAN` assertion — deterministic, unlike a timing).
Equivalence on real data: `tools/probes/reindex-parity-real-graph.ts` rebuilt every `ref` and
`path_ref` row of the owner's graph copy through the new walk — 2,185 and 32,671 rows, identical
to what the old walk had built. Measured (load average ~20, i.e. against the machine, not for it):
16,000 `block.text` ops in one batch 7.7 s → 1.8 s (8,000: 1.0 s, now linear); the owner's
961-block subtree moved by the server-planned path 23 s → 0.46 s, and by a device op (with the
B-120 repair) 18.8 s → 1.0 s.

---

### B-95 · `nooklet serve` never writes the markdown mirror
**Status:** fixed · **Severity:** high · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md`, defect D1)

Only `nooklet export` calls `exportAll` (`packages/server/src/cli.ts`); `config.mirror.enabled`
is read by nothing. Verified live by the exposure audit: `page.create` against a mirror-default
server produced no `pages/` directory. README and OPERATIONS §2 describe the mirror as continuous —
"a greppable copy you can walk away with" — which today is only true after running a command
nobody is told about. Fix: export each touched page after a commit, debounced, from the serve
process (`sync/realtime.ts#onCommit` already exists for exactly this kind of listener).

**Fixed 2026-09-12.** `mirror/live.ts`: `nooklet serve` subscribes to commits and, after a 500 ms
quiet period, runs `exportAll(…, { onlyChanged: true })` — the already-tested path that writes
changed pages, moves renamed ones and prunes deleted ones — plus one sweep on start to catch up
whatever happened while the server was down. `--no-mirror` is honoured for the first time. Failures
log and never throw: the mirror is a projection and must not take down the source of truth.
`packages/server/src/mirror/live.test.ts`.

---

### B-64 · Block-selection mode is keyboard-dead
**Status:** fixed · **Severity:** high · **Found:** 2026-09-12, e2e suite · **Tests:**
`e2e/tests/selection.spec.ts` (10 `fixme`), `e2e/tests/focus.spec.ts` "Escape while editing hands
the block to selection mode and Enter hands it back"

Escape (or Cmd/Ctrl+click) selects a block. From then on nothing on the keyboard does anything:
Enter does not re-enter editing, Shift+Up/Down does not extend, Backspace/Delete do not delete,
Tab does not indent, Cmd/Ctrl+A does not select all, Cmd/Ctrl+C copies nothing, Alt+Up/Down
does not move, and a second Escape does not clear. Two layers. After Escape, `surface.detach()`
removes the focused element and nothing focuses the outliner (`tabindex="-1"`), so its own
keydown handler never fires — `document.activeElement` is `<body>`. And on every route in, the
document-level dispatcher (`CommandLayer`'s `KeyboardDispatch`) matches the `blockSelected`
bindings first and runs them through `EditorHost.runStructuralCommand`, which returns early
because `surface.currentId()` is null while selected — then `stopPropagation` keeps the key from
the outliner's handler even when it does have focus (Cmd/Ctrl+click leaves focus on the
`.vr-block-view`). `task.cycle` is the one key that works, because it writes through the store.
`block.copySelection` additionally has no implementation anywhere (not in `keydown.ts`, no `copy`
handler).

**Fixed 2026-09-12.** Both layers: entering selection mode (Escape, or a Cmd/Ctrl+click) now
focuses the outliner root; the editor host forwards a command that arrives with no edited block to
the tree, which resolves it against the standing selection instead of returning early; and the
container's own handler ignores keys the editor already consumed, so the Escape that enters
selection mode cannot clear it on the bounce. `focus.spec.ts` 30/30 with the fixmes lifted.

---

### B-65 · The `[[` / `#` / `((` / `/` popups ignore the keyboard
**Status:** fixed · **Severity:** high · **Found:** 2026-09-12, e2e suite · **Tests:**
`e2e/tests/popups.spec.ts` (9 `fixme`)

With a popup open: ArrowDown/ArrowUp do not move the highlight; Enter splits the block at the
caret instead of selecting the row (`[[` + Enter leaves `[[` in one block and an empty block
below); Tab indents the block; Escape drops the block into selection mode, and the popup only
closes as a side effect of the editor detaching. Only the mouse works. The popup's `onKeyDown` is
on the popup element, which never has focus, and both `BlockTree`'s dispatch context and the
global dispatcher hardcode `popupOpen: false`, so R12 step 2 never applies. This is the class of
thing B-42 was reported as.

**Fixed 2026-09-12.** Two halves. `commands/popup-keys.ts`: a popup claims Escape / Enter / Tab /
ArrowUp / ArrowDown for exactly as long as it has a trigger, both dispatch contexts read
`popupOpen` from that claim instead of a hard-coded `false`, and the editor's keymap offers the
key to the popup before resolving it as a block command — so Enter selects a row instead of
splitting the block and Escape closes the popup instead of entering selection mode. And in
`CommandLayer`, a dismissal is remembered by the offset the trigger opened at: before, Escape
closed the popup and the very next keyup re-detected the `[[` still in the text and reopened it,
so Escape did nothing you could see. Three of the lifted tests then failed for a test-side reason
worth recording: they read the DOM after the caret had left the token, and the live preview hides
`[[`, `]]` and `# ` there by design — they now read the stored block. `popups.spec.ts` 40/40.

This is very likely what B-42 was reported as: Enter or Escape at the popup ended with the editor
gone, which reads as "focus keeps deselecting and I have to click again".

---

### B-66 · Delete-merge and undo change the block in the database but not in the editor
**Status:** fixed · **Severity:** high · **Found:** 2026-09-12, e2e suite · **Tests:**
`e2e/tests/focus.spec.ts` "Delete at the end merges the next block in, keeping the caret",
"Cmd/Ctrl+Z undoes typed text and Cmd/Ctrl+Shift+Z redoes it"

Delete at the end of `ab` with `cd` below: the database now holds one block `abcd`, the editor
still shows `ab`; keep typing and the two drift apart. Cmd/Ctrl+Z after typing ` typed`: the
database reverts to `base`, the editor keeps `base typed`, and a reload shows the other text. An
op that rewrites the content of the block being edited (`deleteForwardMerge`, a text transaction
from `doUndo`/`doRedo`) goes through `commit`/`applyOptimistic` but never touches the mounted CM6
buffer — and the refetch effect then prefers the live buffer, so the model quietly follows the
stale editor.

**Fixed 2026-09-12.** The rule "live buffer wins on refetch" stays — a first attempt to detect
"the database disagrees" at refetch time reverted a split mid-keystroke inside the full suite,
because a refetch that READ before our own write and RESOLVED after it is indistinguishable from
an external change. Instead the local operations that rewrite the edited block — `commit`,
`doUndo`, `doRedo` — sync the editor from the optimistic tree synchronously, where there is
nothing to guess; undo back into the block already being edited places the caret directly, since
`attachEditing` to the same id is a no-op.

---

### B-67 · Shift+Enter does nothing
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, e2e suite · **Test:**
`e2e/tests/focus.spec.ts` "Shift+Enter inserts a newline inside the block, not a new block"

R17's newline is never inserted. The global dispatcher matches `block.newline` (`when:
editorFocused`), runs it — which is deliberately a no-op, "left to CM6" — and then
`preventDefault` + `stopPropagation`, so CM6 never sees the key.

**Fixed 2026-09-12.** The handler inserts the newline itself through the editor view.

---

### B-68 · Alt+Down drops editor focus
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, e2e suite · **Test:**
`e2e/tests/focus.spec.ts` "Alt+Up/Down moves the block and keeps the editor in it"

Alt+Up keeps the editor; Alt+Down moves the block and focus lands on `<body>` (the test records
the `focusout` and its stack). The keyed `<For>` moves the focused row's DOM node, which blurs
it, and the attach-time refocus in `surface.ts` only runs on attach.

**Fixed 2026-09-12.** The refocus is deferred past Solid's reconciliation (a microtask, then a
frame — the same two-stage dance `surface.attach` does), guarded so a genuine click-away is not
fought.

---

### B-69 · `#` autocomplete never lists an existing page
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, e2e suite · **Test:**
`e2e/tests/popups.spec.ts` "lists a page that is already used as a tag"

Type `#` and a page's name: the only row is `New page "…"`. `createPageSource.listPages` never
sets `isTag`, and the popup keeps only `p.isTag === true` in tag mode, so the candidate list is
always empty.

**Fixed 2026-09-12.** `isTag` was declared on `PageSummary`, filtered on by the `#` popup and the
palette's tags mode, and set by nothing. A tag is a page (ADR 017), so `#` now offers every page,
ranked by the query, exactly as `[[` does; the flag is gone. `popups.spec.ts` "lists a page that
is already used as a tag".

---

### B-70 · The keyboard toolbar never appears on a phone
**Status:** fixed · **Severity:** high (phone) · **Found:** 2026-09-12, e2e suite · **Tests:**
`e2e/tests/phone.spec.ts` (2 `fixme`)

Playwright's plain `devices["iPhone 13"]` descriptor — WebKit, iPhone user agent, `pointer:
coarse`, no hover, so `detectPlatformFromEnvironment` reports `platform: ios`, `mobile: true` —
and the same under Chromium emulation: tap a block, type with the editor focused, and no
`.cmd-toolbar` ever renders. `MobileKeyboardToolbar`'s `visible` memo reads `getContext()` →
`activeContextSnapshot()`, which before any block is edited is a constant object with no reactive
reads, so the memo computes `false` once and is never re-run; even afterwards `editorFocused` comes
from `surface.currentId()`, a plain variable, not a signal.

**Fixed 2026-09-12.** The toolbar's `visible` memo read the command context through a plain
module variable — nothing for Solid to track — so it evaluated once at mount, saw nothing focused,
and never ran again. The active context snapshot is a signal now, and the tree withdraws it when
neither editing nor a selection stands, so the toolbar shows while typing and hides after.
`phone.spec.ts` on the iPhone 13 descriptor (WebKit, coarse pointer, iOS UA), both toolbar tests.

---

### B-71 · Choosing a context-menu item or clicking an autocomplete row drops editor focus
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, e2e suite · **Tests:**
`e2e/tests/context-menu.spec.ts` "an item chosen from the menu leaves the editor focused and
typeable", `e2e/tests/popups.spec.ts` "clicking a row leaves the editor focused"

The command runs (Indent indents, the page link is inserted), but the item is focusable — a
`<button>`, or a `tabIndex={-1}` row — so mousedown moves focus to it; the overlay then closes and
focus lands on `<body>`. Typing afterwards goes nowhere until the block is clicked again. The mobile
toolbar already does this right (`preventDefault` on `pointerdown`, spec R61).

**Fixed 2026-09-12.** Rows in the `[[`/`#`/`((`/`/` popups and the context menu's items now
`preventDefault` on mousedown, so a click runs the item without ever moving focus off the editor.
`popups.spec.ts` "clicking a row leaves the editor focused", `context-menu.spec.ts` "…leaves the
editor focused".

---

### B-72 · While a block is in edit mode, Escape ends editing instead of closing what is on top
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, e2e suite · **Tests:**
`e2e/tests/context-menu.spec.ts` "Escape leaves focus and the caret exactly where right-click put
them", `e2e/tests/views.spec.ts` "Escape closes the help menu while a block is being edited…",
"opening the palette while editing and closing it hands focus back to the editor"

Context menu: Escape closes it AND runs `block.selectBlock` — the menu's document listener does
not stop propagation, and the global dispatcher's context still reports `editorFocused`. Help
menu, shortcuts dialog and command palette: their Escape never arrives at all — the global
capture handler runs first, matches `block.selectBlock`, and stops propagation — so the overlay
stays open while the block behind it drops to selection mode.

**Fixed 2026-09-12.** The context menu, the help menu and the command palette now claim Escape
through the same `commands/popup-keys.ts` registry the autocomplete popups use (B-65), so both
dispatchers know something is open and yield the key to it instead of running `block.selectBlock`
underneath. `context-menu.spec.ts` Escape, `views.spec.ts` help Escape and palette focus.

---

### B-73 · Right-clicking a selected block drops the selection
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, e2e suite · **Tests:**
`e2e/tests/selection.spec.ts` "right-clicking a selected block keeps the selection",
`e2e/tests/context-menu.spec.ts` "Delete appears for a selected block and deletes it"

`onContextMenu` calls `attachEditing`, which clears the selection, so the menu's Delete entry —
gated on `blockSelected` — can never appear. This is the "things keep selected when there are
context menu shenanigans" the suite was asked for.

**Fixed 2026-09-12.** A right-click on a block that is part of a standing selection no longer
enters edit mode (which discarded the selection); the menu opens against the selection, so Delete,
indent and move apply to all of it. The tree also publishes its command context while a selection
stands, not only while editing — a selection made by Cmd/Ctrl+click on a never-edited tree had no
context at all. `selection.spec.ts` "right-clicking a selected block keeps the selection".

---

### B-74 · Clicking away leaves the block in edit mode
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, e2e suite · **Test:**
`e2e/tests/popups.spec.ts` "clicking elsewhere dismisses the popup"

Nothing clears `editingId` on blur, so the row keeps the CM6 surface after a click elsewhere: a
`[[link]]` you just typed cannot be followed (clicking it re-focuses the editor), an open `[[`
popup stays open, and the bullet stays accent. The rendered view only comes back when another
block is clicked. `e2e/helpers/editor.ts`'s `clickAway` documents what tests have to do about it.

**Fixed 2026-09-12.** A `pointerdown` outside the outliner ends editing (flush, detach), except
for clicks that belong to the session — a popup, the context menu, the palette, the mobile toolbar,
the help layers, the shelf, the zoom breadcrumb, or a click that is closing the context menu.
`CommandLayer` also re-detects triggers after a pointer, deferred a macrotask so a click on a
popup row still lands on the row it aimed at; before, the `[[` popup outlived the editor it
belonged to. `popups.spec.ts` "clicking elsewhere dismisses the popup". Note for tests: a click
away now UNMOUNTS the editor, and `not.toBeFocused()` on a missing element fails — the shared
`clickAway` helper polls `activeElement` instead.

---

### B-75 · A page created from the UI is empty with nowhere to type
**Status:** fixed · **Severity:** high · **Found:** 2026-09-12, e2e suite · **Test:**
`e2e/tests/pages.spec.ts` "a page created from the missing-page view can be typed into straight
away"

The missing-page view's Create and the palette's Create make the page, then `BlockTree` renders
zero rows and there is no placeholder row like the virtual journal day's — no `.vr-block-view`,
no `.vr-draft-input`, nothing to click. The only way to give such a page a first block is the API.

**Fixed 2026-09-12.** Create now makes the page's first empty block along with the page and
requests focus into it, the way a journal day's first block is made. `pages.spec.ts` "…can be
typed into straight away".

---

### B-76 · The sidebar's "Pages" list is the first twelve names alphabetically
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, e2e suite · **Test:**
`e2e/tests/pages.spec.ts` "the sidebar's Pages list shows the most recently edited pages first"

`Sidebar.tsx` says "most recently edited pages" and takes the first 12 of `useAllPages()`, whose
query is `ORDER BY name`. With a few hundred pages a page you just made never appears there.

**Fixed 2026-09-12.** `recentPages` was a stub that returned `useAllPages()` untouched — which
is ordered by name. It sorts by `updatedAt`, newest first. `pages.spec.ts` "…most recently edited
pages first".

---

### B-77 · Creating a journal-titled page from the missing-page view makes an ordinary page
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, e2e suite · **Test:**
`e2e/tests/pages.spec.ts` "creating a journal-titled page from the missing-page view makes a
journal, not an ordinary page"

Open `/page/2027-10-17` (a day with no page), press Create: `PageView.createThisPage` sends
`page.create` with `journalDay: null`, so the graph gets an ordinary page named like a date —
B-23's hole, reopened through the UI. `page.read` of that date then answers not found while the
page exists under that name.

**Fixed 2026-09-12.** Create parses the URL's name with `parseJournalTitle`; a date makes a
journal day (ISO name, `journalDay` set — ADR 018) instead of an ordinary page that would shadow it.
The server-side guard from B-23 could not help here: the op is minted on the client.
`pages.spec.ts` "…makes a journal, not an ordinary page".

---

### B-78 · Renaming a page from its title makes the view say the page doesn't exist
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, e2e suite · **Test:**
`e2e/tests/pages.spec.ts` "renaming a page from its title keeps you on the page under its new name"

The rename commits (the new name reads back, the old one is gone), but the route still carries
the old name, `usePageByName` resolves it to null, and the page you are on turns into "This page
doesn't exist yet" with a Create button.

**Fixed 2026-09-12.** After `page.rename` the view navigates to the new name (`replace`, so Back
does not lead to a URL that no longer resolves). Routes are name-addressed, so the old URL pointed
at nothing the moment the rename applied. `pages.spec.ts` "renaming a page…".

---

### B-79 · Ticking a task in the Tasks view marks it done but the list never updates
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, e2e suite · **Test:**
`e2e/tests/tasks.spec.ts` "the Tasks view checkbox completes a task and removes it from the open
list"

The click writes `marker = DONE` (the API reads it back), and the row stays in the open list,
unchecked, eight seconds later; a reload removes it. B-05's shape.

**Fixed 2026-09-12.** The worker's change event mapped a `block.prop` op to `block_prop` only —
but reserved keys (marker, priority, scheduled, deadline, repeat, done, collapsed) are routed by the
reducer into the block ROW's own columns, so nothing stamped on `block` ever heard a task was
ticked. A `block.prop` write now invalidates `block` too. `tasks.spec.ts` "…checkbox completes a
task…".

---

### B-80 · A failed search sits on Searching… forever
**Status:** fixed · **Severity:** high · **Found:** 2026-09-12, e2e suite · **Test:**
`e2e/tests/views.spec.ts` "a failed search shows an error with Retry, and Retry recovers"

Abort `/api/v1/search` and the view shows "Searching…" indefinitely: no `.search-error`, no
Retry. B-10 lists search as fixed, but its only e2e test covered the references panel.

**Fixed 2026-09-12.** Reading an errored resource re-throws, and the loading branch's own
`when` read `results()` — so the first failed request threw inside render, the computation died,
and "Searching…" stayed. Every read now goes through a guard that returns `undefined` while the
resource is errored; the error branch and Retry were already there and now actually get to show.
`views.spec.ts` "a failed search shows an error with Retry, and Retry recovers".

---

### B-81 · A second tab of the same graph never renders
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, e2e suite · **Test:**
`e2e/tests/views.spec.ts` "a second tab of the same graph renders the page"

Open a page in a second tab of the same browser context: "Loading…" for 20 s and counting, no
outliner. Presumably the second tab is waiting on the writer election / OPFS pool and has no
follower path.

**Fixed 2026-09-12.** The worker's leader election waited on the writer lock unconditionally
(`opfs-sahpool` allows one connection per file), so a second tab's worker queued behind the first
until it closed — "Loading…" forever. It now asks for the lock with `ifAvailable`; a tab that does
not get it becomes a **follower**: an in-memory replica bootstrapped from the server, fully usable,
its writes reaching the leader through sync. The sync indicator says "synced via another tab" so
nobody wonders which tab keeps the local copy. Taking the lock over live when the leader closes is
not attempted — a reload does it — because it would mean swapping storage under an open session.
`views.spec.ts` "a second tab of the same graph renders the page".

---

### B-82 · Picking a page in the command palette never opens it
**Status:** fixed · **Severity:** high · **Found:** 2026-09-12, e2e suite · **Tests:**
`e2e/tests/views.spec.ts` "Enter on a highlighted page in the palette opens it",
`e2e/tests/pages.spec.ts` "Cmd/Ctrl+O switches pages by name with a click"

Cmd/Ctrl+K or Cmd/Ctrl+O, type a page name until it is highlighted, press Enter or click the
row: the palette closes and the URL does not change, with nothing in the console. `CommandLayer`
wires `onSelectPage` to `navigation.openPage(p.id)`, whose `pageNameForId` is
`resolveBlockPageName` — a lookup by BLOCK id, handed a page id, so it resolves to nothing and
`openPage` silently does not navigate. (One earlier probe run saw a click navigate; two later runs
and every Enter did not — treat the click path as broken too.) The palette's "Create page" row
takes a different path and works.

**Fixed 2026-09-12.** `nav.openPage(id)` resolved the page's name with `resolveBlockPageName`,
which takes a BLOCK id and so found nothing. `store.ts#resolvePageName` looks a page up by its own
id. `views.spec.ts` "Enter on a highlighted page…", `pages.spec.ts` "Cmd/Ctrl+O…".

---

### B-83 · A tag page created right after typing the tag never shows the reference
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, e2e suite · **Test:**
`e2e/tests/pages.spec.ts` "a tag page created straight after typing the tag shows the reference
without a reload"

Type ` #NewTag ` in a block, click the rendered tag, press Create on the missing-page view: the
new page shows no linked references, and keeps showing none (15 s) — although
`page.backlinks` on the server lists the block within moments, and the same flow with a pause
before clicking the tag shows it. The panel fetched its backlinks before the typed ref's op had
been pushed, and nothing re-fetches when the push lands, because `useLinkedReferences` is
server-backed and off the local change bus (B-09's shape, one step later).

**Fixed 2026-09-12.** The references panel is a server-computed view stamped on local writes —
but the write it needed the server to see was still in the push queue when it fetched, and no
later local change re-stamped it. The store now bumps a `syncVersion` when the push queue drains,
and the panel refetches on it. `pages.spec.ts` "a tag page created straight after typing the tag
shows the reference without a reload".

---

### B-84 · `block.copySelection` has no implementation
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, e2e suite · **Test:**
`e2e/tests/selection.spec.ts` "Cmd/Ctrl+C copies the selection as markdown"

Select a block, press Cmd/Ctrl+C: the clipboard is unchanged. The command is registered (it shows
in the shortcuts dialog as Cmd+C) and spec R31 says the trigger is the outliner's native `copy`
event, but `BlockTree` installs no `copy` handler and `keydown.ts` does not know the command.

**Fixed 2026-09-12.** `block.copySelection` is implemented: the selection as outline markdown,
subtrees included, through the same `serializeOutline` the mirror uses (ids omitted), so what you
paste elsewhere is what a page file would say. A block whose ancestor is also selected is copied
once, inside that ancestor. `selection.spec.ts` "Cmd/Ctrl+C copies the selection as markdown".

---

### B-87 · A command registered under an unknown id area blanks the whole app
**Status:** fixed (the ids; the failure mode stays) · **Severity:** high · **Found:** 2026-09-12,
`e2e/tests/refactor.spec.ts` on first run · **Tests:**
`apps/web/src/commands/registrations/refactor.test.ts` "every refactor command registers in the
real registry", and every e2e spec (the app did not boot)

Commit `c916c29` registered `page.mergeInto` and `search`-less `graph.findReplace`. The registry
enforces R2's closed set of core areas and throws `CommandRegistrationError` at
`createCoreCommands` time — inside the first render, so the page stayed a white `<div id="app">`
with the error only in the console. Unit tests passed (they build commands, they never register
them); typecheck passed (an id is a string). Fixed by naming them `edit.mergePage` and
`search.findReplace`, and by a test that registers every refactor command in a real registry.

Still open in spirit: one bad command id, from core or a plugin, is a blank screen with no
message. `CommandLayer` could catch registration errors and render the shell without that
command; not done here (shell/commands provider are not this task's files).

---

### B-92 · Slash menu shows 16 items; `popups.spec.ts` pins 15
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, full e2e run (views agent, M7) ·
**Test:** `e2e/tests/popups.spec.ts` "opens at a run start with every item in R54 order" and
"opens as the first character of an empty block"

Type `/` in a block: the popup lists sixteen items — the M7 `Template` entry (78970b1,
`apps/web/src/commands/slash/items.ts`) is there — but `SLASH_ORDER` in `popups.spec.ts` still
lists the fifteen from R54, so the two count/order assertions fail on every full run. Either the
spec's list needs the new item in its R54 position or the keymap spec's R54 needs the item added;
whichever way, the two should agree. Seen with the suite run from a worktree at `f1675df` +
`81546e1`; not caused by, and not fixable from, the references/appearance/shelf work.

**Fixed 2026-09-12** (templates agent): `SLASH_ORDER` now lists `Template` and `Query` after
`Property`, matching `items.ts`; the two tests above pass again and pin the seventeen-item
order. The spec's R54 table still lists fifteen — the coordinator owns that file.

---

### B-110 · `nooklet import <missing dir>` reports success with zero pages
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, wiki workstream — `pnpm nooklet import
docs/wiki` from the repo root (`pnpm nooklet` runs with cwd `packages/server`, so the relative path
pointed at nothing) printed `pagesImported: 0`, no warning, no error · **Test:**
`packages/server/src/importer/logseq.test.ts` "refuses a graph directory that does not exist"

`listMdFiles` answers `[]` for a missing directory on purpose — a graph may have no `journals/` —
so a missing *graph* looked like an empty one. `importLogseqGraph` now throws before touching the
database when the path is absent or not a directory, and the CLI exits non-zero with the message.

---

### B-51 · Uploaded images were broken pictures on every route below the root
**Status:** fixed · **Severity:** high · **Found:** 2026-09-12, by the first test that ever rendered
one · **Test:** `e2e/tests/assets.spec.ts`

`asset.upload` hands back `![alt](assets/<id>.png)` — a relative path — and the renderer put it
into `<img src>` untouched. At `/journals` that resolves to `/assets/<id>.png` and works. At
`/page/Some Page`, where most images are actually looked at, it resolved to
`/page/assets/<id>.png`, the SPA fallback answered with `index.html`, and the picture was broken.
`naturalWidth` was 0; nothing in the console said so.

The stored form stays relative on purpose — it is what the mirror writes and what a Logseq graph
already uses. `editor/render/asset-url.ts` now resolves `assets/…`, `./assets/…` and
`../assets/…` to the server's `/assets/:id` route at render time, for images and for links (a
PDF is a link). No e2e test had ever rendered an asset; found on the way to importing the Logseq
graph's `assets/`, which would have produced 153 broken pictures the moment it worked.

### B-63 · A plugin's mounted sub-app and its RPC routes were unauthenticated
**Status:** fixed · **Severity:** low (security) · **Found:** 2026-09-12, code review · **Test:**
`packages/server/src/plugins/host.test.ts` "guards a mounted sub-app and rpc.expose"

`registerRoute(method, path, handler)` defaulted to `auth: "required"`, but the other two shapes
did not: `registerRoute(app)` forwarded every request under `/api/plugins/<id>/` to the sub-app
with no check at all, and `rpc.expose` mounted an unauthenticated POST on the reasoning that only
the plugin's own client half calls it "over localhost". With `--host` set, both are reachable by
anyone on the network — and the client half holds the app's token, so nothing was gained.

Both now require a valid bearer token (scope is the plugin's own business; `RouteInfo.origin`
carries the token id); `registerRoute(app, { auth: "none" })` opts a sub-app out explicitly, as
the handler form already could. `@nooklet/plugin-api` documents the rule.

### B-61 · An uploaded `.html` asset ran in the app's origin; a bad `mime_type` made every fetch a 500
**Status:** fixed · **Severity:** low (security) · **Found:** 2026-09-12, code review · **Tests:**
`packages/server/src/ops/asset-upload.http.test.ts` "serves hostile content as an inert document",
"rejects a mime_type that is not a well-formed media type"

`GET /assets/:id` echoed the uploader's `mime_type` as `Content-Type` with no
`X-Content-Type-Options` and no CSP. Upload `text/html` (or an SVG with a `<script>`), open it in a
tab, and it executes on the app's origin — with `localStorage`, the device token included, in
reach. On loopback that token is handed out freely anyway; behind a tailnet it is the credential.
Separately, a `mime_type` containing a newline was stored as given, and `new Response` threw on
every later fetch of that asset: a permanent 500 for one bad upload.

Responses now carry `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`
(any document built from the response runs in an opaque origin with no script — `<img>`,
`<video>` and `<audio>` subresources are unaffected), `mime_type` must be a `type/subtype` in RFC
6838's token characters, and the file is streamed instead of `readFileSync`-ing up to 25 MB on
the event loop per request.

### B-62 · `page_list({tag: "art"})` returned pages tagged `party`
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, code review · **Test:**
`packages/server/src/ops/ops.http.test.ts` "filters by tag through the page_tag index"

The filter was `tags:: LIKE '%art%'` on the raw property text: a substring match, so `art` found
`party` and `smart`, and whether `#art` or `[[Art]]` matched depended on how the property had been
typed. ADR 017's `page_tag` table exists for exactly this and is keyed the way every other
reference is; `page.list` now uses it, and `art`, `Art`, `#art` and `[[Art]]` are one tag.

### B-60 · Any `/ui/live` socket could answer any window's request; a closed window kept callers waiting
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, code review · **Tests:**
`packages/server/src/live/rpc.test.ts` "only the socket a request was sent to can answer it",
"closing the window fails its in-flight requests at once"

A `state.result`/`command.result` frame resolved whichever pending request carried its
`request_id`, regardless of which socket sent it — including a socket that had never completed
`hello`. `request_id`s are random UUIDs, so guessing one is impractical, but an unauthenticated
connection should not be able to answer anything. And `unregisterWindow`'s doc said it failed the
window's in-flight requests immediately; it did not, so a tool call to a window that had just
closed waited out the full 2 s timeout.

A pending request now remembers the socket it went to and only that socket can settle it; closing
the socket settles its requests as "did not answer" at once.

### B-59 · The stdio bridge dropped `ui:control`, so Claude Desktop never saw the `ui_*` tools
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, code review · **Test:**
`packages/server/src/mcp/stdio.test.ts`

`nooklet mcp --stdio` resolved its one fixed token with `scopesFor(verified.scope)` — the
read/write/admin tier alone — where the HTTP and MCP mounts use `allScopesFor(verified)`, which
adds `ui:control` for a token minted with `--ui-control`. `tokens.ts` says in so many words that
every caller building an `OpContext` must use `allScopesFor`; this one was missed. Over stdio the
five `ui_*` tools were never listed, however the token had been created.

### B-58 · `idempotency_key` was accepted, documented, recommended — and ignored
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, code review · **Tests:**
`packages/server/src/ops/ops.http.test.ts` `describe("idempotency_key (B-58)")` — replay,
conflict on a different body, per-token scope, dry runs ignored, failed writes not remembered,
24-hour expiry

Every write op took `idempotency_key`, its description said "repeating a call with the same key
and body returns the original result instead of applying it twice (stored 24h)", and
`page_append`'s description told agents to "pass idempotency_key if you might retry after a
timeout, or you may get duplicate blocks". Nothing read the field. A retried `page_append`
duplicated the blocks — the one outcome the field exists to prevent, on the one call whose
description promised otherwise.

Implemented as mcp-tools.md §3.6 specifies (`ops/idempotency.ts`, table `idempotency`, migration
v6), wrapped around every write in `runOpHandler` so HTTP, MCP and the stdio bridge behave the
same. The request identity is the parsed input with defaults applied and keys sorted; a
`dry_run` is never recorded.

### B-57 · `batch_undo` said "a batch_id returned by any write"; no write returned one
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, code review · **Tests:**
`packages/server/src/ops/batch-undo.http.test.ts` (uses the returned id), `ops.http.test.ts`
"page_create with markdown is one batch" and "a dry run or a no-op write carries no batch_id"

The README promises an agent can "undo any batch it just made". `batch_undo`'s input said its
`batch_id` comes "from a previous write's response" — but `WriteResult` had no such field, so the
only way to undo your own `page_append` was to call `changes_since` and fish the id out of the
first item, which is what the undo tests themselves did.

Every write now returns `batch_id` (absent for a `dry_run` or a no-op, when nothing was written),
and `batch_undo`'s own result uses the same field rather than a one-off `undo_batch_id`.

Fixed alongside: `page_create` with `markdown` was two batches — the page through `DataApi`, the
blocks through a second `applyOps` — so undoing "the batch it just made" emptied the page and left
the page. It is one batch now; undoing it removes the page too.

### B-56 · `changes_since` reported an undone deletion as another deletion
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, code review · **Test:**
`packages/server/src/ops/ops.http.test.ts` "reports an undone delete as a restore"

`batch_undo` of a delete mints `block.delete { deletedAt: null }` — a restore, by ADR 003's
tombstone model. `changes_since`'s classifier only looked at the op *kind*, so the restore came
back as `block.deleted` (and a page as `page.deleted`): an agent catching up on history was told
the thing it had just brought back was gone again. The `block.restored`/`page.restored` kinds in
the output schema had never been produced by anything.

Fixed alongside: three tool descriptions promised a trash "restorable for 30 days" and `block_read`
hinted "ask the user to restore it". There is no trash view and no 30-day window; deletes are
tombstones and the one restore mechanism is `batch_undo` on the write's `batch_id`. The
descriptions and `docs/spec/mcp-tools.md` now say that.

### B-55 · `alias::` never worked, and `keep_alias` wrote an index row no other device would ever see
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, code review; confirmed on the
owner's graph (three pages with `alias::`, `page_alias` empty) · **Tests:**
`packages/server/src/apply-ops.test.ts` "derives page_alias from alias::" and "re-resolves
references by the old name on rename", `ops.http.test.ts` `describe("aliases (B-55)")`,
`db.test.ts` (migration v5 fills the table from an existing property)

Two halves of one omission. Nothing ever populated `page_alias` from a page's `alias::` property —
the spec (sql-schema.md rule 6) says a change to `alias::` MUST refresh it, and the importer
brought the property across, but no code derived the table, so `page_read("garden")` on a page
called `Zahrada` with `alias:: garden` was `not_found`. The one thing that did write the table
was `page.update keep_alias`, with a raw `INSERT` outside `serverApplyOps` — a row that no other
device, no `rebuild()`, and no `nooklet verify` would ever reproduce.

Now `page_alias` is derived on every page write, like `page_tag` (`packages/server/src/
page-aliases.ts`); `keep_alias` appends the old name to the `alias::` property with an ordinary
`page.prop` op and the index follows; a reference to an alias resolves to the page
(`ref.dst_page_id`), and backlinks are computed over the page's own key plus its aliases (rule 13).
Renaming back to a former alias removes that name from the list rather than leaving a page listed
as its own alias. Migration v5 rebuilds the table for existing graphs.

Fixed alongside, because the same re-resolution covers it: a `[[Page]]` written before `Page`
existed stayed unresolved (`dst_page_id NULL`) until the referencing block happened to be edited
again; creating, renaming or deleting a page now re-resolves every reference addressed by any
name it answered to before or answers to now.

Not done here: the web client's `usePageByName` looks up `page.key` only, so opening
`/page/garden` in the app still says the page does not exist even though the API resolves it.
`page_alias` is a server-only table; the client would need to scan `page_prop.alias`.

### B-54 · Every server start left one more live write token behind
**Status:** fixed · **Severity:** medium (security) · **Found:** 2026-09-12, code review; confirmed
on the owner's graph (three live `web-client (auto)` rows) · **Tests:**
`packages/server/src/auth/tokens.test.ts` "createSoleToken revokes every earlier live token",
`packages/server/src/http/host-guard.test.ts` "a restart retires the previous process's auto token"

The served client's credential is minted per process on the first `/api/session` and — the
comment said — "lives only in memory ... so a restart invalidates old sessions". The raw string
did; the row did not. Its hash sat in the `token` table as a live `write` + `can_sync` token, and
nothing ever revoked it, so a graph accumulated one usable credential per `nooklet serve`, each
one invisible to `nooklet token list`'s reader as anything but "active, last used <date>".

A process that has exited cannot retire its own token, so its successor does: `createSoleToken`
revokes every live token with the same label in the transaction that mints the new one. A
long-running server still keeps its single token for its whole life.

### B-53 · Searching for `c++`, `e-mail` or `what's` was an HTTP 500
**Status:** fixed · **Severity:** high · **Found:** 2026-09-12, code review; reproduced with
`tools/probes/fts5-query-syntax.mjs` · **Tests:** `packages/server/src/ops/fts-query.test.ts`
(every probe string against a real FTS5 table), `ops.http.test.ts` "survives punctuation FTS5
would choke on" and "honours -exclusions and quoted phrases"

The raw query string went straight into `block_fts MATCH ?`. FTS5's query language is not a search
box: `c++`, `what's`, `a.b`, `(`, a lone `AND` and an unbalanced `"` are syntax errors, and
`e-mail` / `foo -bar` are read as *column filters* ("no such column: mail"). Each of those came
back as `internal` — to the search view as "Couldn't search", to an agent as a broken tool. An
e-mail address is not an edge case in a notes app.

Worse, the description promised `-exclusions`, and the one thing a `-` could never do in raw FTS5
was exclude. `ops/fts-query.ts` now compiles the documented grammar — words, `"phrases"`,
`-exclusions`, `prefix*` — into string literals only, so nothing typed can reach the query
language. Exclusions with no positive term give no hits rather than an error.

Also fixed alongside: `updated_after: "yesterday"` (anything `Date.parse` rejects) became `NaN`,
which compared false against every row and returned nothing — indistinguishable from "no
matches". It is `invalid` now, with the format in the hint.

### B-43 · Without OPFS the client died silently — no message, nothing rendered
**Status:** fixed · **Severity:** high · **Found:** 2026-09-12, running the B-42 probe in WebKit ·
**Tests:** `e2e/tests/storage.spec.ts` (runs under a new `webkit` Playwright project scoped to
that one file) · **Probe:** `tools/probes/playwright-webkit-opfs.mjs`

The replica is `opfs-sahpool`, which needs OPFS sync access handles inside a worker. Where those
are missing — Playwright's WebKit build, some privacy modes, some embedded webviews — every worker
RPC rejected with `UnknownError: The operation failed for an unknown transient reason (e.g. out of
memory)`, the console filled with unhandled rejections, and the app showed a blank journal
forever. Nothing said why.

`openSqliteWasmDriver` now falls back to an in-memory database, warns once, and reports
`storage: "memory"` through `WorkerApi.init()`; the shell's sync indicator then says **"not saved
locally"** where it would otherwise say "synced" — which would also have been true, and exactly
the wrong thing to tell someone typing into a database that evaporates on reload. With sync
configured the server still has everything, so the cost is a re-bootstrap next load, not data.

The probe settled a fact worth keeping: Playwright's WebKit cannot open OPFS from a worker at all
(`navigator.storage.getDirectory()` itself rejects), so it is not a stand-in for the Mac app's
WKWebView on storage — `wkwebview-opfs.swift` shows the real thing writes 1.2 GB happily.

### B-52 · A date-shaped typo became a page
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, code review · **Test:**
`packages/server/src/ops/ops.http.test.ts`, "rejects a date-shaped ref that is not a real day"

`page_append({page: "2026-13-45"})` passed the wire-date regex, turned into journal day `20261345`,
and — because the reducer refuses to derive a name from an impossible day — created an ordinary
page called `2026-13-45`. No date format ever resolves to it, so it sat there as a shadow journal.
`journalDayFromWire` now returns `null` for an impossible day and `resolvePageRef` answers
`invalid` for anything date-shaped that is not a date.

### B-40 · Five CSS variables were used in eight stylesheets and defined nowhere
**Status:** fixed · **Severity:** high · **Found:** 2026-09-11, during the design pass · **Test:**
the design tokens now live in one file; `e2e/tests/settings.spec.ts` asserts the theme toggle

`--surface-1`, `--surface-2`, `--border`, `--danger` and `--ok` were referenced by the command
palette, the keyboard-shortcuts dialog, the context menu, the diagnostics panel and the mobile
drawers — and declared by nothing. Every one of those fell through to its hardcoded fallback, which
was some flavour of `#fff`.

In dark mode that means the shortcuts dialog and the command palette rendered as **white sheets
carrying near-white text**: not unpolished, unreadable. Before/after in the design pass's
screenshots (`00-before/d-dark-help-keys.png` vs `06-final/`).

This is what an undeclared custom property costs: CSS has no error for it, the fallback silently
wins, and the failure only appears in the theme you were not looking at. `styles/shell.css` is now
the single place a raw colour may appear, and it supplies all five for both themes.

Two smaller ones fixed alongside: `.task-filters label { flex-direction: column }` out-specified
`.task-state-checkbox`, stacking every task-state checkbox above its own word; and priority chips
were white on `#f5a623` at roughly 1.9:1.

### B-41 · The journal stream reserved 40vh of blank space after every day
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-11, during the design pass

`.vr-outliner` carried `padding-bottom: 40vh` — correct for a page view, where it keeps the last
block reachable above the fold. But the journal stream renders one outliner *per day*, so the
padding repeated down the whole stream. It was a good part of why the app read as "a page full of
holes". Moved to `.page-scroll-inner`, where the intent actually lives.

### B-12 · Two CSS naming schemes in the editor
**Status:** fixed · **Severity:** low · **Found:** 2026-09-11 · **Tests:** `a-fresh-journal`,
`connectivity`, `editing`, `remote-device` specs updated to the surviving selectors

`BlockRowView` used `.vr-row` / `.vr-content`; `VirtualJournalDay` used `.block-row` /
`.block-content-input` for the same concepts, so the placeholder row and a live row were two things
kept looking alike by hand.

Resolved by making the virtual journal day emit **real outliner markup** rather than a lookalike:
`.vr-draft` shares one declaration block with `.vr-outliner`, so they cannot drift. Eight dead rules
for markup nothing renders were deleted. `.vr-draft` is deliberately not named `.vr-outliner` —
several specs use that class with `.first()` to mean "a materialised tree", and a virtual day
answering to it would break them silently.

### B-13 · UI was visually unfinished
**Status:** fixed · **Severity:** medium · **Reported:** 2026-09-11 ("looks absolutely barebones…
like first project in life design")

`styles/shell.css` is now a design system: an 8-step type scale, a spacing scale, radii, elevation,
motion with a `prefers-reduced-motion` block, and a full two-theme palette whose contrast was
computed rather than guessed (light `--muted` 5.34:1, `--accent` 6.23:1; dark 6.14:1 and 8.06:1).
One focus recipe, audited by tabbing four routes.

The outliner specifically: bullets now align at a given depth (the collapse arrow was rendered
*in flow*, so a row with children pushed its own bullet ~14px right of a childless sibling — its
lane is now always reserved); indent guides are painted per ancestor; task markers are fixed-width
so text after `☐ ◐ ◔ ☑ ☒` starts at one x; and CodeMirror, which ships only a light theme, no
longer draws a black caret on a black page.

Known and left alone, in the design pass's own words: the top bar has nothing to say in its middle,
collapsed rows shift ~13px right because the child count sits in flow, the tasks filter bar wraps
arbitrarily, and the mobile drawers have no scrim. Each needs markup, not CSS.

### B-39 · `nooklet backup` rewrote the graph it was asked to preserve
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-11, by running it on a real graph

ADR 018's journal-name migration was hooked into `cli.ts`'s shared `open()` on the reasoning that
it is idempotent and cheap, so it may as well be everywhere. Every command goes through `open()` —
including `backup`, `verify`, `gc` and `export`, which are the commands you reach for when you
want to inspect or preserve a graph, not change it.

Two consequences, both bad. Taking a backup *before* a migration produced a backup taken *after*
it, which is the opposite of the thing being asked for. And `verify` — a diagnostic whose entire
job is to report on a database's state — would have reported on a database it had just modified.

`open()` now takes `{ migrate: true }`, passed only by `serve`, `import` and `mcp`.

**Lesson:** "idempotent and cheap" is an argument about cost, not about permission. A command that
does not say it writes must not write.

### B-32 · `graph.spec.ts` wrote into today's journal
**Status:** fixed · **Severity:** low · **Found:** 2026-09-11

The graph spec appended to **today's** journal, which is exactly the shared state
`a-fresh-journal.spec.ts` needs untouched — that spec is named to sort first for this reason, and
only worked because it happened to run earlier. Reordering or sharding the suite would have broken
the journal test with a failure that read as an editor bug rather than a fixture collision.

It now writes to a dated day in the past, with a comment saying why.

### B-37 · The Settings command navigated to a route that does not exist
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-11 by a subagent building the panel

`app.openSettings` called `navigate("/settings")`. There is no such route, so the command — bound
to a key and listed in the palette — landed on a blank page. It now raises the settings panel.

Test: `e2e/tests/settings.spec.ts`.

### B-38 · Embeddings could not be configured without dropping to the CLI
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-11 by a subagent

Semantic search needed `nooklet embed model …` from a terminal: there was no HTTP op to see
whether a provider was reachable, pick a model, or start a backfill, and nothing in the UI to do it
with. Someone who installed the app and wanted the feature it advertises had no path to it.

Now `embeddings.status` / `configure` / `reindex` exist (HTTP-only, deliberately not MCP tools:
they are operator decisions with real cost), the provider is probed *before* anything is persisted
so a bad host is never stored, and the indexer activates a model once its backfill drains — which
is the part a request handler cannot do synchronously and the reason an HTTP-configured model
would otherwise sit inactive forever.

Tests: `packages/server/src/ops/ops.http.test.ts` (against a stub Ollama, so results do not depend
on the machine), `e2e/tests/settings.spec.ts`. Also verified end to end against a real Ollama with
`bge-m3`: an English query returned a Czech note as its top hit.

### B-21 · Journal pages were stored under a display format
**Status:** fixed · **Severity:** medium · **Raised:** 2026-09-11 (user: "stored name should IMHO
be ISO. and then we should have in settings selectable format of that") · ADR 018

A journal page was *stored* under whatever title format the graph was written with —
`Mon, 07.09.2026` in the imported Logseq graph — while search results, block references and the
API all handed out the ISO date. The format a date is displayed in had become part of its
identity, and that one mistake produced B-22, B-23, and a quieter third: `ref.dst_page_key` is the
reference text, so `[[Mon, 07.09.2026]]`, `[[Sep 7th, 2026]]` and `[[2026-09-07]]` were three
different keys and a journal's backlinks were whichever subset happened to match its stored name.

Now: a page with a journal day is stored as `2026-09-07` (derived in `@nooklet/core`'s reducer, so
client, server and replay all agree); every recognised date format canonicalises to one reference
key; and the displayed title is a per-device setting (Settings → Appearance → Journal date format).

Existing graphs are migrated by `packages/server/src/journal-names.ts`, which mints real
`page.rename` ops — a raw UPDATE would desync live state from the op log and no other device would
ever hear about it. Run against the real 952-page graph: 825 pages renamed, `nooklet verify` clean,
and unresolved references *dropped* (path_ref 7403 → 5889, ref 1444 → 1357) because dates written
in a different format now resolve.

Tests: `packages/core/src/journal.test.ts`, `packages/core/src/sync/apply-ops.test.ts`,
`packages/server/src/journal-names.test.ts`, `e2e/tests/journals.spec.ts`.

### B-23 · `page.create` accepted a journal-formatted name and made a non-journal page
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-11, while writing journal e2e tests ·
commit `dab7dc7`

`page.create` deliberately refuses journal days — but its guard used `journalDayFromWire`, which
only understands ISO and `today`/`yesterday`, not the title formats `parseJournalTitle` accepts. So
`page.create({name: "Tue, 08.09.2026"})` succeeded and produced a page with `journal_day = NULL`:
named like a journal day, looking like one, and invisible to the journal stream forever.

The guard now uses `parseJournalTitle` — the parser the rest of the system resolves references
with — and the error names the ISO date to use with `page_append` instead.

Test: `packages/server/src/ops/ops.http.test.ts`, `describe("page.create journal guard")`.

### B-35 · `page.append` could not create an ordinary page, and shadowed journals
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-11, by an e2e test that tried to use it

Two faults in one function. `page_append`'s `create_page` flag defaults to true and is documented
as creating the page — but `resolvePageRef` only ever honoured it on the journal branch, so
appending to a page that did not exist yet failed with *"does not exist and create_page is false"*
having been passed exactly the opposite. An agent reading that message would conclude the flag was
the problem and never find the real one.

And the fallthrough was B-23's hole through a different door: `page_append({page: "Sep 8th, 2026"})`
would have created an ordinary page shadowing that journal day.

`resolvePageRef` now resolves in a documented order — wire date, id, existing name, *then* any
other journal title format, and only then creates an ordinary page. The name-before-date step is
what keeps an imported page genuinely called `11.12.2024` reachable by its name.

Test: `packages/server/src/ops/ops.http.test.ts`, `describe("page.append page resolution")`.

### B-36 · Moving the e2e port left the browser pointing at the old one
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-11, immediately after B-34's guard fired

B-34 taught the suite to refuse a port that is already serving nooklet, and to say
`NOOKLET_E2E_PORT`. Doing what it said moved the *server* but not the *browser*: `baseURL` came
from a separate `NOOKLET_E2E_URL` and stayed at 6188 — the very server the guard had just objected
to. The suite then tested a concurrent agent's build and reported a failure in code that was
correct, which is the exact outcome B-34 existed to prevent.

`baseURL` is now derived from `NOOKLET_E2E_PORT`. One knob.

**Lesson:** a guard that tells you which knob to turn has to be sure that knob turns everything.

### B-33 · `.gitignore` silently excluded seven source files from the repository
**Status:** fixed · **Severity:** critical · **Found:** 2026-09-11 by a subagent

`.gitignore` line 12 was a bare `data/`, which matches **any** directory named `data` at any
depth — so `apps/web/src/data/` was never committed. The published repository was missing
`store.ts`, `api-client.ts`, `bootstrap.ts`, `types.ts`, `tree.ts`, `block-ref-cache.ts` and
`tree.test.ts`, and could not build.

Nothing local would ever have caught it: the files exist on disk, `git status` is clean, every
test passes. It surfaced only because a subagent noticed its own edits to `store.ts` were
invisible to `git status` and said so rather than assuming it had misread.

Now `/data/`, anchored to the root, which is what it always meant. Verified by cloning the repo
into a temp directory and running `typecheck` + `build` there — the check that would have caught
this at any point.

**Lesson:** a repo that builds locally proves nothing about what was committed. Clone it.

### B-34 · The e2e suite could silently run against someone else's server
**Status:** fixed · **Found:** 2026-09-11, chasing a test that failed only in the full suite

`global-setup.ts` spawned a server on a fixed port and then waited for `/healthz`. When something
was already listening — a concurrent agent's Playwright run — the spawn failed to bind but the
health check succeeded against the OTHER process, so the whole suite ran against a foreign server
carrying foreign data.

It presented as a real product bug: one spec failed on state it never created, and kept failing
when run in isolation. Several rounds went into looking for a regression in the editor that did
not exist.

The setup now refuses to start when the port is already serving nooklet, and says what to do
(`NOOKLET_E2E_PORT`). Logged alongside B-32, which was the same class of problem one level up —
tests sharing state they did not declare.

### B-30 · A client silently held a copy of a different graph
**Status:** fixed · **Found:** 2026-09-11, chasing "search finds nothing but the sidebar is full"

The sidebar listed a thousand pages while search returned zero results. Both were telling the
truth about different graphs: the client's replica lives in OPFS keyed by **origin**, so pointing
`127.0.0.1:6100` at another data directory leaves the browser reusing the copy it already had.
The page list reads the local replica; search and backlinks read the server. Every individual
part worked.

Each database now mints a stable identity (`packages/server/src/graph-identity.ts`), exposed via
`GET /api/session`. The client remembers which graph its replica belongs to and, on a change,
stops and explains instead of rendering two disagreeing halves (`views/GraphMismatchView.tsx`).

**It asks rather than wiping.** The local replica can hold edits that were never pushed, and
destroying those silently to fix a configuration mistake would be the worst possible trade.

Two contributing causes worth recording: the README's quick start said `--data ~/.nooklet` while
the CLI defaults to `~/.nooklet/default`, so following it produced a second graph; and the desktop
app used the platform app-data directory, so it opened a third. Both now use one default.

### B-31 · A wall-clock assertion in the unit suite
**Status:** fixed · **Found:** 2026-09-11 by a subagent, which correctly refused to blame its own change

`packages/core/src/tokens.test.ts` asserted `tokenizeContent` over 20,000 blocks finished in under
50 ms. It measured 60-71 ms when run alongside the rest of the suite and passed every time in
isolation — the test was measuring the machine's load, not the code.

A test that fails when the laptop is busy teaches nobody anything and trains people to re-run
until green. The budget is now 500 ms: an order of magnitude above the real ~30 ms, which still
catches the regression actually worth catching (an accidental quadratic turning this into
seconds) and never fires on load.

### B-29 · A self-executing module hijacked the CLI once bundled
**Status:** fixed · **Found:** 2026-09-11, building the desktop app's bundled server

The desktop app's server died on `unable to open database file` for a directory that plainly
existed. The path it tried to open was the data **directory**, not `graph.sqlite` inside it.

`mcp/stdio.ts` ended with a standalone entry point:

```js
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
```

Bundled by esbuild into a single file alongside `cli.ts`, that guard compares *the bundle's* path
— so it is true for whichever entry point is actually running, and the stdio bridge's `main()`
ran instead of the CLI's. The two read `--data` differently on purpose: the CLI takes a data
directory, the bridge takes the database file. Hence the error.

`main()` and its `parseArgs` now live in `mcp/stdio-main.ts`; `mcp/stdio.ts` is a pure library.

**The red herring worth remembering:** a byte-identical copy of the bundle ran fine from `/tmp`
and failed from the repo. That is not filesystem magic — `/tmp` is a symlink to `/private/tmp`,
so `import.meta.url` (symlinks resolved) and `process.argv[1]` (as given) did not match, and the
guard stayed false. Chasing "the location matters" nearly sent this in the wrong direction; what
settled it was printing the path that was actually being opened.

**Rule:** a module that can be imported must not self-execute. Bundling makes every entry point
look like *the* entry point.

### B-28 · The entire command layer was wired to a no-op editor
**Status:** fixed · **Test:** `e2e/tests/parity.spec.ts` (6 tests)
**Found:** 2026-09-11, by finally exercising B-17/B-18 in a browser

The slash menu, `[[`/`#`/`((` autocomplete and every formatting shortcut did nothing. All were
implemented and unit-tested against a fake host; none had ever run in a browser. Three bugs,
stacked:

1. **`CommandLayer` captured the host once.** `const editor = activeEditorHost()` evaluates at
   setup, when no `BlockTree` has focus — so it captured the inert no-op host and kept it forever.
   `activeEditorHost()` returns a *snapshot*; anything built once at startup needs the new
   `liveEditorHost`, which forwards each call to whoever is active now.
2. **The host was never registered anyway.** `BlockTree`'s registration effect was
   `createEffect(() => { if (surface.currentId() !== null) … })` — and `surface.currentId()` reads
   a plain closure variable inside `surface.ts`, not a signal. The effect ran once, at mount, with
   nothing focused, and never re-ran. Now keyed on `editingId()`, which is a real signal.
   Measured before the fix: `getSelection()` returned `null` on every keystroke, so no trigger
   could ever match.
3. **Commands wrote to the model but not the editor.** With the above fixed, `Cmd+B` resolved and
   *ran* (`handled: true`) yet the text never changed: `EditorHost.setText` called `onTextChange`,
   updating `localBlocks` while CodeMirror kept the old buffer — and the next refetch, which
   prefers the live buffer for the block being edited, then discarded the change entirely. It now
   dispatches a real CodeMirror transaction and lets the surface's update listener do the rest.

**Lesson:** a unit test against a fake host proves the command's logic and nothing about whether
the host is connected. Every one of these had passing unit tests.

### B-25 · Any LAN caller could mint a write token by forging `Host: localhost`
**Status:** fixed · **Severity:** critical · **Test:** `packages/server/src/http/host-guard.test.ts`
**Found:** 2026-09-11 by the multi-user/pairing research agent, reproduced before fixing

`buildClientBootstrap` decided "is this loopback?" from the `Host` header, which the caller
controls. Verified against a running server bound to `0.0.0.0`:

```
curl -H 'Host: localhost:6198' http://192.168.1.6:6198/api/session
→ {"token":"nk_<redacted>"}
```

That is a `write` + `can_sync` token handed to anyone who can reach the port. Introduced in this
session along with the bootstrap endpoint.

Now decided from the socket's peer address (`getConnInfo`), with the `Host` check RETAINED as a
second condition rather than replaced — a DNS-rebinding attack arrives from a genuine loopback
peer (the victim's own browser) carrying the attacker's hostname, so both must hold. An
in-process request with no socket is treated as non-loopback: never hand out a credential to a
caller you cannot identify.

### B-26 · The DNS-rebinding guard covered 2 routes out of 7
**Status:** fixed · **Test:** `packages/server/src/http/host-guard.test.ts`, "guards EVERY route"
**Found:** 2026-09-11, same research pass

`@modelcontextprotocol/hono` ships a Host guard, but `createApp` merges that sub-app *after*
`/api/v1/*`, `/sync/*`, `/api/session` and `/assets/*` are registered — and Hono composes handlers
in registration order, so a terminal handler registered earlier short-circuits before the merged
middleware runs. The guard only ever covered paths with no earlier route. Meanwhile `cli.ts`
printed that requests with an unexpected `Host` "are refused". They were not.

nooklet now installs its own allowlist middleware *before* every route, active only when bound to
a non-loopback address. Verified per-route: with `--host 0.0.0.0` and no `--allow-host`, all of
`/healthz`, `/openapi.json`, `/api/session` and `/` return 403 to a LAN Host and 200 to loopback;
adding `--allow-host` opens exactly that hostname. The CLI message now says what actually happens.

**Testing note:** these cannot be tested through `app.request()` — both behaviours depend on the
connection itself. And `fetch` silently drops a `Host` header (it is a forbidden header name), so
the tests use raw `node:http`; written with `fetch` they would have asserted nothing while passing.

### B-27 · A plain LAN IP cannot run the client at all
**Status:** documented · **Severity:** high · **Found:** 2026-09-11, same research pass

`http://192.168.1.5:6100` — the URL the README previously recommended for phone access — is not a
*secure context*. The client stores its replica via OPFS (`installOpfsSAHPoolVfs`) and elects a
writer with `navigator.locks`; both are secure-context-gated and neither has a fallback, so the
client cannot open its database there at all. README now recommends HTTPS or a tailnet and
explains why.

Not a code fix: the real remedy is a documented deployment shape. Revisit if a plain-LAN fallback
is ever wanted, which would mean a non-OPFS storage path.

### B-22 · Clicking a search result said "This page doesn't exist yet"
**Status:** fixed · **Test:** `e2e/tests/journals.spec.ts` (3 tests)
**Reported:** 2026-09-11

Three separate defects on one path.

1. **Journal pages were only addressable by their stored name.** The graph stores
   `Mon, 07.09.2026`; search results and references hand out `2026-09-11`. `usePageByName` looked
   up by name only, so a journal that plainly existed reported "doesn't exist yet". It now falls
   back to `parseJournalTitle` → `journal_day`, which is format-agnostic. See B-21 for the
   underlying design fix.
2. **Zooming into a block threw and left the view permanently blank.** `flattenVisible` called
   `getBlock`, which throws on an unknown id — and on the first render the tree is empty because
   the page resource has not resolved, so a `?block=` URL took down the whole subtree behind a
   "Loading…" that never cleared. A missing zoom root now yields no rows instead of throwing.
3. **"Loading…" never cleared even once data arrived.** `createResource` sets `loading = true` on
   every REFETCH, and after the version-stamping fix (B-05) every resource refetches whenever its
   tables change — so a spinner keyed on `loading` alone reappeared on every sync pull. Views now
   show a spinner only while there is nothing to display (`loading && value === undefined`).
   Fixed in `PageView`, `TasksView`, `ReferencesPanel` and `SearchView`.

### B-24 · Future journal days were invisible
**Status:** fixed · **Test:** `e2e/tests/journals.spec.ts`, "a future journal day appears in the stream"
**Reported:** 2026-09-11 ("shows just today page even though /page/Sep 12th, 2026 exists")

The stream query was `journal_day < today`, so a day ahead of today never appeared. Empty past
days are hidden deliberately; a *future* day exists only because something was written or
scheduled there, so hiding it turned into "days you created are not shown". Future days now render
above today (keeping the stream newest-first) and are not counted against the `maxDays` window,
which exists to bound scrolling back through years of history.

### B-20 · The app never updated — a browser stayed pinned to the first build it cached
**Status:** fixed · **Reported:** 2026-09-11 as search still hanging and "agents can't see this
window" persisting after both had been fixed and verified

`vite.config.ts` used `registerType: "prompt"`, which only applies an update when something calls
the update function — and `sw/register.ts`'s `onNeedRefresh` did nothing but `console.info`. So a
browser kept serving the first build it had ever precached, forever. Every fix shipped after that
first visit was invisible, and the symptoms looked like unfixed bugs.

Proven by driving a *fresh* browser (no service worker) at the same server and the user's real
graph: `/api/session` 200, `/api/v1/search` 200, 48 results, zero console errors, live UI
connected. The code was correct; the cache was not.

Now `registerType: "autoUpdate"`, `onNeedRefresh` actually applies the update, and a long-lived
tab re-checks hourly (a service worker otherwise only looks for a new version on navigation).
Safe for unsaved text because a pending edit already flushes on `pagehide`/`visibilitychange`
(B-04).

**To unstick a browser that is still on an old build:** hard-reload twice, or DevTools →
Application → Service Workers → Unregister, then reload.

**Lesson:** when a verified fix "doesn't work" for the user but passes in CI, suspect the
delivery path before the code. `pnpm e2e` rebuilds and uses a fresh browser context every run, so
it could never have caught this.

### B-19 · The service worker served a shell with no token, so reloads lost credentials
**Status:** fixed · **Test:** `e2e/tests/remote-device.spec.ts`, plus every reload-based editing test
**Found:** 2026-09-11, while adding the connect screen

The web-client token was injected into `index.html`. The PWA service worker precaches that file
**at build time**, so from the second page load onward the browser was handed a shell containing
no `window.__NOOKLET__` at all — the app silently lost its credentials on every reload, on
loopback, where everything was supposed to just work. It had been happening since the token
injection landed; it only became visible once a missing token started rendering a connect screen
instead of failing quietly.

A shell is static and cacheable; a credential is neither. The token now comes from
`GET /api/session` at startup (`data/bootstrap.ts#initBootstrap`), which the service worker's
runtime caching already treats as `NetworkOnly`.

**Lesson worth keeping:** two of the reload-based editing tests started failing the moment the
connect screen existed. They were not regressions — they were the first time this bug had anything
to fail against.

### B-15 · Keystrokes lost right after clicking a block or pressing Enter
**Status:** fixed · **Test:** `e2e/tests/editing.spec.ts`, "typing immediately after Enter"
**Reported:** 2026-09-11 as "I type, press enter, the new text disappears", "can't click on a new
bullet point to put cursor in there", and "tab + shift tab doesn't work"

All three were one defect. Solid runs a `ref` callback when the element is *created*, not when it
is inserted into the document, so `surface.attach`'s `view.focus()` ran against a still-detached
host and did nothing. Focus sat on `<body>` until a `requestAnimationFrame` backstop restored it a
frame later, and everything typed in that window went to `<body>` and was discarded. Measured:
immediately after Enter, `document.activeElement` was `BODY` and the focus trace read
`out->BODY`, `in:cm-content`.

It read as "Tab doesn't work" for the same reason — with focus on `<body>`, CodeMirror's keymap
never saw the key, so *no* structural key worked, including Backspace.

Fixed by re-asserting focus in a `queueMicrotask` (runs after Solid inserts the element but before
the browser dispatches the next input event), keeping the rAF as a backstop for the separate case
where the browser resets focus after removing the previously focused element.

### B-16 · An edit typed into a just-created block was discarded
**Status:** fixed · **Test:** `e2e/tests/editing.spec.ts`, "typing immediately after Enter"

`flushPendingEdit` looked the block up in `treeBefore` — the tree as of the edit's first keystroke
— and returned early when absent (`if (!before || before.content === content) return`). A block
created moments earlier (Enter for a new sibling, pasting a subtree) is not in that snapshot, so
the text op was never built and the typing was lost with no error. Absent from the snapshot is not
"unchanged": it now falls back to the live tree and only skips when content genuinely has not
moved.

---

The six below were reported within minutes of first opening a served production build, and all six
had passed the 1,180-test unit suite. That is what `e2e/` now exists to prevent — see its
`playwright.config.ts` header.

### B-01 · Served client had no API credentials
**Status:** fixed · `d6163df` · **Test:** `e2e/tests/connectivity.spec.ts`

Search 401'd, linked references hung, `/ui/live` reported "agents can't see this window", and the
sync indicator flapped offline→syncing→offline every few seconds. One cause: the token came from
`VITE_NOOKLET_TOKEN`, a dev-only stand-in that is undefined in a production build. The server now
injects a per-process token as `window.__NOOKLET__`, for loopback callers only.

### B-02 · Editing stopped after exactly one character
**Status:** fixed · `d6163df` · **Test:** `e2e/tests/editing.spec.ts`, "types a whole sentence"

`<For each={rows()}>` keyed on objects rebuilt by `flattenVisible` on every refetch, so each
keystroke recreated every row's DOM and tore out the element the single CodeMirror surface is
re-parented into. Now keyed by block id.

### B-03 · Clicking a block entered edit mode without focus
**Status:** fixed · `d6163df` · **Test:** `e2e/tests/rendering.spec.ts`, "clicking a seeded row"

The clicked `.vr-block-view` is swapped out of the DOM inside the click handler, so the browser
reset focus to `<body>` after the handler returned, undoing `view.focus()`. Re-asserted on the next
frame. Deliberately *not* moved to `mousedown`, which fires before link clicks and would break
`[[page]]` navigation.

### B-04 · Typed text vanished on blur, reappeared on reload
**Status:** fixed · `d6163df` · **Test:** `e2e/tests/editing.spec.ts`, "text survives blurring"

Two causes. See B-05 for why the UI didn't update; separately, a typed edit could be lost for real:
writes are debounced ~500 ms and nothing flushed on blur or unload, so clicking away and reloading
inside that window discarded it. Now flushed on `focusout` past the tree, `pagehide`, and
`visibilitychange`.

### B-05 · Nothing refetched after a write
**Status:** fixed · `d6163df` · **Test:** covered by B-04's test and "a page seeded through the API"

Global. Every resource source called `trackTable`/`trackPage` and then returned a stable scalar (an
id, a name, or literally `true`); `createResource` refetches only when the source *value* changes,
so Solid never re-ran the fetcher. Local edits reached SQLite and the UI kept rendering the
previous result until a reload. Sources now return a version-stamped object.

### B-06 · Enter dropped the next two keystrokes
**Status:** fixed · `d6163df` · **Test:** `e2e/tests/editing.spec.ts`, "Enter creates a second bullet"

Surfaced by fixing B-05: a refetch landing before the write committed overwrote the optimistic row
and unmounted the new block's editor, so `second bullet` arrived as `cond bullet`. The block being
edited is now preserved when absent from a query result.

---

### B-07 · Cmd+A in a block doesn't select its text
**Status:** fixed (by B-15's focus fix; covered by `e2e/tests/parity.spec.ts`) · **Status was:** open · **Severity:** high · **Found:** 2026-09-11, while writing e2e tests

Pressing Cmd+A (Ctrl+A) while editing a block does not select that block's text. It detaches the
editor and swallows the following keystroke — typing `persisted` after it produced
`seedersisted`, i.e. the `p` vanished and the caret jumped to the end.

Expected: select the block's text first, and only escalate to selecting sibling blocks on a second
press (`docs/spec/commands-and-keymap.md`). No keystroke should ever be dropped.

It turned out to be the same detached-editor fault as B-15: the keymap ran against an editor the
DOM no longer owned. `e2e/tests/parity.spec.ts` now presses Cmd+A in a real browser and asserts the
block's text is selected and the next keystroke replaces it.

### B-08 · References panel always present, no counts, not collapsible
**Status:** fixed · **Test:** `e2e/tests/references.spec.ts` · **Status was:** open · **Severity:** medium · **Reported:** 2026-09-11

Linked and unlinked references render as sections even when there are none, show no count, and
cannot be collapsed. Should show `Linked references (3)`, collapse/expand, and disappear entirely
when empty.

`apps/web/src/views/ReferencesPanel.tsx`.

### B-09 · References don't refresh after a local edit
**Status:** fixed · **Test:** `e2e/tests/references.spec.ts` · **Status was:** open · **Severity:** medium · **Found:** 2026-09-11, reading the code for B-08

`useLinkedReferences` and `useSearchResults` are server-backed and deliberately not wired to the
local change bus (`apps/web/src/data/store.ts`), exposing a manual `refetch` instead — but nothing
calls it. So adding a `[[link]]` does not update the panel until navigation.

Related to B-05's root cause but a separate path: those two resources bypass the version stamping.

### B-10 · A failed request renders as a permanent spinner
**Status:** fixed (search + references) · **Test:** `e2e/tests/references.spec.ts` · **Status was:** open · **Severity:** high · **Reported:** 2026-09-11 (as "searching for aa just stops at Searching…")

`SearchView` has a loading branch and a results branch but no error branch, so a rejected fetch
leaves "Searching…" on screen forever. The underlying 401 was B-01, but the *invisibility* is its
own bug and will hide the next failure too.

Every view that can fail needs an error state. Same applies to the references panel's "Loading…".

### B-11 · No diagnostics surface
**Status:** fixed · **Test:** `e2e/tests/diagnostics.spec.ts` · **Status was:** open · **Severity:** medium · **Requested:** 2026-09-11

Nothing in the UI says whether the client reached the API, whether it has a token (and if not,
why), how big the search index is, or whether embedding indexing is running. B-01 was invisible for
exactly this reason. `data/bootstrap.ts` already carries a `reason` field for this.

Wanted: a settings/dev panel with connection state, backend reachability, index size, indexing
progress.

### B-14 · No context menu on a bullet
**Status:** fixed · **Test:** `e2e/tests/parity.spec.ts` (3 tests) · **Status was:** open · **Severity:** medium · **Requested:** 2026-09-11

Right-clicking a bullet should open an app-specific menu rather than the browser's default:
zoom in, indent/outdent, toggle task, copy block ref, delete — and **formatting** (bold, italic,
highlight) when there is a selection. The commands already exist
(`commands/registrations/format.ts`, `structural.ts`); this is the missing surface for them.

### B-17 · Slash menu never verified in a browser
**Status:** FIXED — see B-28 below · **Status was:** needs-repro · **Severity:** medium · **Raised:** 2026-09-11

`SlashMenu`, `matchSlashTrigger` and the insert commands are implemented and unit-tested, and
`CommandLayer` wires them up — but nothing has ever exercised typing `/` in a real browser. Given
that every keyboard path checked so far had a defect (B-02, B-07, B-15), assume it is broken until
an e2e test says otherwise. Same for the `[[`, `#` and `((` autocomplete popups.

### B-18 · Formatting shortcuts never verified in a browser
**Status:** FIXED — see B-28 below · **Status was:** needs-repro · **Severity:** medium · **Raised:** 2026-09-11

`format.bold` / `format.italic` / `format.highlight` are registered with Cmd+B/I and unit-tested
against a fake editor host, but have never been pressed in a real browser. These route through the
same global capture-phase dispatcher and `EditorHost` delegation that B-07 shows is fragile.

## Notes for whoever picks this up

- `pnpm e2e` builds the client, boots a real server on a temp data dir, and drives Chromium. It is
  the only suite that would have caught B-01 through B-06.
- When a bug is "it doesn't update", check `data/store.ts` first — B-05's pattern was replicated
  across eight resources and is easy to reintroduce.
- Bugs found while fixing other bugs (B-06, B-09, B-12, B-16) are worth recording even when small;
  several entries above exist only because something else was being read carefully.
- **Assertions can hide bugs.** `expect(outliner).toContainText("first bullet")` and
  `toContainText("second bullet")` both passed while Enter was doing nothing at all, because both
  strings were sitting in one block. Assert structure (`toHaveCount`) alongside content.
- When a keyboard interaction "does nothing", check `document.activeElement` first. Three separate
  reports (B-15) were one focus bug, and the giveaway was that Backspace did not work either.
