/** `/graph` — pages and the links between them (`../views/GraphView.tsx`). */
import type { JSX } from "solid-js";
import { GraphView } from "../views/GraphView.js";

export function GraphRoute(): JSX.Element {
  return <GraphView />;
}
