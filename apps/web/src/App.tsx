/**
 * Route table. `/journals` is the default route (PLAN.md §8). `/page/*name` takes a page name, not
 * an id (a splat so a namespace's "/" survives as real path segments — `../views/navigateTarget.ts`),
 * optionally scoped to one block via `?block=<id>` (zoom, BUILD item 3). `/search` and `/tasks`
 * round out the views this task owns; the command palette (Cmd/Ctrl+K) is a separate, still-unbuilt
 * overlay another agent owns (ADR 009) and does not need a route of its own.
 */
import "./styles/views.css";
import { Navigate, Route, Router } from "@solidjs/router";
import { JournalsRoute } from "./routes/JournalsRoute.js";
import { PageRoute } from "./routes/PageRoute.js";
import { SearchRoute } from "./routes/SearchRoute.js";
import { TasksRoute } from "./routes/TasksRoute.js";
import { AppShell } from "./shell/AppShell.js";

export function App() {
  return (
    <Router root={AppShell}>
      <Route path="/" component={() => <Navigate href="/journals" />} />
      <Route path="/journal/today" component={() => <Navigate href="/journals" />} />
      <Route path="/journals" component={JournalsRoute} />
      <Route path="/page/*name" component={PageRoute} />
      <Route path="/search" component={SearchRoute} />
      <Route path="/tasks" component={TasksRoute} />
    </Router>
  );
}
