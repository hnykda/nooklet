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
 * inert, which is what makes `innerHTML` of the result safe. */
export function renderTexSync(tex: string, displayMode = false): string | null {
  if (!katex) return null;
  return katex.renderToString(tex, {
    throwOnError: false,
    displayMode,
    trust: false,
    strict: "ignore",
  });
}

/** Test hook. */
export function _setMathForTests(impl: KatexLike | undefined): void {
  katex = impl;
  loading = impl ? Promise.resolve(impl) : undefined;
}
