import { render } from "solid-js/web";
import { App } from "./App.js";
import { apiBaseUrl, authToken, initBootstrap } from "./data/bootstrap.js";
import { initDb } from "./db/client.js";
import { registerServiceWorker } from "./sw/register.js";

// Credentials first: the sync worker is handed its token once, at startup, and `App` decides
// whether to show the connect screen from the same config — so both must wait for it. Everything
// else (the local replica, rendering) proceeds normally afterwards; Solid resources handle the
// pending state on their own.
await initBootstrap();

void initDb({ syncBaseUrl: apiBaseUrl(), token: authToken() });

registerServiceWorker();

const root = document.getElementById("app");
if (!root) throw new Error("#app root element not found in index.html");

render(() => <App />, root);
