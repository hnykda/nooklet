import type { NextConfig } from "next";

const config: NextConfig = {
  // A plain static export: `out/` is the whole site, servable by any static file server.
  output: "export",
  // `/docs/sync` is written as `out/docs/sync.html`, so the raw markdown twin can sit next to it as
  // `out/docs/sync.md` (the llms.txt convention: "the page URL with .md appended"). With
  // `trailingSlash: true` the page would be `docs/sync/index.html` and the twin would have to be
  // `docs/sync/index.html.md`, which nobody guesses. The cost: the static server must map
  // `/docs/sync` to `docs/sync.html` (nginx `try_files $uri $uri.html $uri/ =404;`). README.md
  // documents this, and `scripts/serve.ts` does the same thing for local checks.
  trailingSlash: false,
  images: { unoptimized: true },
  // The repo runs TypeScript 7 (the native compiler), which no longer ships the JS API that
  // `next build`'s built-in type check loads. `pnpm --filter @nooklet/site typecheck` runs `tsc`
  // directly instead, and `pnpm -r typecheck` covers it in CI.
  typescript: { ignoreBuildErrors: true },
  poweredByHeader: false,
  reactStrictMode: true,
};

export default config;
