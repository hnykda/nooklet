/**
 * The nooklet version this server reports: `nooklet --version`, the `serve` banner, and the MCP
 * server's `Implementation.version` (B-696 — it used to be a hard-coded `"0.0.1"` default).
 *
 * Read from this package's own `package.json`, which `tools/release.mjs` bumps with every other
 * workspace package. An import rather than a `readFileSync` relative to this file: the desktop app
 * and the Docker image run an esbuild bundle (`apps/desktop/build-sidecar.mjs`) where no
 * `package.json` sits next to the code, and esbuild inlines a JSON import at build time.
 *
 * Deliberately NOT on the unauthenticated `/healthz` (docs/spec/security-inventory.md): an exact
 * version on a public probe tells a scanner which known bugs to try.
 */
import pkg from "../package.json" with { type: "json" };

export const NOOKLET_VERSION: string = pkg.version;
