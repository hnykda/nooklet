/**
 * Runs after `next build`: writes each page's raw markdown twin next to its HTML, so
 * `out/docs/sync-and-offline.html` gets `out/docs/sync-and-offline.md`.
 *
 * This is a script rather than a route handler because Next cannot put a route handler and a page
 * on the same dynamic segment (`app/docs/[slug]/page.tsx` already owns `/docs/<slug>`), and a
 * segment named `[slug].md` is not a dynamic segment at all. Everything else plain-text
 * (`llms.txt`, `llms-full.txt`, the search index) is a normal static route handler.
 *
 * Plain Node TypeScript (type stripping): `node scripts/emit-raw.ts`.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allPages, pageUrl, rawMarkdown } from "../lib/source.ts";

const out = join(process.cwd(), "out");
if (!existsSync(out)) {
  console.error("emit-raw: no out/ directory; run `next build` first");
  process.exit(1);
}

const { docs, decisions } = allPages();
let n = 0;
for (const page of [...docs, ...decisions]) {
  const file = join(out, `${pageUrl(page).slice(1)}.md`);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, rawMarkdown(page));
  n++;
}
console.log(`emit-raw: wrote ${n} markdown pages into out/`);
