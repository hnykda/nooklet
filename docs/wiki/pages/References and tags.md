type:: guide
summary:: Links, tags, block references, embeds, the linked and unlinked references panel, page-level tags, namespaces, and renaming.
tags:: guide

- ## Writing a reference
  - `[[Page]]` links to a page; a page that does not exist yet is created when you first open it and type. Typing `[[` opens a picker over page names and aliases, accent-insensitive, with a "Create" row when nothing matches exactly.
  - `#tag` and `#[[multi word tag]]` reference a page the same way; only the rendering differs. A tag is a page (ADR 017), so typing `#` offers every page.
  - `((id))` references a block and renders as that block's text, not its id. Typing `((` searches block text in the local replica; Cmd/Ctrl+Shift+C copies the reference of the block you are in.
  - `{{embed [[Page]]}}` and `{{embed ((id))}}` render the target in place, editable (slash menu: Embed page, Embed block).
  - `[label]([[Page]])`, Logseq's labelled link, is also a reference. Plain `[text](url)` links, bare URLs and images are not.
  - `[[Page|shown text]]` (Obsidian's alias form) is accepted on paste and renders with the shown text, but is indexed under the key `page|shown text`: it is not counted as a backlink and a rename does not rewrite it (B-86, open as of 2026-09-12).
- ## Linked and unlinked references
  - Every page ends with its linked references: blocks anywhere that reference it, grouped by source page, most recently edited page first. A block counts if it or any ancestor references the page (`path_refs`), so a child of a bullet that says `[[Aurora]]` is listed under Aurora too. Aliases count in both directions.
  - Unlinked references are full-text hits for the page's name and aliases in blocks that do not already link to it. **Link all** turns them into `[[links]]` in one batch with an Undo (`mentions_link` and `batch_undo` over the API).
  - The linked half has a filter popover listing the other pages the referencing blocks mention — click to include, again to exclude, again to clear — and a recent/by-name sort. The choice is remembered per device.
  - Both halves collapse and remember their state for the session. A page with nothing to show has no panel at all.
  - The panel is answered by the server (`page_backlinks`), because the reference index is server-only. A link typed a moment ago appears once the write has been pushed (B-83).
- ## Page-level tags
  - `tags:: person, czech` at the top of a page tags the page itself. The server indexes these in `page_tag` (ADR 017): `page_list({tag: "person"})` returns the pages, and `art`, `Art`, `#art` and `[[Art]]` are one tag (B-62). Every journal carries an intrinsic `Journal` tag that cannot be removed.
  - Not built: ADR 017 says `page_backlinks` gains a `tagged_pages` group and that a tag page lists its members. As of 2026-09-12 neither the server op nor the app does this; this wiki's [[guide]], [[reference]] and [[concept]] pages list their members by hand.
- ## Namespaces
  - `Projects/Aurora` is a page inside `Projects`. The parent page shows its children as a tree, the breadcrumb shows the path, and lists show the short form. Ancestors exist for navigation without being created as pages.
- ## Renaming, merging, moving
  - Renaming a page (edit its title) rewrites `[[links]]` to it across the graph and keeps you on the page under its new name (B-78). Over the API, `page_update` with `keep_alias` keeps the old name as an alias so old links keep resolving.
  - `page_merge` folds one page into another, `block_to_page` turns a block into a page, `block_move_to_page` moves a subtree to another page — the M7 refactor tools (ADR 020), available over the API and MCP. See [[Agents and MCP]].
