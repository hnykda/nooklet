/** R54: the slash-menu item list, in default (no-query) order. */
import type { SlashItem } from "../types.js";

export const SLASH_ITEMS: readonly SlashItem[] = [
  { label: "TODO / task", command: "task.setMarkerTodo", keywords: ["task", "checkbox", "marker"] },
  { label: "Heading 1", command: "block.setHeading1", keywords: ["h1", "title"] },
  { label: "Heading 2", command: "block.setHeading2", keywords: ["h2", "subtitle"] },
  { label: "Heading 3", command: "block.setHeading3", keywords: ["h3"] },
  { label: "Numbered list", command: "block.toggleNumberedList", keywords: ["ordered", "1."] },
  { label: "Code block", command: "block.insertCodeFence", keywords: ["code", "fence", "```"] },
  { label: "Table", command: "block.insertTable", keywords: ["grid"] },
  { label: "Image", command: "block.insertImage", keywords: ["picture", "photo", "upload"] },
  { label: "Scheduled", command: "task.setScheduled", keywords: ["date", "when", "plan"] },
  { label: "Deadline", command: "task.setDeadline", keywords: ["date", "due"] },
  { label: "Embed page", command: "block.embedPage", keywords: ["transclude"] },
  { label: "Embed block", command: "block.embedBlock", keywords: ["transclude", "ref"] },
  {
    label: "Page reference",
    command: "format.insertPageRef",
    keywords: ["link", "wikilink", "[["],
  },
  { label: "Tag", command: "format.insertTag", keywords: ["#"] },
  { label: "Today's date", command: "block.insertToday", keywords: ["journal", "now"] },
  { label: "Property", command: "block.insertProperty", keywords: ["metadata", "::"] },
  // ADR 019: core, not a plugin — opens a second-level picker for which template.
  { label: "Template", command: "block.insertTemplate", keywords: ["snippet", "insert", "tpl"] },
  // ADR 011: a ```query fence skeleton; the block's existing text becomes the query.
  {
    label: "Query",
    command: "block.insertQueryFence",
    keywords: ["query", "filter", "tasks", "search", "```query"],
  },
];
