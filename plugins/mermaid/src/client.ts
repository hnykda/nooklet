/**
 * `mermaid`'s client half (M4 built-in #1): a ```mermaid code-block renderer, plus a `/mermaid`
 * slash command that inserts a starter block (`docs/spec/api-and-plugin-types.md` §5's worked
 * example — `word-count`, not this plugin, is what pairs a server op with a client half).
 *
 * The `mermaid` library is this plugin's own npm dependency (`package.json`), imported lazily so
 * it becomes separate chunks that load on the first diagram, never at startup. It used to be
 * fetched from jsdelivr at render time through a computed `import()` specifier (so no bundler
 * would see it); ADR 023 replaced that: a local-first app that draws diagrams only when online,
 * running whatever `mermaid@11` the CDN served that day, is not what anyone asked for.
 */
import type { ClientPluginModule } from "@nooklet/plugin-api";
import type { Mermaid } from "mermaid";

let mermaidPromise: Promise<Mermaid> | undefined;

function loadMermaid(theme: "light" | "dark"): Promise<Mermaid> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then(
      ({ default: mermaid }) => {
        // `strict` is mermaid's default, spelled out because the SVG goes in through `innerHTML`:
        // strict sanitises labels and disables click handlers in the diagram source.
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: theme === "dark" ? "dark" : "default",
        });
        return mermaid;
      },
      (e: unknown) => {
        // A chunk that failed to load (offline before the service worker cached it) must not stay
        // failed for the whole session: forget the promise so the next diagram tries again.
        mermaidPromise = undefined;
        throw e;
      },
    );
  }
  return mermaidPromise;
}

export default {
  async activate(ctx) {
    ctx.registerCodeBlockRenderer("mermaid", {
      async render(source, el, info) {
        try {
          const mermaid = await loadMermaid(ctx.host.theme);
          const { svg } = await mermaid.render(`nooklet-mermaid-${crypto.randomUUID()}`, source);
          if (!info.signal.aborted) el.innerHTML = svg;
        } catch (e) {
          if (info.signal.aborted) return;
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
