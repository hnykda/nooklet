/**
 * Route table (task item 5: "minimal route structure that the views agent will fill in"). Three
 * placeholders only — journals/page/search — each marked `TODO(views)`. Do not add real view
 * logic here; add routes/screens in the placeholder files themselves.
 */
import { Navigate, Route, Router } from "@solidjs/router";
import { JournalsRoute } from "./routes/JournalsRoute.js";
import { PageRoute } from "./routes/PageRoute.js";
import { SearchRoute } from "./routes/SearchRoute.js";
import { AppShell } from "./shell/AppShell.js";

export function App() {
  return (
    <Router root={AppShell}>
      <Route path="/" component={() => <Navigate href="/journals" />} />
      <Route path="/journal/today" component={() => <Navigate href="/journals" />} />
      <Route path="/journals" component={JournalsRoute} />
      <Route path="/page/:id" component={PageRoute} />
      <Route path="/search" component={SearchRoute} />
    </Router>
  );
}
