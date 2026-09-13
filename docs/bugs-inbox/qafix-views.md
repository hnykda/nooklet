# Bugs inbox — qafix-views (M8 exploratory QA of the M7 views, real graph)

Entries in `docs/BUGS.md` format, to be merged there by the coordinator. Numbers B-250..B-259.

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
