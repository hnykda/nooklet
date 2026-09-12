type:: hub
summary:: Pages that walk you through doing something.

- Pages carrying `tags:: guide`:
  - [[Home]] · [[Getting started]] · [[Journals]] · [[Tasks]] · [[References and tags]] · [[Search]] · [[Settings]] · [[Sync]] · [[Agents and MCP]] · [[Import from Logseq]] · [[Troubleshooting]] · [[Contributing]] · [[FAQ]]
- The other families: [[reference]] and [[concept]].
- A `tags::` page property is indexed on the server (`page_tag`, ADR 017): `page_list({tag: "guide"})` over the API returns these pages. ADR 017 also says `page_backlinks` gains a `tagged_pages` group and a tag page lists its members; as of 2026-09-12 neither the server op nor the app does this, which is why the members are listed here by hand.
