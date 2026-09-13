/**
 * The client halves compiled into this build (ADR 023): the built-in plugins under `plugins/` at
 * the repo root that have a `client` entry. Imported statically — each is a few hundred bytes of
 * its own code; anything heavy it needs (mermaid) it imports lazily itself — and typechecked
 * against `@nooklet/plugin-api` with the rest of the app, so an API change that breaks a built-in
 * fails `pnpm -r typecheck` instead of a user's first diagram.
 *
 * A new built-in client half is one import and one row here. Plugins in `<dataDir>/plugins` are
 * not loaded by the web app at all yet — their server halves run, their client halves do not.
 */
import mermaidManifest from "../../../../plugins/mermaid/package.json";
import mermaid from "../../../../plugins/mermaid/src/client.js";
import wordCountManifest from "../../../../plugins/word-count/package.json";
import wordCount from "../../../../plugins/word-count/src/client.js";
import type { BuiltinClientPlugin } from "./host.js";

export const BUILTIN_CLIENT_PLUGINS: readonly BuiltinClientPlugin[] = [
  { manifest: mermaidManifest, module: mermaid },
  { manifest: wordCountManifest, module: wordCount },
];
