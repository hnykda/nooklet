/**
 * Find & Replace (`/replace`; research/13 §4.2 item 4): a query, a replacement, literal-or-regex
 * and case toggles, a live preview of every block that would change, one "Replace all", and an
 * Undo for what it just did.
 *
 * The preview is not computed here: it is `graph.replace` with `dry_run: true`, so what this
 * page shows is exactly what the real run writes (ADR 020). The real run is one batch; Undo is
 * `batch.undo` with that batch id. After either write the local replica is pulled (`forceSync`)
 * so an open page reflects the change immediately.
 */
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  onCleanup,
  Show,
} from "solid-js";
import { type ReplaceInput, type ReplaceResult, refactorApi } from "../data/refactor-api.js";
import { forceSync } from "../db/client.js";
import "./find-replace.css";

const PREVIEW_LIMIT = 200;

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (/failed to fetch|networkerror|load failed/i.test(message))
    return "Could not reach the server.";
  return message;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The matcher the server uses, compiled here only to highlight the preview; `null` when the
 * pattern does not compile (the server's error says why). */
function previewMatcher(query: string, regex: boolean, caseSensitive: boolean): RegExp | null {
  try {
    // Same flags as the server's `compileQuery`, Unicode mode included (B-128), or the highlight
    // would disagree with the preview it decorates.
    return new RegExp(regex ? query : escapeRegExp(query), caseSensitive ? "gu" : "giu");
  } catch {
    return null;
  }
}

/** `text` split into plain and matched runs, for `<mark>`. */
function highlighted(text: string, re: RegExp | null): JSX.Element {
  if (!re) return text;
  const parts: JSX.Element[] = [];
  let last = 0;
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    if (m[0] === "") break;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(<mark>{m[0]}</mark>);
    last = start + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function sameFields(a: ReplaceInput, b: ReplaceInput): boolean {
  return (
    a.query === b.query &&
    a.replacement === b.replacement &&
    a.regex === b.regex &&
    a.caseSensitive === b.caseSensitive
  );
}

interface Outcome {
  batchId?: string;
  blocks: number;
  occurrences: number;
  undone: boolean;
}

export function FindReplaceView(): JSX.Element {
  const [query, setQuery] = createSignal("");
  const [replacement, setReplacement] = createSignal("");
  const [regex, setRegex] = createSignal(false);
  const [caseSensitive, setCaseSensitive] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [outcome, setOutcome] = createSignal<Outcome | undefined>();
  const [writeError, setWriteError] = createSignal<string | undefined>();

  // What the fields say right now. Replace all is built from THIS, never from the debounced copy
  // below: the debounce lags the last keystroke by 250 ms, and a click inside that window used to
  // write the replacement from before it — an empty string on the real graph, deleting all 19
  // matches while the field showed the new text (B-250).
  const fields = createMemo<ReplaceInput | undefined>(() => {
    const q = query();
    return q.trim() === ""
      ? undefined
      : {
          query: q,
          replacement: replacement(),
          regex: regex(),
          caseSensitive: caseSensitive(),
          dryRun: true,
          limit: PREVIEW_LIMIT,
        };
  });

  // The preview request, debounced: one call per pause in typing, not one per keystroke.
  const [input, setInput] = createSignal<ReplaceInput | undefined>();
  createEffect(() => {
    const next = fields();
    const t = setTimeout(() => setInput(next), 250);
    onCleanup(() => clearTimeout(t));
  });
  // The result carries the input it answers: a resource keeps showing its last value while the
  // next one loads, so without this the view cannot tell a preview of the current fields from a
  // preview of fields the user has since changed.
  const [preview, { refetch }] = createResource(input, async (i) => ({
    input: i,
    result: await refactorApi.replace(i),
  }));
  // Reading an errored resource re-throws (B-10/B-80's lesson); every read goes through this.
  const safePreview = (): ReplaceResult | undefined =>
    preview.error === undefined ? preview()?.result : undefined;
  /** The preview on screen was computed for exactly the current fields and is not being
   * recomputed — the only state in which Replace all writes what the page shows. */
  const previewIsCurrent = (): boolean => {
    const f = fields();
    const p = preview.error === undefined ? preview() : undefined;
    return f !== undefined && p !== undefined && !preview.loading && sameFields(p.input, f);
  };
  const matcher = createMemo(() => previewMatcher(query(), regex(), caseSensitive()));

  async function replaceAll(): Promise<void> {
    const i = fields();
    if (!i || busy() || !previewIsCurrent()) return;
    setBusy(true);
    setWriteError(undefined);
    try {
      await forceSync();
      const result = await refactorApi.replace({ ...i, dryRun: false });
      setOutcome({
        batchId: result.batchId,
        blocks: result.blocksMatched,
        occurrences: result.occurrences,
        undone: false,
      });
      await forceSync();
      void refetch();
    } catch (err) {
      setWriteError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function undo(): Promise<void> {
    const o = outcome();
    if (!o?.batchId || busy()) return;
    setBusy(true);
    setWriteError(undefined);
    try {
      await refactorApi.undoBatch(o.batchId);
      setOutcome({ ...o, undone: true });
      await forceSync();
      void refetch();
    } catch (err) {
      setWriteError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const canReplace = (): boolean => {
    const p = safePreview();
    return !busy() && previewIsCurrent() && p !== undefined && p.blocksMatched > 0;
  };

  return (
    <div class="replace-view">
      <h1 class="replace-title">Find and replace</h1>
      <div class="replace-form">
        <label class="replace-field">
          <span>Find</span>
          <input
            type="text"
            class="replace-query"
            placeholder={regex() ? "Regular expression…" : "Text to find…"}
            value={query()}
            autofocus
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setOutcome(undefined);
            }}
          />
        </label>
        <label class="replace-field">
          <span>Replace with</span>
          <input
            type="text"
            class="replace-replacement"
            placeholder={regex() ? "May use $1…" : "Replacement…"}
            value={replacement()}
            onInput={(e) => {
              setReplacement(e.currentTarget.value);
              setOutcome(undefined);
            }}
          />
        </label>
        <div class="replace-toggles">
          <label class="replace-toggle">
            <input
              type="checkbox"
              class="replace-regex"
              checked={regex()}
              onChange={(e) => setRegex(e.currentTarget.checked)}
            />
            Regular expression
          </label>
          <label class="replace-toggle">
            <input
              type="checkbox"
              class="replace-case"
              checked={caseSensitive()}
              onChange={(e) => setCaseSensitive(e.currentTarget.checked)}
            />
            Match case
          </label>
        </div>
        <div class="replace-actions">
          <button
            type="button"
            class="replace-all"
            disabled={!canReplace()}
            onClick={() => void replaceAll()}
          >
            Replace all
          </button>
          <Show when={outcome()?.batchId && !outcome()?.undone}>
            <button
              type="button"
              class="replace-undo"
              disabled={busy()}
              onClick={() => void undo()}
            >
              Undo
            </button>
          </Show>
        </div>
      </div>

      <Show when={outcome()}>
        {(o) => (
          <p class="replace-outcome" role="status">
            {o().undone
              ? `Undone: ${o().blocks} block${o().blocks === 1 ? "" : "s"} restored.`
              : `Replaced ${o().occurrences} occurrence${o().occurrences === 1 ? "" : "s"} in ${o().blocks} block${o().blocks === 1 ? "" : "s"}.`}
          </p>
        )}
      </Show>
      <Show when={writeError()}>
        {(e) => (
          <p class="replace-error" role="alert">
            {e()}
          </p>
        )}
      </Show>

      <Show when={input() === undefined}>
        <p class="replace-hint">
          Type to preview what would change. Nothing is written until Replace all.
        </p>
      </Show>
      <Show when={preview.loading && safePreview() === undefined && input() !== undefined}>
        <p class="replace-hint">Searching…</p>
      </Show>
      <Show when={!preview.loading && preview.error !== undefined}>
        <p class="replace-error" role="alert">
          {errorText(preview.error)}
        </p>
      </Show>
      <Show when={safePreview()}>
        {(p) => (
          <>
            <p class="replace-summary">
              {p().blocksMatched === 0
                ? "No matches."
                : `${p().occurrences} occurrence${p().occurrences === 1 ? "" : "s"} in ${p().blocksMatched} block${p().blocksMatched === 1 ? "" : "s"}${p().truncated ? ` (showing the first ${p().matches.length})` : ""}`}
            </p>
            <ul class="replace-results">
              <For each={p().matches}>
                {(m) => (
                  <li class="replace-result">
                    <div class="replace-result-page">
                      {m.page}
                      <span class="replace-result-count">
                        {m.count} match{m.count === 1 ? "" : "es"}
                      </span>
                    </div>
                    <div class="replace-before">{highlighted(m.before, matcher())}</div>
                    <div class="replace-after">{m.after}</div>
                  </li>
                )}
              </For>
            </ul>
          </>
        )}
      </Show>
    </div>
  );
}
