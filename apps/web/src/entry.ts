/**
 * The page's entry point: decide whether the app can run here at all before loading it (B-615).
 * `./main.tsx` is imported dynamically so that its module graph — some of which uses
 * `crypto.randomUUID` at import time — is never evaluated on an origin that lacks it. See
 * `./insecure-context.ts`.
 */

import {
  cannotRunHere,
  currentContextFacts,
  renderInsecureContextPage,
} from "./insecure-context.js";

const root = document.getElementById("app");
if (root && cannotRunHere(currentContextFacts())) {
  renderInsecureContextPage(root, location);
} else {
  await import("./main.js");
}
