# Progress: public site (apps/site)

Branch `worktree-agent-a3cca45c7a5208ed2`, started 2026-10-04. Not merged to main.

## State

Done and verified (see "Verification" below). Commits:

- `ad6bce6` wip scaffold (Next config, source loader, renderer, search, first figures)
- merge of `main` (brings the real `docs/guide/`, nine pages)
- `603534a` landing page, docs from `docs/guide`, figures from the guide's animation specs, search, llms files
- the commit that adds this file: e2e suite, README, mobile and search fixes

## Design direction

The page is an outline. One vertical thread runs down the landing page and every section heading is
a bullet on it, the way blocks hang off a parent in the app; feature lists and agent capabilities
are child bullets. Palette: cool sage paper `#f2f4f1`, green-black ink `#17201c`, thread `#c3ccc6`.
The only strong colours are the two devices in the sync figures, indigo `#3245a6` (laptop) and amber
`#8f5300` (phone); an op keeps its author's colour as it travels. Type: Familjen Grotesk for headings
and UI, Literata for reading text, the system monospace for code only.

Rejected on review: a cream background with a serif display and clay accent (generic), numbered
markers on the feature list (not a sequence; the sync steps are numbered because they are one), a
full-bleed hero screenshot crossing the thread (it broke the outline idea, now indented).

## Decisions

- **Static export, `trailingSlash: false`**, so `/docs/x` is `docs/x.html` and its markdown twin is
  `docs/x.md`. Costs: the server needs `try_files $uri $uri.html`. Documented in `apps/site/README.md`.
- **`.md` twins come from a post-build script** (`scripts/emit-raw.ts`): Next cannot put a route
  handler beside `app/docs/[slug]/page.tsx`. `llms.txt`, `llms-full.txt`, `search-index.json`,
  `sitemap.xml`, `robots.txt`, `og.png` are static route handlers.
- **OG image is `app/og.png/route.tsx`**, not `opengraph-image.tsx`: under `output: "export"` the
  convention file is written without an extension (`out/opengraph-image`) and would be served as
  octet-stream. Verified by building both.
- **Search is a prebuilt MiniSearch index** (no Pagefind native binary in the Docker build), one
  document per h2/h3 section, accent-folded. 514 KB raw, 143 KB gzipped, fetched on first hover or
  open of the search button.
- **TypeScript 7 has no JS API**, so `next build`'s type check is off (`ignoreBuildErrors`) and
  `pnpm --filter @nooklet/site typecheck` runs `tsc` instead; it is part of `pnpm -r typecheck`.
- **No fixtures.** The coordinator merged the real guide before the site finished, so the
  placeholder pages were deleted and the loader throws if `docs/guide` is empty.
- **Figures are HTML + CSS grid + small inline SVG**, stepped by a timer in React. They use a
  container query, so the same figure is a row on the landing page and wherever the docs column is
  wide enough, and a column on a phone. Under reduced motion they render the last step, never
  advance, and hide the travelling dots; the step buttons still work.
- **Animation specs are matched by title.** The guide's specs have no `id` and their YAML does not
  parse (step lines contain `HLC 10:00:05`), so `lib/render.ts` reads top-level `key:` lines with a
  regex when YAML fails, and `components/sync/registry.tsx` matches the title.

## The figures and their specs

| Figure | Spec in `docs/guide/how-it-works.md` | Steps |
|---|---|---|
| `Converge.tsx` | "Two devices edit offline and converge" | 6, as the spec lists |
| `OpJourney.tsx` | "One op travels from device to server to another device" | 8, as the spec lists |
| `Mirror.tsx` | "The database is the truth; the files are a copy" | 5, as the spec lists |
| `MergeDemo.tsx` | none (landing only) | clean word merge, then an overlapping edit kept as `conflict_copy::`, matching `sync-and-offline.md` |

Simplifications against the specs: no SQLite "cylinder" drawings (a `SQLite, cursor N` line
instead), no finger or pencil glyphs, and in the converge figure the phone's push and both pulls
share one step.

## Screenshots

From the real app (`nooklet serve`, port 6447) on `apps/site/demo-graph/`, invented notes about a
garden shed, a reading list and a neighbour called Jana; never anyone's real graph. Re-run with
`pnpm --filter @nooklet/site screenshots`.

- `page-light.png` / `page-dark.png`: the "Garden shed" page. Two properties (collapsed), a Plan
  block with a DONE task, two TODOs carrying a "Tue" scheduled chip and an "Oct 11" deadline flag,
  a LATER task, a Notes block, then Linked references grouped by journal day.
- `journal-light.png` / `journal-dark.png`: the journal with "Oct 4th, 2026 · Today" on top (a
  DOING task with the half-filled glyph, a TODO, `#ideas`, a `[[Jana]]` link), then Oct 3rd and
  Oct 1st.

Site screenshots reviewed during the work (desktop 1440 and phone 390, both themes): hero with the
bullet-on-a-thread headline; feature outline in two columns; the op figure mid-run (phone outbox
holding the `block.create` card, server log at seq 127); the merge figure on its conflict step;
the docs page with sidebar, TOC and the mirror figure as a three-panel row; the ⌘K dialog with
section-level hits and marked terms; the phone docs page with the page list collapsed above the
article.

## Verification (2026-10-04)

- `pnpm --filter @nooklet/site build`: 47 static routes, 36 `.md` twins, `out/` 9.2 MB.
- `pnpm --filter @nooklet/site e2e`: 16/16 pass (8 tests × desktop 1440 and Pixel 7): landing
  renders with landmarks and loaded screenshots and no sideways scroll and no console errors; the
  op figure advances and shows a travelling op; under reduced motion all three landing figures sit
  on their last step for 3 s with no dots and the step buttons still work; docs index → page →
  sidebar → TOC; how-it-works renders 3 live figures and 0 placeholders; ⌘K (desktop) / button
  (phone) search for "fractional" opens a matching page with Enter; `llms.txt`, a `.md` twin
  (`text/markdown`), `llms-full.txt`, `sitemap.xml`, `og.png` (`image/png`); unknown path → 404
  page with status 404; theme toggle changes the background and survives reload.
- `pnpm -r typecheck` and `pnpm exec biome check . --diagnostic-level=error`: clean.
- Every `#anchor` the guide links to exists in the built HTML (checked five by grep).

## Still unverified

- The build offline: `next/font/google` needs Google Fonts at build time. Not tried without
  network; the Docker build needs outbound HTTPS.
- Real nginx in front of `out/`. Only `scripts/serve.ts` (same lookup rules) was tested.
- Safari and Firefox. Only Chromium ran. `::details-content` (used to show the docs sidebar on wide
  screens before hydration) is not in every browser; the client effect opens it anyway.
- Lighthouse or axe scores were not run. Text contrast was computed with the WCAG formula for the
  main pairs: ink-soft on paper 6.8:1, ink-faint 5.0:1 (raised from 4.2:1 after that check),
  indigo 7.5:1, amber 5.6:1; dark theme ink-faint 5.4:1, indigo 8.5:1. Not every pair was checked.

## Next steps

1. Infra agent: Dockerfile and Woodpecker pipeline per `apps/site/README.md`.
2. When the guide adds an `animation-spec`, draw it and add a pattern to `registry.tsx`; the build
   warns until then.
3. Re-capture screenshots when the app UI changes (journal dates are fixed at 2026-10-01..04).
