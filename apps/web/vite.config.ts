import { readFileSync } from "node:fs";
import type { Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";
import { emojiDataPlugin } from "./src/emoji/build-data.js";
import { lazyOnlyChunks } from "./src/sw/lazy-only-chunks.js";

/** The one release version (`tools/release.mjs` writes it into every package.json). Read, not
 * hard-coded: a literal here said "0.1.0" while every package said something else, so the help
 * menu would have named the wrong build in every bug report after the first release. */
const APP_VERSION: string = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).version;

/**
 * mermaid's chunks, filled in by `mermaidChunks()` when Rollup has the bundle and read by the
 * workbox `manifestTransforms` below, which runs later (vite-plugin-pwa generates the service
 * worker after the bundle is written).
 */
const notPrecached = new Set<string>();

/** Finds the chunks only mermaid's lazy import reaches (`src/sw/lazy-only-chunks.ts`). Fails
 * the build when it finds no mermaid at all: a rename upstream would otherwise silently put ~6 MB
 * back into every install. */
function mermaidChunks(): Plugin {
  return {
    name: "nooklet:mermaid-chunks",
    apply: "build",
    generateBundle(_options, bundle) {
      notPrecached.clear();
      const chunks = Object.values(bundle).flatMap((o) => (o.type === "chunk" ? [o] : []));
      const { roots, lazyOnly } = lazyOnlyChunks(chunks, (c) =>
        /[\\/]node_modules[\\/]mermaid[\\/]/.test(c.facadeModuleId ?? ""),
      );
      if (roots.length === 0) {
        this.error("no mermaid dynamic-entry chunk in the bundle — is it still imported lazily?");
      }
      for (const name of lazyOnly) notPrecached.add(name);
    },
  };
}

// sqlite-wasm ships its own worker/wasm loading dance and must never be pre-bundled by esbuild
// (research/08 §1.2 / sqlite.org/wasm persistence.md); `worker.format: 'es'` is required for the
// dedicated worker (`db/db.worker.ts`) to use `import`/Comlink instead of classic-worker `importScripts`.
export default defineConfig({
  // Surfaced in the help menu so a bug report can name its build without anyone remembering.
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  plugins: [
    solid(),
    mermaidChunks(),
    // The page-icon picker's emoji list (B-647): its own lazy chunk, and precached on purpose —
    // ~38 KB gzipped, and an empty picker on a phone that first opens it offline is worse.
    emojiDataPlugin(),
    VitePWA({
      // generateSW (not injectManifest): this milestone needs offline precaching of the app
      // shell only, nothing custom (no push/share-target handler yet — that's later work, and it
      // would be the trigger to switch to injectManifest + hand-written SW + workbox-* runtime
      // deps). generateSW needs no extra runtime dependencies, keeping the dependency list tight.
      // autoUpdate, NOT "prompt": with "prompt" the app only updates if something calls the
      // update function, and `sw/register.ts` merely logged to the console — so a browser stayed
      // pinned to the first build it ever cached and every subsequent fix was invisible to it.
      // For a self-hosted app the client should match the server it is talking to.
      registerType: "autoUpdate",
      injectRegister: false,
      manifest: false, // we ship public/manifest.webmanifest directly
      workbox: {
        // Both explicit, and both load-bearing (B-532). autoUpdate means "a new worker takes over
        // and the page reloads onto it" — but the plugin only turns these two on for autoUpdate
        // when `injectRegister` is "auto"/unset, and ours is `false`. Without them the new worker
        // installed and then WAITED for every page to close: the desktop app ran the previous
        // client for a whole session after each update, and a tab left open never updated at all.
        // The reload itself is `virtual:pwa-register`'s, on the new worker's `activated`.
        skipWaiting: true,
        clientsClaim: true,
        globPatterns: ["**/*.{js,css,html,svg,woff2,wasm}"],
        // mermaid is NOT precached: ~6 MB every install downloaded for a feature most pages never
        // use (ADR 023 §Consequences). Its chunks load on the first diagram, and the `/static/`
        // runtime rule below keeps them for offline use from then on.
        manifestTransforms: [
          async (entries) => ({
            manifest: entries.filter((e) => !notPrecached.has(e.url)),
            warnings: [],
          }),
        ],
        maximumFileSizeToCacheInBytes: 6_000_000,
        // `(\/g\/[^/]+)?` (ADR 025): a graph is served at `/g/<slug>/...`, not bare root, so an
        // API/sync/asset request carries that prefix too — matching only the bare form left these
        // patterns unable to recognize a single real request once a graph existed, silently
        // letting the SW's default navigate-fallback/precache handling see them instead of the
        // NetworkOnly/CacheFirst rules below.
        navigateFallbackDenylist: [/^(\/g\/[^/]+)?\/(api|sync)\//],
        runtimeCaching: [
          // A FUNCTION, not a RegExp: workbox tests a RegExp route against the full `url.href`,
          // so the `^\/`-anchored patterns below never match anything (B-401). Hashed build output
          // the precache does not hold — mermaid's chunks — is kept after its first load, so a
          // diagram seen once still renders offline. Precached files never reach this route (the
          // precache route is registered first). Hashed names are immutable, hence CacheFirst;
          // the expiry only bounds what superseded builds leave behind.
          //
          // With or without the graph prefix (ADR 025), like the rules below: a document loaded
          // from the network at `/g/<slug>/…` asks for `/g/<slug>/static/…`, which a bare
          // `startsWith("/static/")` never matched, so those chunks were offline only while the
          // HTTP cache still held them (the intermittent `mermaid-lazy-cache.spec.ts` failure).
          {
            urlPattern: ({ url, sameOrigin }) =>
              sameOrigin && /^(\/g\/[^/]+)?\/static\//.test(url.pathname),
            handler: "CacheFirst",
            options: {
              cacheName: "lazy-chunks",
              expiration: { maxEntries: 300, maxAgeSeconds: 90 * 86400 },
            },
          },
          { urlPattern: /^(\/g\/[^/]+)?\/(api|sync)\//, handler: "NetworkOnly" },
          {
            urlPattern: /^(\/g\/[^/]+)?\/assets\//,
            handler: "CacheFirst",
            options: {
              cacheName: "assets",
              expiration: { maxEntries: 500, maxAgeSeconds: 30 * 86400 },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    // NOT Vite's default "assets": when the server hosts this build on its own origin
    // (`packages/server/src/http/web-client.ts`), `/assets/*` is already taken by the graph's own
    // asset route (`GET /assets/:id`, ADR 013). Hashed build output lives under `/static/*`
    // instead, which is also the prefix that gets `immutable` caching.
    assetsDir: "static",
  },
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
  worker: {
    format: "es",
  },
  test: {
    environment: "node",
    // Component tests (views/*.test.tsx) need a DOM; everything else (the vast majority: pure
    // logic, worker-core, sync-client) stays on the fast "node" environment above.
    // `environmentMatchGlobs` was removed in Vitest 5 — each *.test.tsx file instead opens with a
    // `// @vitest-environment jsdom` docblock (still supported, see vitest.dev/guide/environment).
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
