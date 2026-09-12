# M7 progress — views agent (filters/sort, appearance, shelf outline, link-unlinked)

Resilience log, updated after every meaningful step. If you are reading this after a restart:
read "Next steps" and continue from there. Owner brief: research/13 §4.2 items 5, 6, 7 and 10b.

## 1. Done (committed)

- `750cc25` feat(server): `mentions.link` op (`packages/server/src/ops/page-link-unlinked.ts` +
  `.test.ts` + `.http.test.ts`), registered in `ops/index.ts`, MCP pin in `mcp/server.test.ts`
  (now counts `CORE_TOOL_NAMES.length` instead of a hard-coded 21), spec §4.3.24 + catalog row 25
  in `docs/spec/mcp-tools.md`. Named `mentions.link`, NOT `page.link_unlinked`: the registry's
  `OP_NAME_RE` (spec §3.1 rule 1) rejects underscores inside a segment.

- `7e2ec53` feat(web): references filters/sort + Link all with undo (feature 5 + 10b client),
  ADR 021, this progress file.
- `551daa7` feat(web): appearance basics (feature 6).
- `dab300f` feat(web): shelf page-outline mode (feature 7).
- `81546e1` test(web): explicit type on the shelf outline test helper (TS7022 caught by the
  worktree typecheck). biome: clean on all 22 of my files (17:50).

All four features are committed with green unit tests. **The four e2e specs pass (8/8, 17:41)**
in the HEAD worktree on port 6353 (see Blockers for why a worktree). `pnpm -r test` at HEAD
(f1675df): all four packages green (17:44). `pnpm -r typecheck` fails in `packages/core/src/query.ts`
(the query agent's commit f1675df, not mine) — server and web typecheck on their own.
**Full e2e suite (18:05, foreground, port 6353, worktree at f1675df + cherry-picked 81546e1
because HEAD `fe1a197` broke `ops/index.ts` with duplicate `trashList`/`trashRestore` exports):
247 passed, 2 failed, 2 skipped.** The 2 failures are `popups.spec.ts` slash-menu counts (16
items on screen vs the spec's 15) — the templates agent's `/template` item (78970b1) without a
`SLASH_ORDER` update; none of my code. Remaining: log that in BUGS.md, final report.

## 2. In flight (on disk, uncommitted)

- Nothing uncommitted of mine at 17:36. The details below describe what each commit contains, for
  orientation after a restart.
- **References filters/sort + Link all (client)** — in `7e2ec53`:
  - `apps/web/src/views/referenceGrouping.ts` (+ `.test.ts`): sort param, `filterCandidates`,
    `applyReferenceFilter`, `cycleFilterKey`, `referencedKeys`.
  - `apps/web/src/views/referenceFilters.ts` (+ `.test.ts`, new): localStorage persistence.
  - `apps/web/src/views/ReferencesPanel.tsx`: head row with sort + filter popover + chips;
    "Link all" button on the unlinked head; status line with Undo (`batch.undo`).
  - `apps/web/src/views/references.css` (new): styles for the above.
  - `e2e/tests/references-filters.spec.ts`, `e2e/tests/link-unlinked.spec.ts` (new).
- **Appearance** — code complete, unit tests green, e2e NOT yet written:
  - `apps/web/src/data/appearance.ts` (+ `.test.ts`, new): text size / content width / custom CSS,
    localStorage, `data-text-size` / `data-measure` on `<html>`, one replaced `<style>`.
  - `apps/web/src/styles/shell.css`: `:root[data-text-size=…]` / `:root[data-measure=…]` token
    overrides, inserted before "── Base".
  - `apps/web/src/views/SettingsPanel.tsx` (shared file, Appearance section only): Text size,
    Content width segmented rows + Custom CSS textarea. `apps/web/src/views/settings.css`:
    appended `.set-field-block` + textarea rules.
- **Shelf outline** — code complete, unit test written, e2e NOT yet written:
  - `apps/web/src/shell/shelfOutline.ts` (+ `.test.ts`, new): `outlineEntries`, `blockTitle`,
    `plainText`.
  - `apps/web/src/shell/Shelf.tsx`: page card mode toggle (`.shelf-mode`, aria-pressed), `PageToc`,
    `revealOnPage` (navigate if needed, poll for `[data-block-id]`, scroll + `.shelf-reveal-target`).
  - `apps/web/src/shell/shelf.css`: appended TOC + reveal styles.

## 3. Next steps, in order

1. Write `docs/adr/021-reference-filters-per-device.md` (021 was free at 17:35; 019 claimed by
   another agent's comment, 020 on disk).
2. biome + vitest on shelf files; commit **references filters/sort + link-all client** as one
   commit (feature 5 + 10b client), even before e2e runs if the tree still cannot boot.
3. Write `e2e/tests/appearance.spec.ts`, `e2e/tests/shelf-outline.spec.ts`.
4. Commit **appearance** (feature 6), commit **shelf outline** (feature 7).
5. When the tree boots (see Blockers): run the four specs, then the full suite, on port 6353;
   fix; `pnpm -r typecheck`, `pnpm -r test`, biome. Log any bug in `docs/BUGS.md` first.
6. Final report to the owner.

## 4. Decisions

- **Filter persistence: per device, `localStorage`, keyed by `normalizePageName(page)`** — not a
  `filters::` page property (Logseq's way, what research/13 suggested). A filter is a fact about
  this screen, like the theme and the shelf; a page property would make every popover click a
  graph write (op log, mirror, `changes.since`, an undoable batch) and show up in the page's
  properties. ADR 021 records it with the rejected alternatives. Sort is one global preference.
- **Include is AND, exclude is OR** (Logseq semantics). Candidates = source page + `[[refs]]`/`#tags`
  in the block's first line (what `page.backlinks` returns) — continuation-line refs are a known
  limitation, noted in `referenceGrouping.ts`'s header.
- **`mentions.link`**: first safe mention per block only; author's spelling kept when it resolves
  by key; namespaced pages get the full name; skips reported with reasons.
- **Appearance sizes live in `shell.css` only** (data-attribute overrides), never in TS.
- **Shelf reveal does not use `nav.revealBlock`**: its flash is tagged "Agent" (ADR 015 §2.6).
  Own poll + `.shelf-reveal-target` pulse instead.

## 5. Blockers / notes

- e2e cannot boot on the WORKING TREE right now: another agent's untracked
  `packages/server/src/ops/block-to-page.ts` registers `name: "block.to_page"`, which the registry
  rejects at startup (same rule that renamed my op). `pnpm -r typecheck` also fails in their
  untracked `packages/core/src/query.ts`. Neither is committed, so HEAD boots.
  **Workaround in use:** a detached git worktree at HEAD in
  `<scratchpad>/wt` (`git worktree add --detach <scratchpad>/wt HEAD && pnpm install
  --frozen-lockfile --prefer-offline`), e2e run from `<scratchpad>/wt/e2e` on port 6353. Fixes
  are made in the main tree, committed, and the worktree moved with `git -C <wt> checkout --detach
  <hash>`. Remove with `git worktree remove --force <wt>` when done.
- Uncommitted changes by other agents are present in the tree (package.json, BUGS.md, core, server,
  commands/…). Commit only the files listed above.

## 6. How to resume

- Unit: `cd apps/web && pnpm exec vitest run src/views src/data/appearance.test.ts src/shell`;
  `cd packages/server && pnpm exec vitest run src/ops/page-link-unlinked src/mcp/server.test.ts`.
- e2e (always this port): `cd e2e && NOOKLET_E2E_PORT=6353 pnpm exec playwright test
  tests/references-filters.spec.ts tests/appearance.spec.ts tests/shelf-outline.spec.ts
  tests/link-unlinked.spec.ts --project=chromium`; full suite: drop the file list.
- Lint: `pnpm exec biome check --write <files>` from the repo root (absolute paths).
- Scratch: `/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/`.
- Commit trailer (exact):
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` /
  `Claude-Session: https://claude.ai/code/session_014zmrHaeuokMBDD83XdybrJ`. Never push, never
  `git add -A`.
