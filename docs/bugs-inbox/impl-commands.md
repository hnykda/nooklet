# Bugs inbox — impl-commands (m8)

Entries in `docs/BUGS.md`'s format, for the coordinator to fold in. Existing bugs are marked
"(existing)"; new ones use B-160..B-169.

---

### B-97 (existing) · "Collapse all" and "Expand all" do nothing
**Status:** in progress · **Severity:** medium · **Found:** 2026-09-12, exposure audit

---

### B-98 (existing) · "Open plugin manager" leads to a blank page
**Status:** in progress · **Severity:** low · **Found:** 2026-09-12, exposure audit

---

### B-105 (existing) · Argument-only commands show as palette rows that do nothing
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

### B-106 (existing) · Comment and spec drift around commands
**Status:** in progress · **Severity:** low · **Found:** 2026-09-12, exposure audit

---

### B-160 · The shelf is reachable only by Shift+click
**Status:** in progress · **Severity:** low · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md` §1.4, §1.10 #15, §2 item 6) · **Test:** —

Nothing in the palette, the bullet context menu or the page switcher puts a block or a page on the
shelf; the only way in is a Shift+click on a bullet or a `[[link]]`, which nothing on screen
mentions. A keyboard user cannot shelve anything at all.
