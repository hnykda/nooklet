/**
 * `mermaid`'s client half (M4 built-in #1): a ```mermaid code-block renderer, plus a `/mermaid`
 * slash command that inserts a starter block (`docs/spec/api-and-plugin-types.md` §5's worked
 * example, adapted to be client-only per this milestone's task list — `word-count`, not this
 * plugin, is what pairs a server op with a client half).
 *
 * No `mermaid` npm dependency: the real `mermaid` library is fetched from a CDN at first render,
 * via a NON-literal `import()` specifier. esbuild only rewrites/bundles a dynamic `import("literal
 * string")`; a computed specifier (a variable) is left as an opaque runtime expression, so this
 * plugin bundles cleanly with no `node_modules` copy of `mermaid` anywhere, exactly like any other
 * plugin dependency a plugin author is expected to `npm install` for themselves — except here
 * there's nothing to install. In an actual browser with network access this renders the real
 * mermaid output; a future v2 sandboxed client host could instead pin a host-bundled copy.
 */
import type { ClientPluginModule } from "@nooklet/plugin-api";

interface MermaidModule {
  initialize(opts: { startOnLoad: boolean; theme?: string }): void;
  render(id: string, source: string): Promise<{ svg: string }>;
}

const MERMAID_CDN_URL = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

let mermaidPromise: Promise<MermaidModule> | undefined;

function loadMermaid(): Promise<MermaidModule> {
  if (!mermaidPromise) {
    const specifier = MERMAID_CDN_URL; // see file header: kept in a variable on purpose
    mermaidPromise = import(/* @vite-ignore */ specifier).then((m: { default: MermaidModule }) => {
      m.default.initialize({ startOnLoad: false, theme: "default" });
      return m.default;
    });
  }
  return mermaidPromise;
}

export default {
  async activate(ctx) {
    ctx.registerCodeBlockRenderer("mermaid", {
      async render(source, el) {
        try {
          const mermaid = await loadMermaid();
          const { svg } = await mermaid.render(`nooklet-mermaid-${crypto.randomUUID()}`, source);
          el.innerHTML = svg;
        } catch (e) {
          el.textContent = `mermaid: render failed (${e instanceof Error ? e.message : String(e)})`;
          ctx.log.warn("mermaid render failed:", e);
        }
      },
    });

    ctx.registerSlashCommand({
      id: "mermaid",
      label: "Mermaid diagram",
      keywords: ["diagram", "graph", "chart", "flowchart"],
      run: (editor) => editor.insertText("```mermaid\ngraph TD\n  A --> B\n```"),
    });
  },
} satisfies ClientPluginModule;
