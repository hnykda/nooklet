# Top-right "⋯" menu (B-541 follow-up)

Branch: `worktree-agent-a81e27c54a58c349a`. It had been created from an old commit (`41666ee`, no
SyncIndicator, no B-541), so it was fast-forwarded to main `fd779f4` before any work.

## Status: done (one commit on the branch, not merged into main)

## What was built
- `apps/web/src/shell/MoreMenu.tsx` + `more-menu.css`: an `.app-icon-button` with lucide's
  `Ellipsis`, aria-label "More", **last** in `.app-topbar` (after the sync cloud, plugin status
  items and the agent-access badge). Opens a right-anchored popover (`role="menu"`) with:
  Settings · ─ · All pages · Graph · Trash · ─ · Keyboard shortcuts · Diagnostics.
  The bound key shows beside an item on non-touch devices (today only Settings: Cmd+, / Ctrl+,).
  Closes on Escape (also claimed in the popup-key registry, B-72), on a pointerdown outside, and
  after choosing. Choosing also closes the phone sidebar drawer.
- Every item is a registered command run through `buildContext(...).exec(id)` — no ad-hoc
  handlers. New commands (spec §E.3/§E.6 rows + R44c + R52 prose added; the generated wiki
  shortcut page regenerated):
  - `nav.allPages` "Open all pages", `nav.graph` "Open graph", `nav.trash` "Open trash"
    (NavigationHost `openAllPages/openGraph/openTrash` → `/pages`, `/graph`, `/trash`).
  - `app.showShortcuts` "Show keyboard shortcuts", `when: "!mobile"` (B-564) → HelpMenu's
    module-level `openShortcuts()`.
  - `app.openDiagnostics` "Open diagnostics" → `openDiagnostics()`.
  - Settings reuses `app.openSettings`.
- The menu lists only items whose command is registered and whose `when` holds. So:
  - Graph on Capacitor (B-578): `app/CommandLayer.tsx` leaves `nav.graph` out of the registry when
    `platform.name === "capacitor"` — the palette loses "Open graph" there too, consistently.
  - Keyboard shortcuts on touch (B-564): hidden by the command's `when`.
- Desktop traffic lights (B-541): the menu is at the right end, nowhere near them;
  `desktop-shell.spec.ts` now also asserts the ⋯ button and its Settings item are clickable at the
  1100×800 desktop viewport.
- Phone: the bar is already inset by `--sar` (`.app-shell` padding); the popover is right-anchored
  with `max-width: calc(100vw - 2*space-md)`, and touch rows are taller (`pointer: coarse`).

## Decision: the bottom-right `?` FAB stays; Settings moves out of it
- Kept: the `?` holds things that exist nowhere else in the UI — Documentation, Report a bug,
  Request a feature, the build version — and is "where people look at the moment of confusion"
  (HelpMenu's own rationale). Removing it would lose those or cram them into ⋯. Logseq keeps both
  a `?` bottom right and a `…` top right, the same split.
- Settings removed from `?`: HelpMenu's comment said Settings deliberately has exactly one pointer
  route; that route is now ⋯ → Settings (where the owner looked for it). Keyboard shortcuts stays
  in both, because it is help content; both open the same dialog.
- Docs that said "`?` → Settings" updated: `docs/wiki/pages/Settings.md`, `Search.md`,
  `Contributing.md` (Diagnostics also via ⋯). `docs/review/2026-09-12-exposure-audit.md` left as
  written (it is a dated record).

## Screenshots (taken with a throwaway Playwright spec, deleted afterwards)
- Desktop 1100×800, desktop-shell flag, light: top bar left = sidebar toggle, back, forward,
  calendar, graph switcher; right = sync cloud (green dot), agent badge (green dot), and the ⋯
  button (hover-grey while open). Popover hangs under ⋯, flush right with ~8px margin, ~180px wide:
  "Settings  Cmd+," / divider / All pages, Graph, Trash / divider / Keyboard shortcuts, Diagnostics,
  each with an icon (gear, file, network, bin, keyboard, stethoscope). `?` FAB unchanged bottom
  right. Dark mode: same, dark surface, legible text.
- iPhone 13 (390 px, WebKit-descriptor UA in Chromium): the whole bar fits on one row with the ⋯ at
  the far right; popover is right-anchored, fully on screen, bigger touch rows; items are Settings,
  All pages, Graph, Trash, Diagnostics — no Keyboard shortcuts, no key hints. `?` FAB still at
  bottom right.

## Verification (2026-10-03)
- Component: `apps/web/src/shell/MoreMenu.test.tsx` (5 tests: order, each item runs its command,
  unregistered Graph hidden, `!mobile` hides shortcuts, Escape/outside close);
  `commands/registrations/nav.test.ts` (+3 for the nav commands); `spec-tables.test.ts` passes
  with the new spec rows.
- `pnpm --filter @nooklet/web test`: 163 files / 1396 tests passed. (Two earlier full runs failed
  only `src/sync/e2e.test.ts` "…pull first" — the known open flake B-570; it passed alone 3/3 and
  in the final full run.)
- `pnpm -r typecheck`: exit 0. `pnpm exec biome check . --diagnostic-level=error`: clean.
- e2e (port 6304): `more-menu`, `more-menu-phone`, `desktop-shell`, `phone`, `phone-palette`,
  `diagnostics`, `help`, `settings`, `views`, `render-views-phone`, `sync-indicator`,
  `graph-switcher`, `graph`, `navigation`, `commands`, `trash`, `templates`, `appearance`:
  113 passed. Five specs (`settings`, `views`, `templates`, `appearance`, `phone`) opened Settings
  via `?` → Settings and were moved to ⋯ → Settings.

## Still unverified
- Not run in the real Tauri desktop window or the Capacitor iOS build (Chromium only; the phone
  spec uses Playwright's iPhone 13 descriptor). That Graph is absent on Capacitor is covered by the
  component test's "unregistered command" case and by reading `CommandLayer`, not by a device run.
- The phone top bar was checked with no plugin status item showing; with a plugin's word count
  and the badge in its wide state (PaletteButton's B-352 note), the 390px bar has one more icon
  than before and was not measured in that state.

## BUGS.md updates to fold in
- **B-541**, append: "**Follow-up done 2026-10-03** (branch `worktree-agent-a81e27c54a58c349a`):
  the top-right "⋯" menu — `shell/MoreMenu.tsx`, last in the top bar after the sync cloud and the
  agent badge — with Settings (Cmd+,), All pages, Graph, Trash, Keyboard shortcuts, Diagnostics.
  Each item runs a command (new: `nav.allPages`, `nav.graph`, `nav.trash`, `app.showShortcuts`,
  `app.openDiagnostics`; Settings is `app.openSettings`), so the palette reaches the same places.
  Graph is not registered on Capacitor (B-578); Keyboard shortcuts has `when: "!mobile"` (B-564).
  Settings moved out of the `?` menu (one pointer route); the `?` FAB stays for docs, bug/feature
  links and the version. **Test:** `e2e/tests/more-menu.spec.ts` (opens each item),
  `e2e/tests/more-menu-phone.spec.ts`, `e2e/tests/desktop-shell.spec.ts` (⋯ clickable at the
  desktop size), `apps/web/src/shell/MoreMenu.test.tsx`."
- **B-564**, append: "Also applies to the "⋯" menu: its Keyboard shortcuts item runs
  `app.showShortcuts`, whose `when` is `!mobile` (`MoreMenu.test.tsx`, `more-menu-phone.spec.ts`)."
- **B-578**, append: "`nav.graph` (the "⋯" menu's Graph, and "Open graph" in the palette) is left
  out of the registry on Capacitor (`app/CommandLayer.tsx`)."
- New bugs: none found.
