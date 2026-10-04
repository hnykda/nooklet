/**
 * Renders `tokenizeContent`/`classifyBlockContent`'s output as HTML, per the rendering contract
 * table (`docs/spec/markdown-grammar.md` §4) — exact CSS class names, one component per token/
 * content kind. Used by `InlineContent.tsx` (reference snippets/search hits) and by the read-only
 * `BlockView` inside `BlockRowView.tsx` (every block that is not the one currently being edited).
 *
 * Every rendered node carries `data-from`/`data-to` (the tokenizer's own offsets into the block's
 * `content` string) so a click on the rendered view can compute an exact source-string caret
 * offset without Logseq's diff-based heuristic (research/04-editor.md §3.3): walk up from the
 * clicked DOM position to the nearest `[data-from]` and add the in-token character offset. See
 * `caret.ts#resolveClickOffset`.
 *
 * `RenderCtx.source` is the whole content string being rendered — carried on the context (rather
 * than threaded as a separate prop through every recursive call) so a `text` token nested inside
 * `strong`/`em`/a link label/etc. can still slice its own characters out of it; every token's
 * `start`/`end` is an absolute offset into that one string regardless of nesting depth (the
 * tokenizer's own invariant, markdown-grammar.md Definitions).
 *
 * Known gaps, flagged here and in `BlockTree.tsx`'s summary rather than silently faked:
 *  - `wikilink`/`linkToPage` `.vr-ref-new` (page doesn't exist) needs a page-existence index this
 *    milestone's data seam does not expose; every ref renders as "resolved" (no `.vr-ref-new`)
 *    until a page-index prop is threaded through.
 *  - `blockRef`/`linkToBlock` render the target block's own tokens through `resolveBlockRef`
 *    (`BlockRowView` and the Shelf pass `data/block-ref-cache.ts`'s lookup); a caller that
 *    supplies none, or a block not in the replica, gets a muted `((id))`-style placeholder.
 *  - `embed` renders the target READ-ONLY (`./EmbedView.tsx`, B-210), not the contract's
 *    read-write nested tree: rows click through to the block, editing happens where it lives.
 *
 * Wired in M7 (research/13 §4.2 items 1 and 9), each behind a lazy import so a page without it
 * pays nothing (numbers in docs/research/14-render-seams.md):
 *  - `fence` with `lang === "query"` renders live results (`./QueryFenceView.tsx`, ADR 011).
 *  - other fences are syntax-highlighted (`./highlight.ts`, highlight.js, per-language chunks).
 *  - `math` renders through KaTeX (`./math.ts`); `$tex$` text until the chunk lands.
 *  - `embed` renders the embedded page/block (`./EmbedView.tsx`); the placeholder box until then.
 */
import {
  type Align,
  type BlockContent,
  type InlineToken as Tok,
  tokenizeContent,
} from "@nooklet/core";

import {
  createEffect,
  createMemo,
  createSignal,
  For,
  lazy,
  onCleanup,
  Show,
  Suspense,
} from "solid-js";
import { pageRoutePath, rawAnchorHref } from "../../routes/page-path.js";
import { assetUrl } from "./asset-url.js";
import { canHighlight, highlightCode, highlightSync, languageClass } from "./highlight.js";
import { ImageView } from "./ImageView.js";
import { loadMath, renderTexSync } from "./math.js";
import { fenceRenderer, PluginFence } from "./PluginFence.js";
import { safeHref } from "./safe-href.js";

export type NavigateTarget =
  | { kind: "page"; name: string }
  | {
      kind: "block";
      id: string;
      /** The block's own page, when the renderer knows it. An embedded row does (`./EmbedView.tsx`),
       * and must say so: the tree it is drawn inside belongs to the HOST page, and a shelf card
       * given that page's id cannot find the block (B-215). */
      pageId?: string;
    };
export type Navigate = (t: NavigateTarget) => void;

export interface RenderCtx {
  /** The full string these tokens' offsets are relative to. */
  source: string;
  onNavigate?: Navigate;
  /** Shift+click on a `[[page]]`/`#tag` link opens that page on the right-hand shelf instead of
   * navigating to it (`../../app/shelf.ts`). Only page links are wired: a `((block-ref))` would
   * need its own page id, which this renderer has no way to resolve. Absent = plain navigation. */
  onShelfOpen?: Navigate;
  /** B-736: enter the editor at `offset` in `source`. An image takes its own click (it opens the
   * image viewer), so a block that is nothing but a wide picture had nowhere left to click to edit
   * it; the viewer offers "Edit block" through this. Absent = not editable here. */
  onEditBlock?: (offset: number) => void;
  /** B-789: replace `source` — the whole block's text — with a new version, as one undoable edit
   * through the tree's normal write path. An image's resize handle and ⋯ menu write its size and
   * alignment through this (ADR 034). Absent = not editable here (a locked page, a reference
   * snippet, an embedded row: anywhere `source` is not the block this would write). */
  onRewrite?: (content: string) => void;
  /** Depth-limited recursive rendering for blockRef/embed (rendering contract: "depth-limited to
   * 2"); defaults to 0 and increments on recursion — callers normally never set this. */
  refDepth?: number;
  resolveBlockRef?: (id: string) => { content: string } | undefined;
  /** Ids of the blocks this render is nested inside: the outliner row it belongs to, then each
   * embedded block on the way down. An embed whose target contains one of them would render
   * itself forever, and shows a notice instead (`./EmbedView.tsx`). Absent = no known host. */
  embedPath?: readonly string[];
  /** Override for syntax highlighting (a plugin, or a test): returns highlighted HTML for
   * `code`/`lang`, or `null` to defer to the default. The default is the bundled, lazily-loaded
   * highlight.js (`./highlight.ts`); an override that returns non-null wins and is rendered as
   * `innerHTML`, so it must produce escaped markup. */
  highlightCode?: (code: string, lang: string) => string | null;
}

export const MAX_REF_DEPTH = 2;

const QueryFenceView = lazy(() => import("./QueryFenceView.js"));
const EmbedView = lazy(() => import("./EmbedView.js"));

/** A ```` ```query ```` fence: the lazily-loaded live view, with the raw fence as the Suspense
 * fallback so the page never blanks while the chunk loads. Only at depth 0 — a query fence that
 * is itself a query result renders as a plain fence (see `QueryFenceView`'s `refDepth`). */
function QueryFence(props: { code: string; ctx: RenderCtx }) {
  return (
    <Suspense
      fallback={
        <pre class="vr-fence" data-lang="query">
          <code class="language-query">{props.code}</code>
        </pre>
      }
    >
      <QueryFenceView code={props.code} ctx={props.ctx} />
    </Suspense>
  );
}

/** A code fence: plain text immediately, highlighted once the highlighter (and this language's
 * grammar) has loaded — cached, so a re-mount of the same fence is synchronous. Not a
 * `createResource` on purpose: a resource read would suspend any boundary above this row, and a
 * plain signal keeps the swap local to the `<code>` element. */
function CodeFence(props: { code: string; lang: string; ctx: RenderCtx }) {
  const custom = createMemo(() => props.ctx.highlightCode?.(props.code, props.lang) ?? null);
  const [auto, setAuto] = createSignal<string | null>(null);
  createEffect(() => {
    const code = props.code;
    const lang = props.lang;
    if (custom() !== null) return;
    const cached = highlightSync(code, lang);
    setAuto(cached);
    if (cached !== null || !canHighlight(lang)) return;
    let stale = false;
    onCleanup(() => {
      stale = true;
    });
    void highlightCode(code, lang).then((html) => {
      if (!stale) setAuto(html);
    });
  });
  const html = (): string | null => custom() ?? auto();
  return (
    <pre class="vr-fence" data-lang={props.lang}>
      <Show when={html()} fallback={<code class={languageClass(props.lang)}>{props.code}</code>}>
        {(h) => (
          // Highlighter output only (escaped by highlight.js, or by the `highlightCode` override's
          // contract) — never raw user text.
          <code class={`${languageClass(props.lang)} hljs`} innerHTML={h()} />
        )}
      </Show>
    </pre>
  );
}

/** Inline `$tex$` or display `$$tex$$`: KaTeX HTML once loaded, the literal source until then (the
 * contract's own fallback). Same signal-not-resource reasoning as `CodeFence`. */
function MathView(props: { tex: string; display: boolean; from: number; to: number }) {
  const [html, setHtml] = createSignal<string | null>(null);
  const delim = () => (props.display ? "$$" : "$");
  createEffect(() => {
    const tex = props.tex;
    const display = props.display;
    const now = renderTexSync(tex, display);
    setHtml(now);
    if (now !== null) return;
    let stale = false;
    onCleanup(() => {
      stale = true;
    });
    void loadMath().then(
      () => {
        if (!stale) setHtml(renderTexSync(tex, display));
      },
      () => {
        // Chunk failed to load (offline, first visit): stay on the source text.
      },
    );
  });
  return (
    <Show
      when={html()}
      fallback={
        <span class="vr-math" data-from={props.from} data-to={props.to}>
          {`${delim()}${props.tex}${delim()}`}
        </span>
      }
    >
      {(h) => (
        // KaTeX output with `trust: false` — see `./math.ts`.
        <span
          class="vr-math vr-math-rendered"
          data-from={props.from}
          data-to={props.to}
          innerHTML={h()}
        />
      )}
    </Show>
  );
}

function stop(e: MouseEvent): void {
  e.preventDefault();
  e.stopPropagation();
}

function NavLink(props: {
  class: string;
  target: NavigateTarget;
  href: string;
  from: number;
  to: number;
  /** Where the rendered text starts in the source, when it is a verbatim slice of it (a
   * wikilink's target, after the `[[`): `caret.ts#resolveClickOffset` counts from here. */
  textFrom?: number;
  onNavigate?: Navigate;
  onShelfOpen?: Navigate;
  children: unknown;
}) {
  return (
    // ADR 025: a raw `<a>`, not `<A>` — `@solidjs/router`'s own base-prepending never runs for it,
    // so this is the one place along this whole click path that must add the prefix itself (see
    // `rawAnchorHref`'s own doc comment). The click handler below navigates via `props.onNavigate`
    // regardless of this attribute; this is what makes the ATTRIBUTE — what you'd copy, bookmark,
    // middle-click — correct too.
    <a
      href={rawAnchorHref(props.href)}
      class={props.class}
      data-from={props.from}
      data-to={props.to}
      data-text-from={props.textFrom}
      onClick={(e) => {
        // Shift first, and `stop` before anything else runs: the enclosing block row treats a
        // Shift+click of its own as "shelve this block", so without halting propagation here you
        // would get the link's page AND the block it was written in.
        if (e.shiftKey && props.onShelfOpen) {
          stop(e);
          props.onShelfOpen(props.target);
          return;
        }
        if (!props.onNavigate) return;
        stop(e);
        props.onNavigate(props.target);
      }}
    >
      {props.children as never}
    </a>
  );
}

function BlockRefView(props: {
  id: string;
  label: Tok[] | undefined;
  from: number;
  to: number;
  ctx: RenderCtx;
}) {
  const depth = () => props.ctx.refDepth ?? 0;
  const resolved = (): { content: string } | undefined =>
    depth() < MAX_REF_DEPTH ? props.ctx.resolveBlockRef?.(props.id) : undefined;
  const navigate = (e: { preventDefault(): void; stopPropagation(): void }): void => {
    if (!props.ctx.onNavigate) return;
    e.preventDefault();
    e.stopPropagation();
    props.ctx.onNavigate({ kind: "block", id: props.id });
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: not a real hyperlink (no href/browser navigation) — a rendered ((block-ref)) preview inline in running text, whose content model doesn't fit `<a>`.
    <span
      class="vr-block-ref"
      data-from={props.from}
      data-to={props.to}
      role="link"
      tabIndex={props.ctx.onNavigate ? 0 : undefined}
      onClick={navigate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") navigate(e);
      }}
    >
      <Show
        when={props.label}
        fallback={
          <Show when={resolved()} fallback={`((${props.id}))`}>
            {(r) => <RefPreview content={r().content} ctx={props.ctx} depth={depth() + 1} />}
          </Show>
        }
      >
        <InlineTokens tokens={props.label as Tok[]} ctx={props.ctx} />
      </Show>
    </span>
  );
}

/** Renders a plain content string as a fresh, independently-tokenized inline run (the "target
 * block's own tokens" the rendering contract asks a `blockRef` preview to show). */
function RefPreview(props: { content: string; ctx: RenderCtx; depth: number }) {
  const tokens = () => tokenizeContent(props.content);
  return (
    <InlineTokens
      tokens={tokens()}
      // `onEditBlock` offsets are into the HOST block's source, not this one's.
      ctx={{
        ...props.ctx,
        source: props.content,
        refDepth: props.depth,
        onEditBlock: undefined,
        onRewrite: undefined,
      }}
    />
  );
}

/** `{{embed}}` with a target: the lazily-loaded live view (`./EmbedView.tsx`), with the placeholder
 * box as the Suspense fallback while the chunk and the first read land. */
function Embed(props: {
  target: { kind: "page"; name: string } | { kind: "block"; id: string } | null;
  from: number;
  to: number;
  ctx: RenderCtx;
}) {
  return (
    <Show when={props.target} keyed fallback={<EmbedPlaceholder {...props} />}>
      {(target) => (
        <Suspense fallback={<EmbedPlaceholder {...props} />}>
          <EmbedView target={target} from={props.from} to={props.to} ctx={props.ctx} />
        </Suspense>
      )}
    </Show>
  );
}

function EmbedPlaceholder(props: {
  target: { kind: "page"; name: string } | { kind: "block"; id: string } | null;
  from: number;
  to: number;
}) {
  if (props.target === null) {
    return (
      <div class="vr-embed vr-embed-error" data-from={props.from} data-to={props.to}>
        {"{{embed}}"}
      </div>
    );
  }
  if (props.target.kind === "page") {
    return (
      <div class="vr-embed vr-embed-page" data-from={props.from} data-to={props.to}>
        Embed: [[{props.target.name}]]
      </div>
    );
  }
  return (
    <div class="vr-embed vr-embed-block" data-from={props.from} data-to={props.to}>
      Embed: (({props.target.id}))
    </div>
  );
}

/** One inline token -> JSX. Recurses (via `InlineTokens`) for nested-token kinds. */
function InlineTokenView(props: { tok: Tok; ctx: RenderCtx }) {
  return (
    <>
      {(() => {
        const tok = props.tok;
        const ctx = props.ctx;
        switch (tok.kind) {
          case "text":
            return (
              <span data-from={tok.start} data-to={tok.end}>
                {ctx.source.slice(tok.start, tok.end)}
              </span>
            );
          case "br":
            return <br data-from={tok.start} data-to={tok.end} />;
          case "escape":
            return (
              <span data-from={tok.start} data-to={tok.end}>
                {tok.char}
              </span>
            );
          case "wikilink":
            return (
              <NavLink
                class="vr-page-ref"
                target={{ kind: "page", name: tok.target }}
                href={pageRoutePath(tok.target)}
                from={tok.start}
                to={tok.end}
                textFrom={
                  tok.alias === undefined &&
                  ctx.source.slice(tok.targetStart, tok.targetEnd) === tok.target
                    ? tok.targetStart
                    : undefined
                }
                onNavigate={ctx.onNavigate}
                onShelfOpen={ctx.onShelfOpen}
              >
                {tok.alias ?? tok.target}
              </NavLink>
            );
          case "tag":
            return (
              <NavLink
                class="vr-tag"
                target={{ kind: "page", name: tok.name }}
                href={pageRoutePath(tok.name)}
                from={tok.start}
                to={tok.end}
                onNavigate={ctx.onNavigate}
                onShelfOpen={ctx.onShelfOpen}
              >
                {tok.multiWord ? `#[[${tok.name}]]` : `#${tok.name}`}
              </NavLink>
            );
          case "blockRef":
            return (
              <BlockRefView id={tok.id} label={undefined} from={tok.start} to={tok.end} ctx={ctx} />
            );
          case "linkToBlock":
            return (
              <BlockRefView id={tok.id} label={tok.label} from={tok.start} to={tok.end} ctx={ctx} />
            );
          case "embed":
            return <Embed target={tok.target} from={tok.start} to={tok.end} ctx={ctx} />;
          case "macro":
            return (
              <span class="vr-macro-unknown" data-from={tok.start} data-to={tok.end}>
                {`{{${tok.name} ${tok.args}}}`}
              </span>
            );
          case "linkToPage":
            return (
              <NavLink
                class="vr-page-ref"
                target={{ kind: "page", name: tok.target }}
                href={pageRoutePath(tok.target)}
                from={tok.start}
                to={tok.end}
                onNavigate={ctx.onNavigate}
                onShelfOpen={ctx.onShelfOpen}
              >
                <InlineTokens tokens={tok.label} ctx={ctx} />
              </NavLink>
            );
          case "link":
            return (
              <a
                class="vr-link"
                href={safeHref(assetUrl(tok.href))}
                target="_blank"
                rel="noopener"
                data-from={tok.start}
                data-to={tok.end}
              >
                <InlineTokens tokens={tok.label} ctx={ctx} />
              </a>
            );
          case "autolink":
            return (
              <a
                class="vr-link vr-autolink"
                href={tok.href}
                target="_blank"
                rel="noopener"
                data-from={tok.start}
                data-to={tok.end}
              >
                {tok.href}
              </a>
            );
          case "image":
            return <ImageView tok={tok} ctx={ctx} />;
          case "strong":
            return (
              <strong data-from={tok.start} data-to={tok.end}>
                <InlineTokens tokens={tok.children} ctx={ctx} />
              </strong>
            );
          case "em":
            return (
              <em data-from={tok.start} data-to={tok.end}>
                <InlineTokens tokens={tok.children} ctx={ctx} />
              </em>
            );
          case "strike":
            return (
              <s data-from={tok.start} data-to={tok.end}>
                <InlineTokens tokens={tok.children} ctx={ctx} />
              </s>
            );
          case "highlight":
            return (
              <mark class="vr-highlight" data-from={tok.start} data-to={tok.end}>
                <InlineTokens tokens={tok.children} ctx={ctx} />
              </mark>
            );
          case "code":
            return (
              <code class="vr-inline-code" data-from={tok.start} data-to={tok.end}>
                {tok.code}
              </code>
            );
          case "math":
            return (
              <MathView
                tex={tok.tex}
                display={tok.display === true}
                from={tok.start}
                to={tok.end}
              />
            );
          case "checkbox":
            return (
              <input
                type="checkbox"
                class="vr-checkbox"
                disabled
                checked={tok.checked}
                data-from={tok.start}
                data-to={tok.end}
              />
            );
          default:
            return null;
        }
      })()}
    </>
  );
}

/** A run of inline tokens sharing one `RenderCtx.source`. */
export function InlineTokens(props: { tokens: Tok[]; ctx: RenderCtx }) {
  return <For each={props.tokens}>{(tok) => <InlineTokenView tok={tok} ctx={props.ctx} />}</For>;
}

/**
 * A paragraph's or quote's lines, with a `<br>` at each newline between them (B-224).
 * `classifyBlockContent` hands over one token array per line and no token for the newline itself —
 * only `tokenizeContent`'s flat stream carries `br` tokens — so rendering the arrays back to back
 * ran "first line" and "second line" together into "first linesecond line" in every outliner row.
 *
 * The `<br>` carries the newline's own offsets, like every other rendered node, so a click beside
 * it resolves to a caret offset (`../caret.ts`). They are read from `ctx.source` rather than from
 * the neighbouring tokens: an empty line has no tokens to measure from, and the source is the
 * string these lines were classified from (the invariant `text` tokens already slice by).
 */
function Lines(props: { lines: Tok[][]; ctx: RenderCtx; firstLine?: number }) {
  const breaks = createMemo(() => {
    const at: number[] = [];
    const source = props.ctx.source;
    for (let i = source.indexOf("\n"); i !== -1; i = source.indexOf("\n", i + 1)) at.push(i);
    return at;
  });
  // `firstLine`: a paragraph that is a part of prose-with-a-table starts mid-content.
  const breakAt = (i: number): number => breaks()[(props.firstLine ?? 0) + i - 1] ?? 0;
  return (
    <For each={props.lines}>
      {(line, i) => (
        <>
          <Show when={i() > 0}>
            <br data-from={breakAt(i())} data-to={breakAt(i()) + 1} />
          </Show>
          <InlineTokens tokens={line} ctx={props.ctx} />
        </>
      )}
    </For>
  );
}

function alignStyle(a: Align): string | undefined {
  return a ? `text-align: ${a}` : undefined;
}

/** A block's classified content (`classifyBlockContent`) -> HTML, per the rendering contract. */
export function BlockContentView(props: { content: BlockContent; ctx: RenderCtx }) {
  return (
    <>
      {(() => {
        const c = props.content;
        const ctx = props.ctx;
        switch (c.kind) {
          case "paragraph":
            return (
              <p class="vr-paragraph">
                <Lines lines={c.lines} ctx={ctx} firstLine={c.firstLine} />
              </p>
            );
          case "mixed":
            return (
              <For each={c.parts}>{(part) => <BlockContentView content={part} ctx={ctx} />}</For>
            );
          case "heading": {
            const level = c.level;
            return (
              <>
                <Show when={level === 1}>
                  <h1 class="vr-heading">
                    <InlineTokens tokens={c.title} ctx={ctx} />
                  </h1>
                </Show>
                <Show when={level === 2}>
                  <h2 class="vr-heading">
                    <InlineTokens tokens={c.title} ctx={ctx} />
                  </h2>
                </Show>
                <Show when={level === 3}>
                  <h3 class="vr-heading">
                    <InlineTokens tokens={c.title} ctx={ctx} />
                  </h3>
                </Show>
                <Show when={level === 4}>
                  <h4 class="vr-heading">
                    <InlineTokens tokens={c.title} ctx={ctx} />
                  </h4>
                </Show>
                <Show when={level === 5}>
                  <h5 class="vr-heading">
                    <InlineTokens tokens={c.title} ctx={ctx} />
                  </h5>
                </Show>
                <Show when={level === 6}>
                  <h6 class="vr-heading">
                    <InlineTokens tokens={c.title} ctx={ctx} />
                  </h6>
                </Show>
                <Show when={c.trailing}>
                  <For each={c.trailing}>
                    {(line) => (
                      <p class="vr-paragraph">
                        <InlineTokens tokens={line} ctx={ctx} />
                      </p>
                    )}
                  </For>
                </Show>
              </>
            );
          }
          case "fence": {
            if (c.lang === "query" && (ctx.refDepth ?? 0) === 0) {
              return <QueryFence code={c.code} ctx={ctx} />;
            }
            // A client plugin's renderer (mermaid, ADR 023) wins over syntax highlighting.
            const plugin = fenceRenderer(c.lang);
            if (plugin) return <PluginFence code={c.code} lang={c.lang} renderer={plugin} />;
            return <CodeFence code={c.code} lang={c.lang} ctx={ctx} />;
          }
          case "quote":
            return (
              <blockquote class="vr-quote">
                <Lines lines={c.lines} ctx={ctx} />
              </blockquote>
            );
          case "table":
            return (
              <table class="vr-table">
                <thead>
                  <tr>
                    <For each={c.header}>
                      {(cell, i) => (
                        <th style={alignStyle(c.align[i()] ?? null)}>
                          <InlineTokens tokens={cell} ctx={ctx} />
                        </th>
                      )}
                    </For>
                  </tr>
                </thead>
                <tbody>
                  <For each={c.rows}>
                    {(row) => (
                      <tr>
                        <For each={row}>
                          {(cell, i) => (
                            <td style={alignStyle(c.align[i()] ?? null)}>
                              <InlineTokens tokens={cell} ctx={ctx} />
                            </td>
                          )}
                        </For>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            );
          case "hr":
            return <hr class="vr-hr" />;
          default:
            return null;
        }
      })()}
    </>
  );
}
