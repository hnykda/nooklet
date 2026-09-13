/**
 * Code fences drawn by a client plugin's `registerCodeBlockRenderer` (ADR 007, ADR 023) — the
 * ```` ```mermaid ```` diagram being the reason this exists. `tokens.tsx`'s `fence` case asks
 * `fenceRenderer(lang)` first; a registered renderer gets the fence, anything else falls through
 * to the syntax-highlighted `CodeFence`.
 *
 * The registry is a signal because plugins activate after the first paint: a fence rendered before
 * its renderer registered must re-render once it has, not stay plain code until a reload.
 *
 * `RenderInfo` carries the fence's `Block` and `Page`. The renderer contract gives no way to thread
 * them through `RenderCtx` without touching every caller, so the fence finds its block the way the
 * shelf and the live-UI overlay already do — the nearest `[data-block-id]` row — and reads both
 * from the replica. A fence with no block row around it (the shelf's outline) keeps showing its
 * source rather than calling a renderer with an invented block.
 */
import type { Block, Page } from "@nooklet/core";
import type { CodeBlockRenderer, Disposable, RenderInfo } from "@nooklet/plugin-api";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { describeError } from "../../data/api-client.js";
import { loadBlock, loadPage } from "../../data/plugin-lookups.js";
import "./plugin-fence.css";

const [renderers, setRenderers] = createSignal<ReadonlyMap<string, CodeBlockRenderer>>(new Map());

/**
 * The last thing each renderer drew for a given fence, so a fence re-created for the same source
 * shows that drawing straight away while its renderer runs again. Rows re-create their rendered
 * content on every write to their page — a coalesced keystroke in any block, a sync pull — and an
 * asynchronous renderer then left every diagram on the page showing its `<pre>` source until it
 * had drawn again: while typing elsewhere on the owner's 2022-12-15 journal, the diagram dropped
 * from 452 px to 134 px and back on each pause, and everything below it jumped (B-183).
 *
 * Per renderer (a disposed renderer's drawings go with it), keyed by language and source, and
 * bounded: this only has to cover the fences on screen.
 */
const lastDrawn = new WeakMap<CodeBlockRenderer, Map<string, string>>();
const LAST_DRAWN_LIMIT = 64;

function drawnKey(lang: string, code: string): string {
  return `${lang}\n${code}`;
}

function recallDrawn(renderer: CodeBlockRenderer, key: string): string | undefined {
  return lastDrawn.get(renderer)?.get(key);
}

function rememberDrawn(renderer: CodeBlockRenderer, key: string, html: string): void {
  let drawings = lastDrawn.get(renderer);
  if (!drawings) {
    drawings = new Map();
    lastDrawn.set(renderer, drawings);
  }
  drawings.delete(key); // re-inserted last: Map order is the eviction order
  drawings.set(key, html);
  if (drawings.size > LAST_DRAWN_LIMIT) {
    const oldest = drawings.keys().next().value;
    if (oldest !== undefined) drawings.delete(oldest);
  }
}

/** `query` fences are core (ADR 011) and are matched before this registry is consulted, so a
 * plugin claiming them would silently never run; refuse it up front instead. */
const RESERVED_LANGS = new Set(["query"]);

/** Register `renderer` for fences whose info string is `lang` (case-insensitive). Throws if the
 * language is reserved or already claimed — two plugins racing for one fence is a configuration
 * error to surface, not a coin toss. The returned function unregisters exactly this renderer. */
export function registerFenceRenderer(lang: string, renderer: CodeBlockRenderer): () => void {
  const key = lang.trim().toLowerCase();
  if (!key) throw new Error("a code-block renderer needs a language");
  if (RESERVED_LANGS.has(key)) throw new Error(`\`${key}\` fences are rendered by nooklet itself`);
  if (renderers().has(key))
    throw new Error(`a renderer for \`${key}\` fences is already registered`);
  setRenderers((prev) => new Map(prev).set(key, renderer));
  return () =>
    setRenderers((prev) => {
      if (prev.get(key) !== renderer) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
}

/** The renderer registered for `lang`, if any. Tracked. */
export function fenceRenderer(lang: string): CodeBlockRenderer | undefined {
  return renderers().get(lang.trim().toLowerCase());
}

async function fenceContext(el: HTMLElement): Promise<{ block: Block; page: Page } | null> {
  const blockId = el.closest<HTMLElement>("[data-block-id]")?.dataset.blockId;
  if (!blockId) return null;
  const block = await loadBlock(blockId);
  if (!block) return null;
  const page = await loadPage({ id: block.pageId });
  return page ? { block, page } : null;
}

export function PluginFence(props: { code: string; lang: string; renderer: CodeBlockRenderer }) {
  let el!: HTMLDivElement;
  const [failed, setFailed] = createSignal<string | null>(null);

  createEffect(() => {
    const { code, lang, renderer } = props;
    const abort = new AbortController();
    let disposable: Disposable | undefined;
    onCleanup(() => {
      abort.abort();
      disposable?.dispose();
    });
    setFailed(null);
    const key = drawnKey(lang, code);
    // Synchronous, in the same task that created the fence, so no frame ever paints the source.
    const drawn = recallDrawn(renderer, key);
    if (drawn !== undefined) el.innerHTML = drawn;

    void (async () => {
      const context = await fenceContext(el);
      if (abort.signal.aborted || !context) return;
      const info: RenderInfo = { ...context, lang, editing: false, signal: abort.signal };
      try {
        if ("render" in renderer) {
          const result = await renderer.render(code, el, info);
          if (!abort.signal.aborted) rememberDrawn(renderer, key, el.innerHTML);
          if (!result) return;
          // Rendered into a fence that has since been replaced: nothing will dispose it later.
          if (abort.signal.aborted) result.dispose();
          else disposable = result;
        } else {
          const html = await renderer.html(code, info);
          // Trusted v1 host (ADR 007): a plugin's markup goes in as-is, like its `render` would.
          if (!abort.signal.aborted) {
            el.innerHTML = html;
            rememberDrawn(renderer, key, html);
          }
        }
      } catch (e) {
        if (abort.signal.aborted) return;
        console.warn(`[plugins] the \`${lang}\` renderer threw:`, e);
        setFailed(describeError(e));
      }
    })();
  });

  return (
    <div class="vr-plugin-fence" data-lang={props.lang}>
      {/* The renderer owns this element's children; until it paints, they are the source. */}
      <div class="vr-plugin-fence-output" ref={el}>
        <pre class="vr-fence" data-lang={props.lang}>
          <code class={`language-${props.lang}`}>{props.code}</code>
        </pre>
      </div>
      <Show when={failed()}>
        {(message) => (
          <div class="vr-plugin-fence-error" role="alert">{`${props.lang}: ${message()}`}</div>
        )}
      </Show>
    </div>
  );
}
