import { render } from "solid-js/web";
import { App } from "./App.js";
import { initFocusLog } from "./app/focus-log.js";
import {
  activeGraph,
  apiBaseUrl,
  authToken,
  hasSyncTarget,
  initBootstrap,
} from "./data/bootstrap.js";
import { suggestJournalTitleFormat } from "./data/page-title.js";
import { initDb } from "./db/client.js";
import {
  cannotRunHere,
  currentContextFacts,
  renderInsecureContextPage,
} from "./insecure-context.js";
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
  const bootstrap = await initBootstrap();

  // Before anything renders, so no journal title is painted in one format and repainted in another:
  // a graph imported from Logseq keeps the date format it was written in until someone chooses
  // otherwise in settings (ADR 018).
  suggestJournalTitleFormat(bootstrap.journalTitleFormat);

  // B-567: omit syncBaseUrl entirely (rather than passing "") when there is no real sync target —
  // `WorkerInitOptions.syncBaseUrl`'s own doc comment already says omitting it means "run local-only",
  // which `WorkerDb.start()` uses to skip bootstrap/connectLive/pull rather than pay B-566's timeout
  // on every cold start for a device that will never have anything to reach.
  void initDb({
    syncBaseUrl: hasSyncTarget() ? apiBaseUrl() : undefined,
    token: authToken(),
    // ADR 025: namespaces this worker's OPFS filename and leader-election lock so a future second
    // active graph behind this origin never contends with this one for either.
    graphEntryId: activeGraph()?.id,
  });

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
