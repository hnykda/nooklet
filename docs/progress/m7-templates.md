# M7 · templates — progress log

Agent task: research/13 §4.2 item 2 — `/template`, journal template, dynamic tokens, ADR 019.
Working from HEAD `c9a98f9`. Updated after every meaningful step; if you are reading this after
a restart, continue from "Next steps".

## 1. Done (commit hashes)

- `78970b1` core `templates.ts` (+tests), client `data/templates.ts`, `/template` command +
  picker, slash row, wiring. NOTE: this commit swept in the query agent's uncommitted
  `export * from "./query.js"` line in `packages/core/src/index.ts` (it was in the working tree
  when the file was staged) — HEAD references `query.ts`, which is still untracked until the
  query agent commits it. Told the coordinator in the report.

## 2. In flight — files mid-edit and their state

| File | State |
|---|---|
| `packages/server/src/journal-template.ts` (new) + `.test.ts` | written; test seed fixed (marker via properties); rerun pending |
| `packages/server/src/data-api.ts` | `journal()` inserts the journal template; 4 import lines added (outside "only that function" — report) |
| `apps/web/src/views/VirtualJournalDay.tsx` + `.test.tsx` | rewritten: one `applyOps` batch, template first; 5 tests green |
| `apps/web/src/data/templates.ts` | `loadJournalTemplate` / `journalTemplateOpsFor` shape (load once, size pool from it) |
| `apps/web/src/views/SettingsPanel.tsx` | `TemplatesSection` appended + import + mounted after Appearance (shared file) |
| `apps/web/src/commands/registrations/templates.ts` + `.test.ts` | picker path is fire-and-forget now (slash menu would otherwise linger); test rewritten |
| `docs/adr/019-templates.md` | written |
| `docs/BUGS.md` | B-87 (no client plugin host), B-88 (template insert not undoable) appended to Open |
| `e2e/tests/templates.spec.ts` | written, NOT yet run |

## 3. Next steps, in order

1. Run: server `journal-template.test.ts`; web `templates.test.ts` + `VirtualJournalDay.test.tsx`; typecheck server + web (filter to my files — other agents' in-flight errors exist in `shelfOutline.test.ts`, `core/src/query.ts`); biome on my files.
2. Commit unit 2 (journal paths + settings + ADR + BUGS + progress).
3. `cd e2e && NOOKLET_E2E_PORT=6351 pnpm exec playwright test tests/templates.spec.ts`; fix; commit the spec.
4. Full e2e on 6351, `pnpm -r typecheck`, `pnpm -r test`; final progress update; report.

## 4. Decisions made and why

- **Core, not plugin.** No client plugin host exists in `apps/web` (nothing implements
  `ClientPluginContext`; `registerSlashCommand` is a type only; `SlashMenu` ranks a static list),
  so the plugin route would mean building that host and editing `SlashMenu.tsx`. The journal
  template must also run inside two hosts' page-creation paths (client first keystroke, server
  `journal()`), which no plugin hook reaches. Full reasoning in ADR 019.
- **The journal-template setting is graph data**: a block property `journal-template:: true` on
  the template block (precedent: `favorite::` in `store.ts`). Both birth paths read it from what
  they already have (client replica / server DB); there is no settings op and `ops/**` is not
  mine; it syncs, mirrors, and agents can set it with `block_update`. Oldest block wins a tie.
- **Server expands `<% today %>`** with the graph's suggested title format
  (`journal-format.ts`) or `DEFAULT_JOURNAL_TITLE_FORMAT`; the client with the reader's format.
  Either resolves (ADR 018 canonical ref keys). In a journal template `today` = that journal's day.
- **`/template` picker** is a second-level popup that keeps the editor focused (slash-menu model;
  typed filter consumed at document capture), mounted imperatively — a command has no JSX tree
  and `CommandLayer` is not mine.
- **Empty bullet → template goes INTO it** (first node's text via `EditorHost.replaceRange`, props
  via ops, children beneath); non-empty bullet → inserted after, caret to first new block.

## 5. How to resume

- e2e: `cd e2e && NOOKLET_E2E_PORT=6351 pnpm exec playwright test tests/templates.spec.ts`
- unit: `cd packages/core && pnpm exec vitest run src/templates.test.ts`;
  `cd apps/web && pnpm exec vitest run src/commands/registrations/templates.test.ts src/views/VirtualJournalDay.test.tsx`
- checks: `pnpm -r typecheck`, `pnpm -r test`, `pnpm exec biome check --write <files>`
- scratch: `/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/`
- commit trailer (exact):
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` /
  `Claude-Session: https://claude.ai/code/session_014zmrHaeuokMBDD83XdybrJ`
- Never `git add -A`; commit only the files listed above plus this file.
