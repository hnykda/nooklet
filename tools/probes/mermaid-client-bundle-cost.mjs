// Probe: what does the SERVER pay to bundle the mermaid plugin's client half the way
// `packages/server/src/plugins/bundler.ts#bundleClientEntry` does (one file, no splitting, no
// minify)? This number is why `PluginHost` stopped bundling client halves at activation (ADR 023).
//   node tools/probes/mermaid-client-bundle-cost.mjs
// Measured 2026-09-13: a bare `import("mermaid")` entry, 12.06 MB, 235-610 ms over three runs (load
// not recorded); the real plugin entry, 12.02 MB, 572-657 ms at load average 20 on 14 cores.
import { createRequire } from "node:module";

const root = new URL("../../", import.meta.url).pathname;
const require = createRequire(`${root}packages/server/package.json`);
const esbuild = require("esbuild");

for (let run = 0; run < 3; run++) {
  const t0 = performance.now();
  const result = await esbuild.build({
    entryPoints: [`${root}plugins/mermaid/src/client.ts`],
    outfile: "client.js",
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    write: false,
    logLevel: "error",
  });
  const bytes = result.outputFiles.reduce((n, f) => n + f.contents.byteLength, 0);
  console.log(
    `run ${run}: ${Math.round(performance.now() - t0)} ms, ${(bytes / 1e6).toFixed(2)} MB`,
  );
}
