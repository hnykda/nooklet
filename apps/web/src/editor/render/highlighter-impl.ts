/**
 * The lazily-loaded half of `./highlight.ts`: highlight.js core plus one dynamic import per
 * grammar, so the first JavaScript fence costs the core chunk plus the JavaScript grammar and
 * nothing else. Only this file may import from `highlight.js` — everything else goes through
 * the facade so the main bundle never pulls it in statically.
 */
import type { LanguageFn } from "highlight.js";
import hljs from "highlight.js/lib/core";
import "./highlight.css";

type Loader = () => Promise<{ default: LanguageFn }>;

/** Keep in sync with `HIGHLIGHT_LANGUAGES` in `./highlight.ts` (asserted by its test). Each entry
 * is a literal import path on purpose — a template-literal `import()` would make Vite bundle all
 * 190+ grammars as chunks, and the PWA would precache every one of them. */
export const LOADERS: Record<string, Loader> = {
  bash: () => import("highlight.js/lib/languages/bash"),
  c: () => import("highlight.js/lib/languages/c"),
  clojure: () => import("highlight.js/lib/languages/clojure"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  css: () => import("highlight.js/lib/languages/css"),
  dart: () => import("highlight.js/lib/languages/dart"),
  diff: () => import("highlight.js/lib/languages/diff"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  elixir: () => import("highlight.js/lib/languages/elixir"),
  go: () => import("highlight.js/lib/languages/go"),
  graphql: () => import("highlight.js/lib/languages/graphql"),
  haskell: () => import("highlight.js/lib/languages/haskell"),
  ini: () => import("highlight.js/lib/languages/ini"),
  java: () => import("highlight.js/lib/languages/java"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  latex: () => import("highlight.js/lib/languages/latex"),
  lua: () => import("highlight.js/lib/languages/lua"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  nginx: () => import("highlight.js/lib/languages/nginx"),
  objectivec: () => import("highlight.js/lib/languages/objectivec"),
  perl: () => import("highlight.js/lib/languages/perl"),
  php: () => import("highlight.js/lib/languages/php"),
  powershell: () => import("highlight.js/lib/languages/powershell"),
  protobuf: () => import("highlight.js/lib/languages/protobuf"),
  python: () => import("highlight.js/lib/languages/python"),
  r: () => import("highlight.js/lib/languages/r"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  rust: () => import("highlight.js/lib/languages/rust"),
  scala: () => import("highlight.js/lib/languages/scala"),
  scss: () => import("highlight.js/lib/languages/scss"),
  shell: () => import("highlight.js/lib/languages/shell"),
  sql: () => import("highlight.js/lib/languages/sql"),
  swift: () => import("highlight.js/lib/languages/swift"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  vim: () => import("highlight.js/lib/languages/vim"),
  xml: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
};

const loading = new Map<string, Promise<void>>();

async function ensureLanguage(name: string): Promise<boolean> {
  if (hljs.getLanguage(name)) return true;
  const loader = LOADERS[name];
  if (!loader) return false;
  let p = loading.get(name);
  if (!p) {
    p = loader().then((m) => {
      hljs.registerLanguage(name, m.default);
    });
    loading.set(name, p);
  }
  await p;
  return true;
}

/** `name` must already be a canonical grammar name (`resolveLanguage` in the facade). */
export async function highlight(code: string, name: string): Promise<string | null> {
  if (!(await ensureLanguage(name))) return null;
  // `ignoreIllegals`: a fence is whatever the author typed, often a fragment; highlight.js would
  // otherwise throw on the first token its grammar cannot place.
  return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
}
