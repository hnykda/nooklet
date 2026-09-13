/**
 * The math seam (markdown-grammar.md §4/§5: "KaTeX render of `tex`; plain `$tex$` text if no
 * renderer is loaded"), wired in M7. Facade in the main bundle; KaTeX, its stylesheet and its
 * fonts live in `./math-impl.ts` and load on the first `$…$` token rendered, so a page without
 * math pays nothing (docs/research/14 has the sizes).
 *
 * KaTeX over MathJax: synchronous rendering (the live-preview widget in `../livePreview.ts`
 * renders inside a CodeMirror decoration and cannot await), and a fraction of the size.
 */

interface KatexLike {
  renderToString(tex: string, options?: Record<string, unknown>): string;
}

let katex: KatexLike | undefined;
let loading: Promise<KatexLike> | undefined;

/** Resolves once KaTeX (and its CSS) is loaded; safe to call repeatedly. */
export function loadMath(): Promise<KatexLike> {
  if (!loading) {
    loading = import("./math-impl.js").then((m) => {
      katex = m.katex;
      return m.katex;
    });
    loading.catch(() => {
      // Let a later call retry after a failed chunk load (offline before the PWA cached it).
      loading = undefined;
    });
  }
  return loading;
}

export function isMathLoaded(): boolean {
  return katex !== undefined;
}

/** KaTeX HTML for `tex`, or `null` if KaTeX has not loaded yet (call `loadMath`). Errors render
 * as the source in KaTeX's own error colour rather than throwing — a half-typed formula is the
 * normal case in an editor. `trust: false` (the default, stated) keeps `\href`/`\url`/`\htmlClass`
 * inert, which is what makes `innerHTML` of the result safe.
 *
 * `maxSize` caps user-given sizes (`\rule`, `\raisebox`, `\hspace`) at 20em. KaTeX's default is
 * Infinity, and block text comes from sync, imports and agents: `\rule{99999em}{99999em}` painted a
 * 1.6-million-pixel box over the outline (docs/BUGS.md B-138). KaTeX does not apply it to `\kern`,
 * which only shifts content sideways; the row's and panels' own containment bound that. The cap is
 * the fix rather than `overflow` on `.vr-math-rendered`: clipping would not stop the box inflating
 * its row, and an inline-block with non-visible overflow sits on its bottom edge instead of the
 * text baseline (`tools/probes/inline-block-clip-baseline.mjs`: 11px off in Chromium and WebKit). */
export function renderTexSync(tex: string, displayMode = false): string | null {
  if (!katex) return null;
  return katex.renderToString(tex, {
    throwOnError: false,
    displayMode,
    trust: false,
    strict: "ignore",
    maxSize: 20,
  });
}

/** Test hook. */
export function _setMathForTests(impl: KatexLike | undefined): void {
  katex = impl;
  loading = impl ? Promise.resolve(impl) : undefined;
}
