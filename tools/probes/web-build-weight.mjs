// Probe: how heavy is a production web build, and how much of it does the service worker precache?
// Settled the cost of bundling mermaid into the mermaid plugin's client half (ADR 023): run it
// against a build before and after, e.g.
//   pnpm --filter @nooklet/web build && node tools/probes/web-build-weight.mjs
// Prints total JS/CSS bytes on disk, the startup entry chunk, the precache manifest's entry count
// and byte total (every URL `sw.js` precaches, resolved against dist/), and the chunks whose file
// name matches an optional pattern (default: mermaid's own and its biggest dependencies).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const dist = new URL("../../apps/web/dist/", import.meta.url).pathname;
const pattern = new RegExp(process.argv[2] ?? "mermaid|cytoscape|katex|dagre|elk|flowDiagram");

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = walk(dist);
const size = (p) => statSync(p).size;
const kib = (n) => `${(n / 1024).toFixed(1)} KiB`;
const js = files.filter((f) => f.endsWith(".js"));
const css = files.filter((f) => f.endsWith(".css"));

const html = readFileSync(join(dist, "index.html"), "utf8");
const entry = /src="\/(static\/index-[^"]+\.js)"/.exec(html)?.[1];

const sw = readFileSync(join(dist, "sw.js"), "utf8");
const urls = [...sw.matchAll(/url:"([^"]+)"/g)].map((m) => m[1]);
let precacheBytes = 0;
for (const u of urls) {
  try {
    precacheBytes += size(join(dist, u));
  } catch {
    // generated entries (e.g. the registerSW script) that are not files on disk
  }
}

const matching = js.filter((f) => pattern.test(f)).sort((a, b) => size(b) - size(a));
console.log(`dist: ${dist}`);
console.log(`js files: ${js.length}, ${kib(js.reduce((n, f) => n + size(f), 0))}`);
console.log(`css files: ${css.length}, ${kib(css.reduce((n, f) => n + size(f), 0))}`);
console.log(`startup entry: ${entry} ${entry ? kib(size(join(dist, entry))) : "?"}`);
console.log(`precache: ${urls.length} entries, ${kib(precacheBytes)}`);
console.log(
  `chunks matching ${pattern}: ${matching.length}, ${kib(matching.reduce((n, f) => n + size(f), 0))}`,
);
for (const f of matching.slice(0, 8)) console.log(`  ${f.slice(dist.length)} ${kib(size(f))}`);
