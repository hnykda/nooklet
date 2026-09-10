/**
 * Route table. `/journals` is the default route (PLAN.md §8). `/page/*name` takes a page name, not
 * an id (a splat so a namespace's "/" survives as real path segments — `../views/navigateTarget.ts`),
 * optionally scoped to one block via `?block=<id>` (zoom, BUILD item 3). `/search` and `/tasks`
 * round out the views. The command palette (Cmd/Ctrl+K), slash menu, autocomplete popups and
 * mobile toolbar are overlays mounted once by `app/CommandLayer.tsx`, not routes of their own.
 */
import "./styles/views.css";
import { Navigate, Route, Router } from "@solidjs/router";
import { CommandLayer } from "./app/CommandLayer.js";
import { JournalsRoute } from "./routes/JournalsRoute.js";
import { PageRoute } from "./routes/PageRoute.js";
import { SearchRoute } from "./routes/SearchRoute.js";
import { TasksRoute } from "./routes/TasksRoute.js";
import { AppShell } from "./shell/AppShell.js";

export function App() {
  return (
    <Router
      root={(routeProps) => (
        // CommandLayer sits inside the Router (it needs `useNavigate`) but outside the routes, so
        // the palette, slash menu, autocomplete popups and mobile toolbar are mounted exactly once
        // and survive navigation.
        <CommandLayer>
          <AppShell>{routeProps.children}</AppShell>
        </CommandLayer>
      )}
    >
      <Route path="/" component={() => <Navigate href="/journals" />} />
      <Route path="/journal/today" component={() => <Navigate href="/journals" />} />
      <Route path="/journals" component={JournalsRoute} />
      <Route path="/page/*name" component={PageRoute} />
      <Route path="/search" component={SearchRoute} />
      <Route path="/tasks" component={TasksRoute} />
    </Router>
  );
}
