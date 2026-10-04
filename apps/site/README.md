# @nooklet/site

The public site at <https://nooklet.danielalder.cz>: the landing page, the user guide, and the
design decisions. A Next.js App Router project built as a plain static export.

## Build

| | |
|---|---|
| Node | 24 or newer (the repo's `engines`; developed on 26). The scripts run `.ts` files through Node's built-in type stripping. |
| Install | `pnpm install` at the repository root |
| Build | `pnpm --filter @nooklet/site build` |
| Output | `apps/site/out/`, about 9 MB uncompressed (2.7 MB of it HTML, 0.9 MB screenshots, 1.2 MB JS/CSS/fonts, the rest Next's RSC payloads) |
| Network at build time | `next/font` downloads Familjen Grotesk and Literata from Google Fonts once and self-hosts them in `out/_next/static/media/` |

The build reads `docs/guide/*.md` and `docs/adr/*.md` from the repository, so the Docker context
must contain `docs/` as well as `apps/site/`. It fails if `docs/guide` is missing or empty.

`build` is `next build` followed by `scripts/emit-raw.ts`, which writes each page's markdown twin
(`out/docs/<slug>.md`) next to its HTML. Next cannot emit those itself: a route handler cannot share
a dynamic segment with a page.

## Serving

Serve `out/` at the domain root. Pages are written as `docs/sync-and-offline.html` (no trailing
slash), so the server must try `<path>.html`. The 404 page is `404.html`. For nginx:

```nginx
root /usr/share/nginx/html;
location / {
  try_files $uri $uri.html $uri/index.html =404;
}
error_page 404 /404.html;

types {
  text/markdown md;
}
charset utf-8;
charset_types text/markdown text/plain application/json;

# Hashed assets never change.
location /_next/static/ {
  add_header Cache-Control "public, max-age=31536000, immutable";
}
```

Content types the site relies on: `.md` as `text/markdown`, `.txt` as `text/plain`, `og.png` as
`image/png`, `search-index.json` as `application/json`.

`pnpm --filter @nooklet/site serve` runs `scripts/serve.ts`, a tiny server with the same lookup
rules on `127.0.0.1:6446`, for local checks.

## Where things come from

| URL | Source |
|---|---|
| `/` | `app/page.tsx` |
| `/docs/<slug>` | `docs/guide/<slug>.md`, ordered by the `order` front-matter field |
| `/decisions/<NNN-name>` | `docs/adr/NNN-name.md` |
| `/<page>.md` | the same file, front matter removed, links made absolute |
| `/llms.txt`, `/llms-full.txt` | `lib/llms.ts`, per <https://llmstxt.org> |
| `/search-index.json` | `lib/search-index.ts`: a MiniSearch index, one document per h2/h3 section |
| `/og.png`, `/icon.svg`, `/sitemap.xml`, `/robots.txt` | `app/` |

Links between guide pages are written GitHub-style (`security.md#tokens-and-scopes`) and rewritten
to site URLs; links to other repository files point at GitHub.

### Animations

A guide page embeds an animation with an `animation-spec` fence. The site matches the spec's `id`,
or else its `title`, against `components/sync/registry.tsx`. A spec with no drawing renders as a
described placeholder and the build logs `site: no animation drawn for animation-spec …`. The
figures step on a timer only while on screen, start at their end state and stay still under
`prefers-reduced-motion`, and always have pause and step buttons.

### Screenshots

`public/screenshots/*.png` come from the real app running on `demo-graph/` (invented notes):

```sh
pnpm --filter @nooklet/web build
pnpm --filter @nooklet/site screenshots
```

## Tests

```sh
pnpm --filter @nooklet/site build
pnpm --filter @nooklet/site e2e     # Chromium at 1440 px and on a Pixel 7 viewport
```
