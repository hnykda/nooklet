import { VitePWA } from "vite-plugin-pwa";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

// sqlite-wasm ships its own worker/wasm loading dance and must never be pre-bundled by esbuild
// (research/08 §1.2 / sqlite.org/wasm persistence.md); `worker.format: 'es'` is required for the
// dedicated worker (`db/db.worker.ts`) to use `import`/Comlink instead of classic-worker `importScripts`.
export default defineConfig({
  plugins: [
    solid(),
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
        globPatterns: ["**/*.{js,css,html,svg,woff2,wasm}"],
        maximumFileSizeToCacheInBytes: 6_000_000,
        navigateFallbackDenylist: [/^\/(api|sync)\//],
        runtimeCaching: [
          { urlPattern: /^\/(api|sync)\//, handler: "NetworkOnly" },
          {
            urlPattern: /^\/assets\//,
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
