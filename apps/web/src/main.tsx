import { render } from "solid-js/web";
import { App } from "./App.js";
import { initDb } from "./db/client.js";
import { registerServiceWorker } from "./sw/register.js";

// Start the DB worker immediately; App/routes read through src/data/store.ts's resources, which
// resolve once init() finishes (Solid resources handle the pending state on their own).
void initDb({ syncBaseUrl: import.meta.env.VITE_SYNC_BASE_URL });

registerServiceWorker();

const root = document.getElementById("app");
if (!root) throw new Error("#app root element not found in index.html");

render(() => <App />, root);
