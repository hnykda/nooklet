/**
 * Route table. `/journals` is the default route (PLAN.md §8). `/page/*name` takes a page name, not
 * an id (a splat so a namespace's "/" survives as real path segments — `./routes/page-path.ts`),
 * optionally scoped to one block via `?block=<id>` (zoom, BUILD item 3). `/search`, `/tasks` and
 * `/graph` round out the views. The command palette (Cmd/Ctrl+K), slash menu, autocomplete popups and
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
import { createSignal, type JSX, Show } from "solid-js";
import { CommandLayer } from "./app/CommandLayer.js";
import { bootstrapConfig, samePathGraphPrefix } from "./data/bootstrap.js";
import { platform } from "./platform/index.js";
import { CaptureRoute } from "./routes/CaptureRoute.js";
import { GraphRoute } from "./routes/GraphRoute.js";
import { JournalsRoute } from "./routes/JournalsRoute.js";
import { PageRoute } from "./routes/PageRoute.js";
import { PagesRoute } from "./routes/PagesRoute.js";
import { SearchRoute } from "./routes/SearchRoute.js";
import { TasksRoute } from "./routes/TasksRoute.js";
import { AppShell } from "./shell/AppShell.js";
import { ConnectView } from "./views/ConnectView.js";
import { FindReplaceView } from "./views/FindReplaceView.js";
import { GraphMismatchView } from "./views/GraphMismatchView.js";
import { HistoryRoute } from "./views/HistoryView.js";
import { TrashView } from "./views/TrashView.js";

/** Hidden on Capacitor for now (owner's call, `docs/BUGS.md` "Graph hidden on Capacitor"): `/graph`
 * is entirely server-dependent (`graph.links`) and arguably not a natural phone surface regardless.
 * A direct/deep link still redirects rather than rendering a page nothing links to anymore. */
function GraphOrRedirect(): JSX.Element {
  if (platform.name === "capacitor") return <Navigate href="/journals" />;
  return <GraphRoute />;
}

function RouterRoot(routeProps: RouteSectionProps): JSX.Element {
  // `.endsWith`, not `===`: robust either way to whether the router's `location.pathname` is
  // base-relative or the raw browser path (ADR 025 — the app can be served under `/g/<slug>`).
  if (routeProps.location.pathname.endsWith("/capture")) return <>{routeProps.children}</>;
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
  // A device with no token can render the app but can never sync, search or load references —
  // every one of those endpoints is authenticated. Rather than let it look broken (which is
  // exactly how the missing-token bug presented), ask for one up front. Loopback clients are
  // handed a token by the server and never see this.
  const config = bootstrapConfig();
  const [skipped, setSkipped] = createSignal(false);
  // `/capture` is deliberately exempt: quick capture must open instantly and writes locally. Ends
  // with rather than equals: this runs before `<Router>` exists to strip its own `base` (below),
  // so the raw pathname may still carry a `/g/<slug>` prefix.
  const isCapture = (): boolean => Boolean(globalThis.location?.pathname?.endsWith("/capture"));

  // Checked before anything else: a graph mismatch makes every other screen quietly lie, so
  // there is no point rendering them.
  if (config.graphMismatch && config.graphId) {
    return <GraphMismatchView graphId={config.graphId} />;
  }

  return (
    <Show
      when={config.token !== null || skipped() || isCapture()}
      fallback={<ConnectView reason={config.reason} onSkip={() => setSkipped(true)} />}
    >
      {/* ADR 025: routes below are defined app-relative ("/journals", not "/g/default/journals");
          `base` is what lets the router match/generate them correctly wherever this page actually
          loaded from. `samePathGraphPrefix()`, not `apiBaseUrl()`/`activeGraph()` — see its own
          doc comment for why those are the wrong source (can be a different origin entirely). */}
      <Router base={samePathGraphPrefix() ?? ""} root={RouterRoot}>
        <Route path="/" component={() => <Navigate href="/journals" />} />
        <Route path="/journal/today" component={() => <Navigate href="/journals" />} />
        <Route path="/journals" component={JournalsRoute} />
        <Route path="/pages" component={PagesRoute} />
        <Route path="/page/*name" component={PageRoute} />
        <Route path="/search" component={SearchRoute} />
        <Route path="/tasks" component={TasksRoute} />
        <Route path="/graph" component={GraphOrRedirect} />
        <Route path="/replace" component={FindReplaceView} />
        {/* M7 item 8 (ADR 022): the trash, and a page's history at `/history/*name` — not under
            `/page/*name`, whose splat would swallow "/history" as part of the page name. */}
        <Route path="/trash" component={TrashView} />
        <Route path="/history/*name" component={HistoryRoute} />
        <Route path="/capture" component={CaptureRoute} />
      </Router>
    </Show>
  );
}
