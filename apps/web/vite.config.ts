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
      registerType: "prompt",
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
    environmentMatchGlobs: [["src/**/*.test.tsx", "jsdom"]],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
