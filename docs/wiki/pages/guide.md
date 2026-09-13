type:: hub
summary:: Pages that walk you through doing something.

- Pages carrying `tags:: guide`:
  - [[Home]] · [[Getting started]] · [[Journals]] · [[Tasks]] · [[References and tags]] · [[Search]] · [[Settings]] · [[Sync]] · [[Agents and MCP]] · [[Import from Logseq]] · [[Troubleshooting]] · [[Contributing]] · [[FAQ]]
- The other families: [[reference]] and [[concept]].
- A `tags::` page property is indexed on the server (`page_tag`, ADR 017): `page_list({tag: "guide"})` over the API returns these pages. In the app this page's references panel lists them under **Pages tagged guide** (`page_backlinks`' `tagged_pages`, B-111); the list above is kept by hand for readers of the Markdown files.
