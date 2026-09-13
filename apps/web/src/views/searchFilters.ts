/**
 * The Search view's task / kind / journal filters (audit §2 #11) → the `search` op's `properties`,
 * `scope` and `journals_only`. Pure, so the one rule with a reason behind it is testable: a task
 * marker belongs to a block, so choosing one searches blocks only — with `scope: "all"` the page
 * hits, which the marker filter does not apply to, came back alongside the tasks.
 */

import { TASK_MARKERS, type TaskMarker } from "@nooklet/core";
import type { SearchInput } from "../data/api-client.js";

export const SEARCH_MARKERS: readonly TaskMarker[] = TASK_MARKERS;

export type SearchKind = "all" | "blocks" | "pages";

export interface SearchFilterChoice {
  /** `""` for any. */
  marker: TaskMarker | "";
  kind: SearchKind;
  journalsOnly: boolean;
}

export const NO_SEARCH_FILTERS: SearchFilterChoice = {
  marker: "",
  kind: "all",
  journalsOnly: false,
};

export function searchFilterInput(
  choice: SearchFilterChoice,
): Pick<SearchInput, "scope" | "properties" | "journalsOnly"> {
  const out: Pick<SearchInput, "scope" | "properties" | "journalsOnly"> = {
    scope: choice.marker !== "" ? "blocks" : choice.kind,
  };
  if (choice.marker !== "") out.properties = { marker: choice.marker };
  if (choice.journalsOnly) out.journalsOnly = true;
  return out;
}
