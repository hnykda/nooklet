/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** Base URL for the sync server; empty for same-origin (the default self-hosted setup). */
  readonly VITE_SYNC_BASE_URL?: string;
  /** Base URL for the HTTP API (`/api/v1/*`); defaults to VITE_SYNC_BASE_URL (same origin/server) —
   * see `data/api-client.ts`. Only the views agent's search/backlinks calls use this today. */
  readonly VITE_API_BASE_URL?: string;
  /** Dev-only bearer token for `/api/v1/*` calls until device pairing (PLAN.md §6) ships a real
   * token flow. See `data/api-client.ts`. */
  readonly VITE_NOOKLET_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Injected by `vite.config.ts` — see `shell/HelpMenu.tsx`. */
declare const __APP_VERSION__: string;
