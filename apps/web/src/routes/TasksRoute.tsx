/** Tasks view (BUILD item 5; PLAN.md §8) — see `../views/TasksView.tsx`. */
import type { JSX } from "solid-js";
import { TasksView } from "../views/TasksView.js";

export function TasksRoute(): JSX.Element {
  return <TasksView />;
}
