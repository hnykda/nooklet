/** `/pages` — every page in the graph (`../views/AllPagesView.tsx`). */
import type { JSX } from "solid-js";
import { AllPagesView } from "../views/AllPagesView.js";

export function PagesRoute(): JSX.Element {
  return <AllPagesView />;
}
