/**
 * `/page/*name` (a page name, not an id — refs navigate by name, PLAN.md §4) and its zoom variant
 * `/page/*name?block=<id>` (BUILD item 3). The splat param keeps a namespace name's "/" as real
 * path segments; see `../views/navigateTarget.ts` for the encode/decode half of this contract.
 */
import { useParams, useSearchParams } from "@solidjs/router";
import type { JSX } from "solid-js";
import { PageView } from "../views/PageView.js";
import { pathToPageName } from "./page-path.js";

export function PageRoute(): JSX.Element {
  const params = useParams<{ name: string }>();
  const [searchParams] = useSearchParams<{ block?: string }>();

  return (
    <PageView
      name={() => pathToPageName(params.name)}
      blockId={() => searchParams.block || undefined}
    />
  );
}
