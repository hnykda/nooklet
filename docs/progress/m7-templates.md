# M7 · templates — progress log

Agent task: research/13 §4.2 item 2 — `/template`, journal template, dynamic tokens, ADR 019.
Working from HEAD `c9a98f9`. Updated after every meaningful step; if you are reading this after
a restart, continue from "Next steps".

## 1. Done (commit hashes)

- (nothing committed yet)

## 2. In flight — files mid-edit and their state

| File | State |
|---|---|
| `packages/core/src/templates.ts` | written, 9 unit tests green (`templates.test.ts`) |
| `packages/core/src/index.ts` | one export line appended (`./templates.js`) |
| `apps/web/src/data/templates.ts` | written, not yet typechecked |
| `apps/web/src/commands/slash/TemplatePicker.tsx` + `template-picker.css` | written; must be imported lazily from the command (node-env tests fail on `window`) |
| `apps/web/src/commands/registrations/templates.ts` + `.test.ts` | written; test fails only because of the eager picker import above |
| `apps/web/src/commands/registrations/index.ts` | `createTemplateCommands` wired + re-exported (outside my file list — report it) |
| `apps/web/src/commands/slash/items.ts` | "Template" row appended (shared file) |
| `apps/web/src/commands/slash/SlashMenu.test.tsx` | needs item count 15 → 16 (not my file; minimal bump, report it) |

## 3. Next steps, in order

1. Make `registrations/templates.ts` import the picker with a dynamic `import()`; bump SlashMenu.test count; run `pnpm -r test` for core + web commands.
2. `apps/web/src/views/VirtualJournalDay.tsx`: apply the journal template on materialize (one `applyOps` batch via `getOpClock`); update `VirtualJournalDay.test.tsx` mocks.
3. Server: new `packages/server/src/journal-template.ts` (load the journal template node from `block_prop` + `block`); `data-api.ts#journal()` inserts it when creating a day (+ `journal-template.test.ts`).
4. `apps/web/src/views/SettingsPanel.tsx`: append a "Templates" section (journal template `<select id="set-journal-template">`).
5. `docs/adr/019-templates.md`; `docs/BUGS.md` entries (client plugin host absent → `/mermaid` never reaches the menu; template insertion not in editor undo history) — re-read BUGS.md for the next free number (another agent has appended since B-84).
6. `e2e/tests/templates.spec.ts`; run on port 6351; fix; then `pnpm -r typecheck`, `pnpm -r test`, biome, full e2e on 6351.
7. Commit in logical units (core → web data/commands → journal paths → settings → docs → e2e).

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
