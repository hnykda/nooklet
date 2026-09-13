import { render } from "solid-js/web";
import { App } from "./App.js";
import { initFocusLog } from "./app/focus-log.js";
import { apiBaseUrl, authToken, initBootstrap } from "./data/bootstrap.js";
import { suggestJournalTitleFormat } from "./data/page-title.js";
import { initDb } from "./db/client.js";
import { registerServiceWorker } from "./sw/register.js";

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

void initDb({ syncBaseUrl: apiBaseUrl(), token: authToken() });

registerServiceWorker();

const root = document.getElementById("app");
if (!root) throw new Error("#app root element not found in index.html");

render(() => <App />, root);
