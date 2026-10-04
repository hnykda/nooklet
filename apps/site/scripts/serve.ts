/**
 * A minimal static server over `out/`, for local checks and the site's Playwright tests.
 *
 * It resolves paths the way the production server must (nginx:
 * `try_files $uri $uri.html $uri/index.html =404;` with `error_page 404 /404.html;`):
 * the exact file, then `<path>.html`, then `<path>/index.html`, else `404.html` with status 404.
 *
 *   node scripts/serve.ts [dir=out] [port=6446]
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "out");
const port = Number(process.argv[3] ?? process.env.PORT ?? 6446);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

function isFile(p: string): boolean {
  return existsSync(p) && statSync(p).isFile();
}

function resolvePath(urlPath: string): string | null {
  const clean = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  const base = join(root, clean);
  if (!base.startsWith(root)) return null;
  for (const candidate of [base, `${base}.html`, join(base, "index.html")]) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const file = resolvePath(url.pathname);
  const target = file ?? join(root, "404.html");
  res.writeHead(file ? 200 : 404, {
    "content-type": TYPES[extname(target)] ?? "application/octet-stream",
  });
  createReadStream(target).pipe(res);
}).listen(port, "127.0.0.1", () => {
  console.log(`serving ${root} on http://127.0.0.1:${port}`);
});
