/** R54: the slash-menu item list, in default (no-query) order. */
import type { TaskWorkflow } from "@nooklet/core";
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
  // B-608: the rest of both task pairs, as in Logseq's slash menu. Last, so the long-standing
  // order above is unchanged; typed (`/later`, `/now`) they rank by label like any row.
  { label: "DOING", command: "task.setMarkerDoing", keywords: ["task", "started"] },
  { label: "LATER", command: "task.setMarkerLater", keywords: ["task", "someday"] },
  { label: "NOW", command: "task.setMarkerNow", keywords: ["task", "started"] },
];

const TODO_ROW = SLASH_ITEMS[0] as SlashItem;
const LATER_ROW: SlashItem = {
  label: "LATER / task",
  command: "task.setMarkerLater",
  keywords: TODO_ROW.keywords,
};

const TASK_TAIL = new Set(["task.setMarkerDoing", "task.setMarkerLater", "task.setMarkerNow"]);

function row(command: string): SlashItem {
  return SLASH_ITEMS.find((i) => i.command === command) as SlashItem;
}

/**
 * B-608: R54's list for a graph's workflow. `todo` is `SLASH_ITEMS` as is. `now` mirrors Logseq's
 * `commands.cljs#get-preferred-workflow` (the preferred pair first): the first row becomes
 * `LATER / task`, and the trailing task rows become NOW, TODO, DOING.
 */
export function slashItemsFor(workflow: TaskWorkflow): readonly SlashItem[] {
  if (workflow === "todo") return SLASH_ITEMS;
  const middle = SLASH_ITEMS.slice(1).filter((i) => !TASK_TAIL.has(i.command));
  return [
    LATER_ROW,
    ...middle,
    row("task.setMarkerNow"),
    { label: "TODO", command: "task.setMarkerTodo", keywords: ["task"] },
    row("task.setMarkerDoing"),
  ];
}
