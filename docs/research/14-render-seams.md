# 14 — Wiring the render seams: highlighter and math, measured

Date: 2026-09-12. Status: findings, recorded as measured; not updated in place.

## 0. The short version

Both seams that had been empty since M2 (`render/tokens.tsx`'s `highlightCode` prop, the `math`
fallback in `editor/livePreview.ts`) are now wired: **highlight.js** (core + one lazy chunk per
grammar) for code fences, **KaTeX** for `$…$`. Both load on first use only. Measured on the exact
commits, in clean worktrees:

| | before `ea6903b` | after `4ef5864` | delta |
|---|---:|---:|---:|
| Startup JS (main + statically-loaded chunks), minified | 597.43 kB | 603.52 kB (499.56 + 103.96) | **+6.1 kB** |
| Startup JS, gzip | 189.53 kB | 192.36 kB (162.70 + 29.66) | **+2.8 kB** |
| Startup CSS (`index-*.css`) | 66.19 kB / 11.08 gz | 66.19 kB / 11.08 gz | 0 |
| PWA precache | 23 entries, 2028.07 KiB | 91 entries, 2760.15 KiB | +68 entries, **+732 KiB** |

A page with no code and no maths fetches none of the lazy chunks (asserted by
`e2e/tests/render.spec.ts` via request capture). The price of the feature is paid by the
service worker's background precache, once — see §3 for whether that is the right trade.

## 1. What was chosen, and what was not

**Highlighter: highlight.js 11.12.0**, `lib/core` plus `lib/languages/<name>` behind one literal
dynamic `import()` per grammar (41 grammars; aliases such as `js`/`ts`/`py`/`sh`/`html`/`yml`
resolve in the main bundle without loading anything). Considered and rejected:

- *shiki 4.x* — research/04-editor.md §4 named it first, with highlight.js as "the lighter
  fallback if shiki's WASM/Oniguruma cost is a problem on phones". It is: the JS regex engine
  alone is larger than highlight.js's whole core, and TextMate grammars run tens of kB each where
  highlight.js's are 0.4–13 kB (measured below). Shiki's output is nicer for a code editor; for a
  note's fence next to prose the difference does not earn the weight.
- *lowlight* — highlight.js wrapped as hast; an extra layer with nothing this renderer needs.
- *`@codemirror/lang-*` via `@lezer/highlight`* — would give in-editor highlighting too, but the
  editing surface deliberately shows fences plain (research/04 §4: "code fences are plain while
  editing and highlighted in view mode"), and rendering a Lezer tree to static HTML is more
  plumbing than the seam asked for.

**Math: KaTeX 0.18.7.** Synchronous `renderToString` is what the CodeMirror widget needs — a
`WidgetType.toDOM` cannot await — and it is a fraction of MathJax's size. `trust: false`
(default, stated explicitly) keeps `\href`/`\url`/`\htmlClass` inert, which is what makes
`innerHTML` of its output safe; `throwOnError: false` renders a half-typed formula as source in
KaTeX's error colour rather than throwing inside a decoration pass.

## 2. Chunk-by-chunk (after, `4ef5864`)

| chunk | min | gzip | loaded when |
|---|---:|---:|---|
| `index-*.js` | 499.56 kB | 162.70 kB | startup |
| `BlockRowView-*.js` | 103.96 kB | 29.66 kB | startup (static dep of index, split out because `QueryFenceView` also imports it) |
| `highlighter-impl-*.js` + `.css` | 23.32 + 1.70 kB | 9.16 + 0.62 kB | first highlightable fence |
| grammar chunks, 41 of them | 146.18 kB total; 0.40 (dockerfile) … 13.13 (scss); js 6.35, ts 7.60, py 3.31 | ≈ 0.3–4.7 kB each | first fence in that language |
| `math-impl-*.js` + `.css` | 258.86 + 29.94 kB | 77.65 + 8.01 kB | first `$…$` token rendered or edited |
| KaTeX fonts, 19 × woff2 | 292 KB total (4.9–28 kB each) | — | browser fetches a family on first glyph use |
| `QueryFenceView-*.js` + `.css` | 23.02 + 2.49 kB | 7.76 + 0.82 kB | first ```` ```query ```` fence |

The `BlockRowView` split is rolldown's doing, not a design choice: once a lazy chunk shares a
module with the entry, the shared part becomes its own chunk. It is preloaded, so the cost is one
extra request at startup, not a delay before first paint. Before/after startup bytes above add it
back in.

## 3. The precache question (open — coordinator's call, `vite.config.ts` is not this agent's)

`vite-plugin-pwa`'s `globPatterns` include `**/*.{js,css,woff2}`, so every lazy chunk and every
KaTeX font is precached on install: +732 KiB downloaded once, in the background, for every user
including those who never write code or maths. Options:

1. Keep it (current). Offline-first is the product's whole point; a user who writes their first
   formula on a plane gets it rendered. 732 KiB once is cheaper than the surprise.
2. `globIgnores` the fonts and grammars and let `runtimeCaching` (CacheFirst on `/static/`) pick
   them up on first use. Saves ~440 KiB of install; costs first-use-offline.
3. Precache the highlighter and KaTeX JS/CSS but not fonts/grammars — the middle.

Recommendation: 1 until someone measures install time on a phone and finds it matters.

## 4. How the numbers were made

`tools`: `scratchpad/measure.sh` — `git worktree add` for each commit, `pnpm install
--frozen-lockfile --offline --ignore-scripts`, `pnpm --filter @nooklet/web exec vite build`, sizes
from Vite's own reporter (minified and gzip). The working-tree build at the same time was
confounded by other agents' uncommitted files (its main chunk differed by ±30 kB between runs),
which is why the two commits were built in isolation.

## 5. Still unverified

- No phone measurement of first-load or precache-install time. The +2.8 kB gzip startup delta
  is small enough that it was not worth a device run; the +732 KiB precache is the number that
  might matter there.
- highlight.js output is escaped by construction; KaTeX's is safe under `trust: false`. Neither
  was fuzzed here — both claims rest on the libraries' documented contracts and the unit tests'
  `<b>`-in-code and `\href`-free spot checks.
