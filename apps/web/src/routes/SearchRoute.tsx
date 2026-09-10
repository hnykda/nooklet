/**
 * Search (BUILD item 4; PLAN.md §9) — see `../views/SearchView.tsx`. The command palette is a
 * separate, still-unbuilt surface owned by another agent (ADR 009); this route is full-text/
 * semantic/hybrid search with a persistent results panel (docs/spec/commands-and-keymap.md R44).
 */
import type { JSX } from "solid-js";
import { SearchView } from "../views/SearchView.js";

export function SearchRoute(): JSX.Element {
  return <SearchView />;
}
