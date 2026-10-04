import { render } from "solid-js/web";
import { App } from "./App.js";
import { initFocusLog } from "./app/focus-log.js";
import {
  activeGraph,
  adoptAddressBarGraph,
  adoptLegacyReplica,
  apiBaseUrl,
  authToken,
  hasSyncTarget,
  initBootstrap,
  replicaKey,
} from "./data/bootstrap.js";
import { suggestJournalTitleFormat } from "./data/page-title.js";
import { initTaskWorkflow } from "./data/task-workflow.js";
import { initDb } from "./db/client.js";
import {
  cannotRunHere,
  currentContextFacts,
  renderInsecureContextPage,
} from "./insecure-context.js";
import { platform } from "./platform/index.js";
import { registerServiceWorker } from "./sw/register.js";

/**
 * B-615: on an origin the browser does not treat as secure (plain http on a LAN/tailnet IP), say
 * why and stop, rather than accepting a token and then dying on `crypto.randomUUID`/
 * `navigator.locks` with a blank page — see `./insecure-context.ts`. Checked here, first: nothing
 * imported above uses either at import time, only once started. Kept in this module (not a
 * separate entry that dynamically imports this one) because that extra hop let the page's `load`
 * event fire before the app had mounted, which broke every "press a key right after load" flow.
 */
async function start(): Promise<void> {
  // First, so a log left switched on (Diagnostics → Focus log) sees the page load from the start.
  initFocusLog();

  // Credentials first: the sync worker is handed its token once, at startup, and `App` decides
  // whether to show the connect screen from the same config — so both must wait for it. Everything
  // else (the local replica, rendering) proceeds normally afterwards; Solid resources handle the
  // pending state on their own.
  // Which graph this page is for comes first of all: the address bar, when it names another graph
  // on this origin than the active entry (`adoptAddressBarGraph`'s doc comment).
  adoptAddressBarGraph();
  const bootstrap = await initBootstrap();

  // Before anything renders, so no journal title is painted in one format and repainted in another:
  // a graph imported from Logseq keeps the date format it was written in until someone chooses
  // otherwise in settings (ADR 018).
  suggestJournalTitleFormat(bootstrap.journalTitleFormat);

  // B-567: omit syncBaseUrl entirely (rather than passing "") when there is no real sync target —
  // `WorkerInitOptions.syncBaseUrl`'s own doc comment already says omitting it means "run local-only",
  // which `WorkerDb.start()` uses to skip bootstrap/connectLive/pull rather than pay B-566's timeout
  // on every cold start for a device that will never have anything to reach.
  //
  // B-633: on a graph mismatch (`GraphMismatchView` is what renders), the server now serves a
  // DIFFERENT graph than this replica holds. Syncing would push this replica's pending ops into that
  // graph and pull its ops into this one — the cross-graph mix the view exists to prevent. So the
  // replica opens local-only until the owner discards it; the discard itself is worker-local.
  const replica = replicaKey(activeGraph());
  const dbReady = initDb({
    syncBaseUrl: hasSyncTarget() && !bootstrap.graphMismatch ? apiBaseUrl() : undefined,
    token: authToken(),
    // ADR 025: namespaces this worker's OPFS filename and leader-election lock so a future second
    // active graph behind this origin never contends with this one for either. `undefined` for the
    // un-namespaced replica (no active entry, or the entry that adopted it — B-612).
    graphEntryId: replica,
    // B-612: a phone that chose "Just this device" before that made a list entry, then added a server
    // graph, has its notes in the un-namespaced replica with nothing in the list pointing at it. Ask
    // the worker whether it holds notes only this device has; if so, list it so the switcher reaches
    // it again. Capacitor only: on web/desktop that file is a pre-ADR-025 copy of a server's graph.
    inspectUnnamespaced: platform.name === "capacitor" && replica !== undefined,
  });
  void dbReady.then((r) => {
    if (r.unnamespacedReplica === "data") adoptLegacyReplica();
  });

  // B-608: the graph's task workflow (LATER/NOW or TODO/DOING), before anything renders so the first
  // Mod+Enter already starts a task the way this graph does. After `initDb`, not before: its offline
  // fallback queries the replica, and a query before `initDb(options)` would initialise it without
  // them.
  initTaskWorkflow(bootstrap.taskWorkflow);

  registerServiceWorker();

  const root = document.getElementById("app");
  if (!root) throw new Error("#app root element not found in index.html");

  render(() => <App />, root);
}

const appRoot = document.getElementById("app");
if (appRoot && cannotRunHere(currentContextFacts())) {
  renderInsecureContextPage(appRoot, location);
} else {
  await start();
}
