import MiniSearch from "minisearch";
import { renderPage } from "./render.ts";
import { SEARCH_OPTIONS, type SearchDoc } from "./search-options.ts";
import { allPages, pageUrl } from "./source.ts";

/**
 * One search document per section (the text under each h2/h3), so a hit links straight to the
 * heading that matched instead of the top of a long page.
 */
export async function buildSearchIndex(): Promise<string> {
  const { docs, decisions } = allPages();
  const items: SearchDoc[] = [];
  for (const page of [...docs, ...decisions]) {
    const { sections } = await renderPage(page);
    const base = pageUrl(page);
    const title = page.collection === "decisions" ? `ADR ${page.order}: ${page.title}` : page.title;
    for (const s of sections) {
      items.push({
        id: `${base}#${s.anchor}`,
        url: s.anchor ? `${base}#${s.anchor}` : base,
        page: title,
        heading: s.heading,
        // Long ADR sections would bloat the download; the first 1,500 characters carry the terms
        // people search for and are plenty for a two-line snippet.
        text: s.text.slice(0, 1500),
        collection: page.collection,
      });
    }
  }
  const ms = new MiniSearch<SearchDoc>(SEARCH_OPTIONS);
  ms.addAll(items);
  return JSON.stringify(ms);
}
