# nooklet wiki

The user documentation for nooklet, written as a nooklet graph. This directory is a Logseq-style
file graph — `pages/*.md` in outline markdown plus `logseq/config.edn` — that `nooklet import`
loads, so the docs are read in the tool they describe. It is also the first candidate for a
future "publish a graph as a site" feature.

## Open it

```sh
pnpm nooklet import "$PWD/docs/wiki" --data /tmp/nooklet-wiki
pnpm nooklet serve --data /tmp/nooklet-wiki --port 6200
```

Then open <http://127.0.0.1:6200/page/Home>. Use a scratch `--data` directory: importing into
your own graph would add these pages to it. `pnpm nooklet` runs the CLI from source with
`packages/server` as its working directory, so the graph path must be absolute — a relative
`docs/wiki` resolves to `packages/server/docs/wiki`, and the importer reports zero pages and no
error for a directory that does not exist. A packaged install uses `nooklet` directly.

## Layout

- `pages/<Page Name>.md` — one page per file. The file name is the page name (`___` stands for
  `/` in a namespaced name; see `packages/core/src/page-name.ts`).
- `logseq/config.edn` — the three keys the importer reads (`parseLogseqConfigEdn`), kept at
  Logseq's defaults so the import emits no warnings.
- `tools/generate-shortcuts.mjs` — regenerates `pages/Keyboard shortcuts.md` from the command
  registrations. Run `node docs/wiki/tools/generate-shortcuts.mjs` after a binding changes.

## Writing rules

- Every line is a `- ` bullet; nest with two spaces; page properties (`type::`, `summary::`,
  `tags::`) sit at the top of the file with no bullet. The grammar is
  `docs/spec/markdown-grammar.md`; the parser that actually reads it is
  `packages/core/src/outline.ts`; the importer is `packages/server/src/importer/logseq.ts`.
  Test against those, not against memory of Logseq.
- Link with `[[Page Name]]`. Pages are grouped by a `tags::` property into `guide`, `reference`
  and `concept`; each of those is itself a page listing its members.
- Everything is derived from the repository (`README.md`, `docs/PLAN.md`, `docs/adr/`,
  `docs/spec/`, `docs/OPERATIONS.md`, `docs/BUGS.md`, the CLI and the source). Where the code and
  the design documents disagree, the code wins and the page says so.
- Short pages that link, not long pages that scroll. Plain and specific, no marketing.

## Checking a change

```sh
rm -rf /tmp/nooklet-wiki
pnpm nooklet import "$PWD/docs/wiki" --data /tmp/nooklet-wiki   # no errors, no warnings, pagesImported > 0
```

A warning about a duplicate page name, an unparseable file, or a dangling `((block ref))` means a
page is wrong; fix the page rather than ignoring the warning.
