/**
 * Route table. `/journals` is the default route (PLAN.md §8). `/page/*name` takes a page name, not
 * an id (a splat so a namespace's "/" survives as real path segments — `../views/navigateTarget.ts`),
 * optionally scoped to one block via `?block=<id>` (zoom, BUILD item 3). `/search` and `/tasks`
 * round out the views. The command palette (Cmd/Ctrl+K), slash menu, autocomplete popups and
 * mobile toolbar are overlays mounted once by `app/CommandLayer.tsx`, not routes of their own.
 *
 * `/capture` (PLAN.md §14, M5 BUILD item 3) is deliberately NOT wrapped in `CommandLayer`/
 * `AppShell`: quick capture must open fast and never load the graph, so it skips the palette/
 * slash-menu/toolbar machinery and the outliner entirely — see `routes/CaptureRoute.tsx` and
 * `views/CaptureView.tsx`. The router's `root` below is the one place that can make that call,
 * since it wraps every route uniformly by default.
 */
import "./styles/views.css";
import { Navigate, Route, Router, type RouteSectionProps } from "@solidjs/router";
import type { JSX } from "solid-js";
import { CommandLayer } from "./app/CommandLayer.js";
import { CaptureRoute } from "./routes/CaptureRoute.js";
import { JournalsRoute } from "./routes/JournalsRoute.js";
import { PageRoute } from "./routes/PageRoute.js";
import { SearchRoute } from "./routes/SearchRoute.js";
import { TasksRoute } from "./routes/TasksRoute.js";
import { AppShell } from "./shell/AppShell.js";

function RouterRoot(routeProps: RouteSectionProps): JSX.Element {
  if (routeProps.location.pathname === "/capture") return <>{routeProps.children}</>;
  // CommandLayer sits inside the Router (it needs `useNavigate`) but outside the routes, so the
  // palette, slash menu, autocomplete popups and mobile toolbar are mounted exactly once and
  // survive navigation.
  return (
    <CommandLayer>
      <AppShell>{routeProps.children}</AppShell>
    </CommandLayer>
  );
}

export function App() {
  return (
    <Router root={RouterRoot}>
      <Route path="/" component={() => <Navigate href="/journals" />} />
      <Route path="/journal/today" component={() => <Navigate href="/journals" />} />
      <Route path="/journals" component={JournalsRoute} />
      <Route path="/page/*name" component={PageRoute} />
      <Route path="/search" component={SearchRoute} />
      <Route path="/tasks" component={TasksRoute} />
      <Route path="/capture" component={CaptureRoute} />
    </Router>
  );
}
