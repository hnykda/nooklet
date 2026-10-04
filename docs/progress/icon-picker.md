# Progress: B-647 — page icon picker

Branch `worktree-agent-a04c81cc0af3292be`, based on `main` at `c3302f6`. Done; nothing in flight.

## Status

- [x] Emoji picker replacing the one-character field (`apps/web/src/views/EmojiPicker.tsx`,
      `emoji-picker.css`; wired in `views/PageIcon.tsx`). Pure logic in `apps/web/src/emoji/`
      (`search.ts`: search, typed-emoji check, grid movement; `recents.ts`; `load.ts`;
      `build-data.ts`: the build-time Vite plugin serving `virtual:emoji-data`).
- [x] Tests, bundle sizes and a Simulator screenshot (below).

## What it does

- Search field, focused on open. Typing searches English names and keywords (word prefixes, all
  terms; exact name first, then name prefix, then name words, then keyword-only). `:rocket:` and
  `thumbs_up` work too.
- A typed or pasted emoji (any pictographic, flag, or non-ASCII symbol such as ★) is offered as
  "Use what you typed"; Enter takes it. Letters in any script never count ("č" starts a search).
- With nothing typed: "Recently used" (24, per device in `localStorage`, like the theme), then the
  9 Unicode groups, with a category bar at the bottom that scrolls to each.
- Keys: focus stays in the field (`aria-activedescendant`). Down/Tab enter the grid, arrows move
  (Up/Down cross into the next/previous section at the same column), Up from the top row returns to
  the field, Left/Right move the caret until the grid is entered. Enter picks (a query highlights its
  first result). Escape clears the query, then closes. Focus goes back to the icon button after a
  key-driven close; a tap/click outside closes without moving focus.
- Touch: 8 columns, ~42 px cells on a 390 px phone; opened from the "…" menu's "Add icon" as before
  (the empty slot is still hidden on touch screens, B-225). Width is capped at the title row, so it
  never widens the page (cf. B-648).
- "Remove" (trash) button, shown only when the page has an icon: clears the property.
- Stored value unchanged: the `icon` page property, one emoji string, via `setPageIcon`.

## Reference: Logseq's icon picker

Read from source, `https://raw.githubusercontent.com/logseq/logseq/master/src/main/frontend/components/icon.cljs`
(fetched 2026-10-04): emoji data from `@emoji-mart/data` with emoji-mart's `SearchIndex`; tabs
All / Emojis / Icons (Tabler icons); a "Frequently used" section stored in local storage
(`storage/set :ui/ls-icons-used`); arrow keys move focus over the grid (Up/Down by 9 columns),
Enter clicks, Down/Tab from the field enters the grid; Escape clears the query first, then closes;
a colour picker for Tabler icons; a trash "del" button. Skin tones are kept in the icon value.
Taken: search, recents, sections, arrow/Enter/Escape behaviour, the delete button. Left out (non-goal,
"nothing fancy"): Tabler icons, colours, skin tones, tabs.

## Dataset decision

`emojibase-data` **17.0.0**, pinned exact, **devDependency** (build time only). MIT (Miles Johnson;
`LICENSE` in the package). Maintained (last publish 2025-11-17). Package is 50 MB unpacked because it
carries ~30 locales; only `en/data.json` (775 KB) and `en/messages.json` are read, at build time.
No Czech locale exists in emojibase (checked the package's directory list), so Czech keywords are not
available — English names and keywords only.

Rejected: `unicode-emoji-json` 0.9.0 (MIT, 840 KB, smaller) — names and groups only, **no keywords**,
so "space" would not find 🚀. Importing `emojibase-data/en/compact.json` directly at runtime — 571 KB
/ 83 KB gzip because it still contains every skin-tone variant.

Trimmed at build time by `emoji/build-data.ts` (a Vite plugin, nothing generated is committed) to
`[emoji, name, keywords, group]` tuples: drops the "component" group (bare skin tones, hair), the
lone regional-indicator letters, skin-tone variants, and glyphs newer than Emoji **15.1** (16 glyphs;
Emoji 16 needs iOS 18.4 / macOS 15.4 and older systems draw a box — the 15.1 cutoff is a judgement,
not measured on devices). Result: 1,898 emoji (counted with node over `en/data.json` using the same filter). (Unit test pins >1,800 and the version cut.)

## Lazy loading and the precache — decided: precached

The list is a dynamic `import("virtual:emoji-data")` (`emoji/load.ts`) on the first open, so it is
its own chunk (`static/_virtual_emoji-data-*.js`) and not in the main bundle. Unlike mermaid
(6 MB, deliberately excluded), this chunk **is** in the PWA precache: it is 38 KB gzipped, and a
picker that is empty the first time a phone opens it offline would be the next bug report. No change
to the workbox config was needed: `globPatterns` already precaches every emitted `.js`. Verified:
the chunk name appears in `dist/sw.js`; "rocket" does not occur in the main `index-*.js`. A failed
load (offline, evicted) shows "could not load offline — type or paste an emoji" and the typed-emoji
path still works; the next open retries.

## Bundle size (production build, `pnpm --filter @nooklet/web build`)

| | before (`c3302f6`) | after |
|---|---|---|
| main `index-*.js` | 655.61 kB / 212.40 kB gz | 662.59 kB / 214.88 kB gz (+6.98 / +2.48) |
| main `index-*.css` | 104.03 kB / 16.64 kB gz | 106.62 kB / 17.07 kB gz (+2.59 / +0.43) |
| emoji chunk (lazy) | — | 126.70 kB / 38.48 kB gz |
| PWA precache | 108 entries, 3085.59 KiB | 109 entries, 3218.67 KiB (+133 KiB) |

## Results

- Unit/component: `pnpm --filter @nooklet/web test` — 177 files, 1557 tests passed. New:
  `src/emoji/search.test.ts` (18, against the real dataset), `src/views/EmojiPicker.test.tsx` (8).
- `pnpm -r typecheck`: clean. `pnpm exec biome check . --diagnostic-level=error`: clean.
- e2e chromium, port 6430: new `e2e/tests/page-icon-picker.spec.ts` (3: search "rocket" → pick →
  server `icon` = 🚀 → Remove → property gone → rocket in recents; keyboard arrows/Enter/Escape/paste;
  phone 390 px via "…" → Add icon, fits on screen, no sideways scroll, category tap, cell tap,
  typed search) plus the specs whose locator changed (`.page-icon-input` → `.emoji-picker-search`):
  page-icons, page-title-fit, render-views, render-views-phone, and phone, more-menu(-phone),
  tasks-view-dates-phone — 32 passed. page-icon-picker + page-icons `--repeat-each=3`: 18 passed.
  The new spec cannot pass on the old code (no `.emoji-picker-search`), so no separate negative run.
- iOS Simulator (own headless iPhone 16, iOS 26.5, Mobile Safari, deleted afterwards):
  `tools/probes/icon-picker-sim/run.sh` serves a copy of the build with `driver.js` injected, opens
  the picker browsing and with "rocket" typed, screenshots both. Looked at by eye: grid, sticky
  section heading, category bar, rocket highlighted first with astronauts after; fits the screen.
  Screenshots were in the session scratchpad (not committed); re-run the probe to regenerate.

## Not done / unverified

- No Czech keywords (emojibase has no `cs` locale).
- Not run in the Capacitor app or on a real device — Mobile Safari in the Simulator only. The
  on-screen keyboard's effect on the popover's height (`min(18rem, 45dvh)`) was not checked with the
  keyboard up (the probe blurs the field).
- The 15.1 version cutoff is not tested against the owner's devices.
- The existing test name "only the first grapheme is kept, and clearing the field removes the icon"
  is kept (BUGS.md B-381 cites it) though clearing is now the Remove button.

## BUGS.md updates to fold in

- **B-647** → Fixed (2026-10-04, commit on branch `worktree-agent-a04c81cc0af3292be`). Text: the
  icon slot opens an emoji picker (`views/EmojiPicker.tsx`): search by English name/keyword
  (emojibase-data 17, MIT, build-time trimmed, lazy chunk 38 KB gz, precached), recents + category
  grid, arrows/Enter/Escape, touch at phone width, Remove button, typed/pasted emoji taken as is;
  stored value unchanged (`icon` property). Shaped after Logseq's `components/icon.cljs` minus
  Tabler icons/colours/skin tones. **Test:** `e2e/tests/page-icon-picker.spec.ts` (3),
  `apps/web/src/views/EmojiPicker.test.tsx`, `apps/web/src/emoji/search.test.ts`. Not checked on a
  real phone or in the Capacitor app; no Czech keywords (dataset has none).
- B-356/B-381 entries cite `page-icons.spec.ts` "…clearing the field removes the icon": that test now
  clears through the picker's Remove button (same server-poll assertions).
